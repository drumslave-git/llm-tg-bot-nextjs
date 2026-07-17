import "server-only";

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getEnv } from "@/server/env";
import type { Trace, TraceEvent, TraceStatus, TraceTrigger } from "@/lib/trace";

/**
 * File-backed trace store — the single backend behind the shared trace contract,
 * replacing the former Postgres tables. Traces live in memory while they are
 * mutable (`running`) and are written to disk exactly once, when they settle
 * (`success`/`error`/`skipped`). Because a written record is immutable, each
 * month's file is a plain append-only NDJSON log — one JSON `Trace` (header +
 * embedded events) per line — with no rewrite, fold, or compaction.
 *
 * A trace lives in exactly one of three places, unioned on read:
 *   1. `open`    — running, RAM only, never on disk (a crash drops it).
 *   2. `pending` — settled, not yet flushed (lost on hard crash; ≤ one flush
 *                  interval, and a graceful shutdown flushes first).
 *   3. months    — flushed to `traces-YYYY-MM.ndjson` and cached in `months`.
 *
 * Held on a `globalThis` singleton (like `server/realtime/hub.ts`) so the writer
 * (feature/route/poller bundles) and the boot-owned flush timer
 * (`instrumentation` → `register-node`) share one instance across Next bundles
 * and dev hot-reload. In-process only: this matches the single self-hosted
 * container model. Multiple replicas would need an external store behind this
 * same API.
 */

/** Flush period. A code constant, not a setting. */
const FLUSH_MS = 60_000;

const STORE_KEY = Symbol.for("llm-tg-bot.trace.store");

/** One correlation-id index entry — enough to rank newest and filter by feature. */
interface CorrelationEntry {
  id: string;
  feature: string;
  startedAt: string;
}

interface TraceStore {
  /** Running traces, still mutable. */
  open: Map<string, Trace>;
  /** Settled traces not yet written to disk. */
  pending: Map<string, Trace>;
  /** Flushed traces cached per `YYYY-MM`, mirroring the on-disk file. */
  months: Map<string, Trace[]>;
  /** Months whose file has been read into `months` (empty/missing files count as loaded). */
  loaded: Set<string>;
  /** Reverse index over all in-memory traces, for correlation lookups. */
  correlations: Map<string, CorrelationEntry[]>;
  /** Directory the month files live in, resolved once at creation. */
  dir: string;
  flushTimer: ReturnType<typeof setInterval> | null;
  /** Re-entry guard: a slow flush is never overlapped by the timer. */
  flushing: boolean;
}

/** Traces directory: `TRACES_DIR` (bootstrap plumbing) or a dev default under gitignored `data/`. */
function resolveDir(): string {
  return getEnv().TRACES_DIR ?? path.join(process.cwd(), "data", "traces");
}

function store(): TraceStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: TraceStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = {
      open: new Map(),
      pending: new Map(),
      months: new Map(),
      loaded: new Set(),
      correlations: new Map(),
      dir: resolveDir(),
      flushTimer: null,
      flushing: false,
    };
  }
  return g[STORE_KEY]!;
}

/** The `YYYY-MM` bucket a trace belongs to, keyed off its (UTC) start instant. */
function monthKeyOf(startedAt: string): string {
  return startedAt.slice(0, 7);
}

function fileFor(s: TraceStore, monthKey: string): string {
  return path.join(s.dir, `traces-${monthKey}.ndjson`);
}

const MONTH_FILE_RE = /^traces-(\d{4}-\d{2})\.ndjson$/;

/** Index a trace under its correlation id (if any), newest-first, de-duplicated by id. */
function indexCorrelation(s: TraceStore, trace: Trace): void {
  const corr = trace.trigger.correlationId;
  if (!corr) return;
  const list = s.correlations.get(corr) ?? [];
  if (list.some((e) => e.id === trace.id)) return;
  list.push({ id: trace.id, feature: trace.feature, startedAt: trace.startedAt });
  s.correlations.set(corr, list);
}

/** Move a trace's correlation index entry when it settles with a new correlation id. */
function reindexCorrelation(s: TraceStore, trace: Trace, nextCorr: string): void {
  const prev = trace.trigger.correlationId;
  if (prev === nextCorr) return;
  if (prev) {
    const list = s.correlations.get(prev);
    if (list) {
      const rest = list.filter((e) => e.id !== trace.id);
      if (rest.length) s.correlations.set(prev, rest);
      else s.correlations.delete(prev);
    }
  }
  trace.trigger.correlationId = nextCorr;
  indexCorrelation(s, trace);
}

