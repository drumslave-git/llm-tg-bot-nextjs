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
import { FEATURES } from "@/lib/features";
import { isDailyRunDue } from "@/server/jobs/daily-due";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
  type IntervalScheduler,
} from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { chatCompletion } from "@/server/llm/client";
import { embed } from "@/server/llm/embeddings";
import { publishEvent } from "@/server/realtime/hub";

import { runMemoryConsolidation, type ConsolidateDeps } from "./consolidate";
import { countPendingNotes } from "./service";

/**
 * In-process daily scheduler for memory consolidation — the same shape as the
 * history-summary and self-improvement jobs (the recorded background-job model):
 * a fixed-interval ticker that asks once a minute whether the configured local run
 * time has passed without a run, and if so folds the pending notes into durable
 * memory under a cross-process advisory lock.
 *
 * It runs at night because it is expensive (an LLM pass per person and per general
 * note) and nothing in *today's* conversation depends on it: a fact saved today was
 * said today, and today's conversation is already carried into every reply verbatim
 * by the 24-hour history window. Consolidation is what makes the fact outlive that
 * window. Idempotent: a consumed note is deleted, so a re-run costs nothing.
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
 * Resolve the real collaborators. Embeddings are optional: with no embedding model
 * configured the notes are still consolidated and still injected into replies, they
 * just are not semantically searchable — degraded, not failed.
 */
async function resolveDeps(): Promise<ConsolidateDeps | null> {
  const [llm, embedding] = await Promise.all([
    getLlmRuntime().catch(() => null),
    getEmbeddingRuntime().catch(() => null),
  ]);
  if (!llm) return null;
  const conn = { baseUrl: llm.baseUrl, apiKey: llm.apiKey };
  return {
    complete: (messages) => chatCompletion(conn, { model: llm.model, messages }),
    embed: embedding ? (texts) => embed(embedding, texts) : null,
  };
}

/** One consolidation run with the real collaborators, under the advisory lock. */
async function runJob(): Promise<string> {
  const deps = await resolveDeps();
  if (!deps) return "LLM not configured";

  const outcome = await withAdvisoryLock("memory", () => runMemoryConsolidation(deps));
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

/** One poll tick: run when forced, or when the daily wall-clock time is due. */
async function runTick(store: SchedulerStore): Promise<{ summary: string }> {
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

  const summary = await runJob();
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
        run: () => runTick(s as SchedulerStore),
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

/** Force a consolidation run as soon as possible (dashboard "Run now"). */
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
  const pendingNotes = await countPendingNotes(getDb()).catch(() => 0);

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
    embeddingsConfigured: embedding != null,
  };
}
