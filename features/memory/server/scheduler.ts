import "server-only";

import { getDb } from "@/db/drizzle";
import { computeNextRun } from "@/features/scheduled-tasks/schedule";
import {
  DEFAULT_DAILY_JOBS_RUN_TIME,
  getDailyJobsRunTime,
  getEmbeddingRuntime,
  getLlmRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import { currentSummaryDate } from "@/features/history/summary";
import { FEATURES } from "@/lib/features";
import { isDailyRunDue } from "@/server/jobs/daily-due";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
  type IntervalRunContext,
  type IntervalScheduler,
} from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { chatCompletion } from "@/server/llm/client";
import { embed } from "@/server/llm/embeddings";
import { publishEvent } from "@/server/realtime/hub";

import { runMemoryConsolidation, type ConsolidateDeps } from "./consolidate";
import { runMemoryExtraction, type ExtractDeps } from "./extract";
import { countDaysNeedingExtraction } from "./extraction-repository";
import { countPendingNotes } from "./service";

/**
 * In-process daily scheduler for memory — the same shape as the history-summary
 * and self-improvement jobs (the recorded background-job model): a fixed-interval
 * ticker that asks once a minute whether the configured local run time has passed
 * without a run, and if so does the night's memory work under a cross-process
 * advisory lock.
 *
 * The run is **two passes, in order**:
 *  1. *extraction* — read each finished chat-day out of the history mirror and
 *     queue the durable facts it revealed (`extract.ts`);
 *  2. *consolidation* — fold the whole pending queue into durable memory
 *     (`consolidate.ts`).
 *
 * Extraction runs first so a day's facts reach durable memory the **same** night
 * they are harvested, rather than sitting in the queue until the next one. The two
 * are one run, not two schedulers, because they are strictly sequential and share
 * the same lock: a consolidation racing the extraction that feeds it would just
 * leave half the night's notes for tomorrow.
 *
 * It all runs at night because it is expensive (an LLM pass per chat-day, per
 * person, and per general note) and nothing in *today's* conversation depends on
 * it: a fact said today is already carried into every reply verbatim by the
 * 24-hour history window. This is what makes the fact outlive that window.
 * Idempotent throughout: a consumed note is deleted and an unchanged day is
 * skipped, so a re-run costs nothing.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 60_000;

const FEATURE = FEATURES.memory;
const STORE_KEY = Symbol.for("llm-tg-bot.memory.scheduler");

interface SchedulerStore {
  scheduler: IntervalScheduler;
  /** When the last due-triggered daily run happened (in-memory, like the sibling jobs). */
  lastDailyRunAt: Date | null;
  /** Set by "Run now" — the next tick runs regardless of the clock. */
  forceNext: boolean;
  /** Outcome of the last *actual* run, kept apart from the ticker's "waiting" summaries. */
  lastResult: { at: string; summary: string } | null;
}

/**
 * Resolve the real collaborators for both passes. Embeddings are optional: with no
 * embedding model configured the notes are still extracted, consolidated, and
 * injected into replies, they just are not semantically searchable — degraded, not
 * failed.
 */
async function resolveDeps(): Promise<(ConsolidateDeps & ExtractDeps) | null> {
  const [llm, embedding, timeZone] = await Promise.all([
    getLlmRuntime().catch(() => null),
    getEmbeddingRuntime().catch(() => null),
    getTimezone().catch(() => "UTC"),
  ]);
  if (!llm) return null;
  const conn = { baseUrl: llm.baseUrl, apiKey: llm.apiKey };
  return {
    complete: (messages) => chatCompletion(conn, { model: llm.model, messages }),
    embed: embedding ? (texts) => embed(embedding, texts) : null,
    timeZone,
  };
}

/**
 * One night's memory run — extraction then consolidation — with the real
 * collaborators, under a single advisory lock held across both passes.
 *
 * Extraction failing does not skip consolidation: the queue may already hold notes
 * from the `memory_save` tool, and a dead extraction pass is no reason to leave
 * them pending another day. Its failure is recorded on its own trace and reported
 * in the summary.
 */