/** Parse one NDJSON month file into the cache, tolerating a torn final line from a crash. */
async function ensureMonthLoaded(s: TraceStore, monthKey: string): Promise<void> {
  if (s.loaded.has(monthKey)) return;
  let text: string;
  try {
    text = await readFile(fileFor(s, monthKey), "utf8");
  } catch {
    // Missing file — nothing flushed for this month yet.
    s.months.set(monthKey, []);
    s.loaded.add(monthKey);
    return;
  }
  const traces: Trace[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const trace = JSON.parse(trimmed) as Trace;
      traces.push(trace);
      indexCorrelation(s, trace);
    } catch {
      // Skip a corrupt/partial line rather than fail the whole read.
    }
  }
  s.months.set(monthKey, traces);
  s.loaded.add(monthKey);
}

/** Load every month file present on disk. The Debug reads (list/detail/bundle) are full-history. */
async function ensureAllLoaded(s: TraceStore): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(s.dir);
  } catch {
    return; // Directory not created yet — nothing flushed.
  }
  for (const name of entries) {
    const match = MONTH_FILE_RE.exec(name);
    if (match) await ensureMonthLoaded(s, match[1]);
  }
}

/** Every flushed trace currently cached, across all loaded months. */
function flushedTraces(s: TraceStore): Trace[] {
  const out: Trace[] = [];
  for (const list of s.months.values()) out.push(...list);
  return out;
}

/** Header copy (events dropped) for list views. */
function toHeader(trace: Trace): Trace {
  return { ...trace, events: [] };
}

// --- Write ops (called by the recorder) --------------------------------------

export interface CreateTraceInput {
  id: string;
  feature: string;
  action: string;
  trigger: TraceTrigger;
  startedAt: string;
  inputSummary?: string;
}

/** Open a new running trace in memory. */
export function createTrace(input: CreateTraceInput): void {
  const s = store();
  const trace: Trace = {
    id: input.id,
    feature: input.feature,
    action: input.action,
    status: "running",
    trigger: { ...input.trigger },
    startedAt: input.startedAt,
    finishedAt: null,
    inputSummary: input.inputSummary,
    error: null,
    events: [],
  };
  s.open.set(trace.id, trace);
  indexCorrelation(s, trace);
}

/** Append an ordered event to an open trace. */
export function appendTraceEvent(traceId: string, event: TraceEvent): void {
  const trace = store().open.get(traceId);
  if (trace) trace.events.push(event);
}

export interface SettleTraceInput {
  status: Extract<TraceStatus, "success" | "error" | "skipped">;
  finishedAt: string;
  outputSummary?: string;
  error?: Trace["error"];
  relatedIds?: Record<string, string[]>;
  /** Replaces the correlation the trace opened with; see `recorder.ts`. */
  correlationId?: string;
}

/** Settle an open trace and move it to the pending-flush buffer. */
export function settleTrace(traceId: string, input: SettleTraceInput): void {
  const s = store();
  const trace = s.open.get(traceId);
  if (!trace) return;
  trace.status = input.status;
  trace.finishedAt = input.finishedAt;
  trace.error = input.error ?? null;
  if (input.outputSummary !== undefined) trace.outputSummary = input.outputSummary;
  if (input.relatedIds !== undefined) trace.relatedIds = input.relatedIds;
  if (input.correlationId !== undefined) reindexCorrelation(s, trace, input.correlationId);
  s.open.delete(traceId);
  s.pending.set(traceId, trace);
}

// --- Flush + lifecycle -------------------------------------------------------

/**
 * Append every pending (settled) trace to its month file and mirror it into the
 * month cache. Grouped by the trace's start month, so a trace that settles after
 * midnight on the 1st still lands in the previous month's file. A group whose
 * write fails stays pending and is retried next tick.
 */
export async function flushTracesNow(): Promise<void> {
  const s = store();
  if (s.flushing) return;
  if (s.pending.size === 0) return;
  s.flushing = true;
  try {
    const byMonth = new Map<string, Trace[]>();
    for (const trace of s.pending.values()) {
      const key = monthKeyOf(trace.startedAt);
      const group = byMonth.get(key);
      if (group) group.push(trace);
      else byMonth.set(key, [trace]);
    }

    await mkdir(s.dir, { recursive: true });
    for (const [monthKey, traces] of byMonth) {
      // Load the month first so the cache stays complete before we append to it.
      await ensureMonthLoaded(s, monthKey);
      const data = traces.map((t) => JSON.stringify(t)).join("\n") + "\n";
      try {
        await appendFile(fileFor(s, monthKey), data);
      } catch (err) {
        console.error(`Trace flush failed for ${monthKey}:`, err);
        continue; // Leave this group pending; retry next tick.
      }
      s.months.get(monthKey)!.push(...traces);
      for (const trace of traces) s.pending.delete(trace.id);
    }
  } finally {
    s.flushing = false;
  }
}

/** Arm the periodic flush and warm the current month. Idempotent (boot / HMR). */
export async function startTraceStore(): Promise<void> {
  const s = store();
  await ensureMonthLoaded(s, monthKeyOf(new Date().toISOString())).catch(() => undefined);
  if (s.flushTimer) return;
  const timer = setInterval(() => void flushTracesNow(), FLUSH_MS);
  if (typeof timer.unref === "function") timer.unref();
  s.flushTimer = timer;
}

/** Stop the flush timer after a final flush (graceful shutdown). */
export async function stopTraceStore(): Promise<void> {
  const s = store();
  if (s.flushTimer) {
    clearInterval(s.flushTimer);
    s.flushTimer = null;
  }
  await flushTracesNow();
}

/** Test-only: clear the singleton so a fresh temp `TRACES_DIR` takes effect. */
export function __resetTraceStoreForTests(): void {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: TraceStore };
  const existing = g[STORE_KEY];
  if (existing?.flushTimer) clearInterval(existing.flushTimer);
  delete g[STORE_KEY];
}

// --- Query ops (replacing the former Drizzle repository) ---------------------

/** Full trace with ordered events, or null if unknown. Full-history read. */
export async function getTrace(id: string): Promise<Trace | null> {
  const s = store();
  const live = s.open.get(id) ?? s.pending.get(id);
  if (live) return live;
  await ensureAllLoaded(s);
  return flushedTraces(s).find((t) => t.id === id) ?? null;
}

export interface ListTracesInput {
  feature?: string;
  status?: TraceStatus;
  limit?: number;
  offset?: number;
}

export interface ListTracesResult {
  /** Trace headers, newest first. Events are omitted for list performance. */
  traces: Trace[];
  total: number;
}

/** List trace headers (without events), newest first, with total count. Full-history read. */
export async function listTraces(input: ListTracesInput = {}): Promise<ListTracesResult> {
  const s = store();
  await ensureAllLoaded(s);
  let all = [...s.open.values(), ...s.pending.values(), ...flushedTraces(s)];
  if (input.feature) all = all.filter((t) => t.feature === input.feature);
  if (input.status) all = all.filter((t) => t.status === input.status);
  all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const total = all.length;
  const offset = Math.max(input.offset ?? 0, 0);
  const page = input.limit !== undefined ? all.slice(offset, offset + Math.max(input.limit, 1)) : all;
  return { traces: page.map(toHeader), total };
}

/** Distinct feature names that have recorded traces, alphabetically. Full-history read. */
export async function listFeatures(): Promise<string[]> {
  const s = store();
  await ensureAllLoaded(s);
  const names = new Set<string>();
  for (const t of s.open.values()) names.add(t.feature);
  for (const t of s.pending.values()) names.add(t.feature);
  for (const t of flushedTraces(s)) names.add(t.feature);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Ordered events for many traces, grouped by trace id (bundle export). Full-history read. */
export async function getEventsForTraces(ids: string[]): Promise<Map<string, TraceEvent[]>> {
  const grouped = new Map<string, TraceEvent[]>();
  if (ids.length === 0) return grouped;
  const wanted = new Set(ids);
  const s = store();
  await ensureAllLoaded(s);
  const all = [...s.open.values(), ...s.pending.values(), ...flushedTraces(s)];
  for (const trace of all) {
    if (wanted.has(trace.id)) grouped.set(trace.id, trace.events);
  }
  return grouped;
}

/**
 * Latest trace id for each correlation id, newest per id. Served from the
 * in-memory correlation index (fast — the reply/history hot path), covering all
 * currently-loaded traces (current month is warmed at boot; visiting Debug loads
 * the rest). A correlation for a very old, unloaded message resolves to nothing,
 * which callers tolerate (`traceId` is optional → no drill-down link).
 *
 * Pass `features` to pick a *particular* kind of action when several features key
 * a trace on the same message.
 */
export async function getLatestTraceIdsByCorrelation(
  correlationIds: string[],
  options: { features?: string[] } = {},
): Promise<Map<string, string>> {
  const s = store();
  const result = new Map<string, string>();
  const unique = [...new Set(correlationIds.filter(Boolean))];
  const featureFilter = options.features?.length ? new Set(options.features) : null;

  for (const corr of unique) {
    const entries = s.correlations.get(corr);
    if (!entries?.length) continue;
    const candidates = featureFilter
      ? entries.filter((e) => featureFilter.has(e.feature))
      : entries;
    if (!candidates.length) continue;
    // Newest wins; on an equal start instant the later-recorded entry wins (the
    // index is in creation order), so the tie-break is deterministic.
    const newest = candidates.reduce((a, b) =>
      b.startedAt.localeCompare(a.startedAt) >= 0 ? b : a,
    );
    result.set(corr, newest.id);
  }
  return result;
}