async function runJob(ctx?: IntervalRunContext): Promise<string> {
  const deps = await resolveDeps();
  if (!deps) return "LLM not configured";

  const outcome = await withAdvisoryLock("memory", async () => {
    let extracted: string;
    try {
      const extraction = await runMemoryExtraction({ ...deps, onProgress: ctx?.reportProgress });
      extracted = extraction.summary;
    } catch (err) {
      extracted = `extraction failed (${err instanceof Error ? err.message : String(err)})`;
    }
    const consolidation = await runMemoryConsolidation({
      ...deps,
      onProgress: ctx?.reportProgress,
    });
    return { summary: `${extracted}; ${consolidation.summary}` };
  });
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

/** One poll tick: run when forced, or when the daily wall-clock time is due. */
async function runTick(store: SchedulerStore, ctx?: IntervalRunContext): Promise<{ summary: string }> {
  const forced = store.forceNext;
  store.forceNext = false;

  if (!forced) {
    const [timezone, runTime] = await Promise.all([
      getTimezone().catch(() => "UTC"),
      getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
    ]);
    const now = new Date();
    if (
      !isDailyRunDue({
        timeOfDay: runTime,
        now,
        timeZone: timezone,
        lastRunAt: store.lastDailyRunAt,
      })
    ) {
      const next = computeNextRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);
      return { summary: `waiting${next ? ` (next run ${next.toISOString()})` : ""}` };
    }
    store.lastDailyRunAt = now;
  }

  const summary = await runJob(ctx);
  store.lastResult = { at: new Date().toISOString(), summary };
  return { summary };
}

function store(): SchedulerStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: SchedulerStore };
  if (!g[STORE_KEY]) {
    const s: SchedulerStore = {
      lastDailyRunAt: null,
      forceNext: false,
      lastResult: null,
      scheduler: createIntervalScheduler({
        name: "memory",
        tickMs: TICK_MS,
        onStatusChange: () => publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id }),
        run: (ctx) => runTick(s as SchedulerStore, ctx),
      }),
    };
    g[STORE_KEY] = s;
  }
  return g[STORE_KEY];
}

/** Start the daily poller (boot). Idempotent. */
export function startMemoryScheduler(): void {
  store().scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopMemoryScheduler(): void {
  store().scheduler.stop();
}

/**
 * Force tonight's memory run (extraction + consolidation) as soon as possible
 * (dashboard "Run now").
 */
export function runMemoryConsolidationNow(): Promise<void> {
  const s = store();
  s.forceNext = true;
  return s.scheduler.runNow();
}

/** Job info for the dashboard card. */
export interface MemoryJobInfo {
  status: IntervalJobStatus;
  /** ISO time of the next daily run, or null when the run time is invalid. */
  nextRunAt: string | null;
  /** Configured local run time (`HH:MM`) and the timezone it is read in. */
  runTime: string;
  timezone: string;
  /** Outcome of the last actual run, or null when it has never run. */
  lastResult: { at: string; summary: string } | null;
  /** Notes still waiting to be folded in — the visible backlog. */
  pendingNotes: number;
  /** Chat-days passive extraction has not read yet — the other half of the backlog. */
  pendingExtractionDays: number;
  /** Whether an embedding model is configured (i.e. memory search is semantic). */
  embeddingsConfigured: boolean;
}

/** Current job info — reads settings and counts the outstanding backlog. */
export async function getMemoryJobInfo(): Promise<MemoryJobInfo> {
  const s = store();
  const [timezone, runTime, embedding] = await Promise.all([
    getTimezone().catch(() => "UTC"),
    getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
    getEmbeddingRuntime().catch(() => null),
  ]);
  const now = new Date();
  const [pendingNotes, pendingExtractionDays] = await Promise.all([
    countPendingNotes(getDb()).catch(() => 0),
    countDaysNeedingExtraction(getDb(), {
      timeZone: timezone,
      today: currentSummaryDate(now, timezone),
    }).catch(() => 0),
  ]);

  const due = isDailyRunDue({
    timeOfDay: runTime,
    now,
    timeZone: timezone,
    lastRunAt: s.lastDailyRunAt,
  });
  // When today's run is still owed, the next instant is "now" (the next tick);
  // otherwise it is the next daily occurrence.
  const next = due
    ? now
    : computeNextRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);

  return {
    status: s.scheduler.getStatus(),
    nextRunAt: next ? next.toISOString() : null,
    runTime,
    timezone,
    lastResult: s.lastResult,
    pendingNotes,
    pendingExtractionDays,
    embeddingsConfigured: embedding != null,
  };
}
