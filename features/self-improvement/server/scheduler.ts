import "server-only";

import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { computeNextRun } from "@/features/scheduled-tasks/schedule";
import {
  DEFAULT_DAILY_JOBS_RUN_TIME,
  getDailyJobsRunTime,
  getLlmRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { chatCompletion } from "@/server/llm/client";
import { isDailyRunDue } from "@/server/jobs/daily-due";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
  type IntervalRunContext,
  type IntervalScheduler,
} from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { publishEvent } from "@/server/realtime/hub";

import { runSelfImprovement } from "./analyze";

/**
 * In-process daily scheduler for the self-improvement incorporation job, owned
 * by a single `globalThis` singleton (like the scheduled-tasks poller) so there
 * is exactly one per process and it survives HMR.
 *
 * A fixed-interval ticker checks once a minute whether the configured local run
 * time (`settings.daily_jobs_run_time` — shared by every daily job, in the
 * operator timezone) has been reached today and the job has not run since; when
 * due it incorporates the
 * feedback backlog under a cross-process advisory lock. The run is idempotent
 * (an empty backlog is a no-op), so an extra trigger after a restart is
 * harmless. The dashboard's "Run now" forces a run regardless of the clock.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 60_000;

const FEATURE = FEATURES["self-improvement"];
const STORE_KEY = Symbol.for("llm-tg-bot.self-improvement.scheduler");

interface SchedulerStore {
  scheduler: IntervalScheduler;
  /** When the last due-triggered daily run happened (in-memory; see note above). */
  lastDailyRunAt: Date | null;
  /** Set by "Run now" — the next tick runs regardless of the clock. */
  forceNext: boolean;
  /**
   * Outcome of the last *actual* incorporation run. Kept separately from the
   * ticker's `lastSummary`, which the per-minute "waiting" ticks overwrite.
   */
  lastResult: { at: string; summary: string } | null;
}

/** One incorporation run with the real collaborators, under the advisory lock. */
async function runIncorporation(ctx?: IntervalRunContext): Promise<string> {
  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return "LLM not configured";
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };

  const outcome = await withAdvisoryLock("self-improvement", async () => {
    const personalityPrompt = await getActivePersonalityPrompt().catch(() => null);
    return runSelfImprovement({
      complete: (messages) => chatCompletion(conn, { model: runtime.model, messages }),
      personalityPrompt,
      model: runtime.model,
      onProgress: ctx?.reportProgress,
    });
  });
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

/** One poll tick: run when forced or when the daily wall-clock time is due. */
async function runTick(store: SchedulerStore, ctx?: IntervalRunContext): Promise<{ summary: string }> {
  const forced = store.forceNext;
  store.forceNext = false;

  if (!forced) {
    const [timezone, runTime] = await Promise.all([
      getTimezone().catch(() => "UTC"),
      getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
    ]);
    const now = new Date();
    if (!isDailyRunDue({ timeOfDay: runTime, now, timeZone: timezone, lastRunAt: store.lastDailyRunAt })) {
      const next = computeNextRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);
      return { summary: `waiting${next ? ` (next run ${next.toISOString()})` : ""}` };
    }
    store.lastDailyRunAt = now;
  }

  const summary = await runIncorporation(ctx);
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
        name: "self-improvement",
        tickMs: TICK_MS,
        onStatusChange: () => publishEvent(FEATURE.realtimeTopic),
        run: (ctx) => runTick(s as SchedulerStore, ctx),
      }),
    };
    g[STORE_KEY] = s;
  }
  return g[STORE_KEY];
}

/** Start the daily poller (boot). Idempotent. */
export function startSelfImprovementScheduler(): void {
  store().scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopSelfImprovementScheduler(): void {
  store().scheduler.stop();
}

/** Force an incorporation run as soon as possible (dashboard "Run now"). */
export function runSelfImprovementNow(): Promise<void> {
  const s = store();
  s.forceNext = true;
  return s.scheduler.runNow();
}

/** Job info for the dashboard card: ticker status + the next scheduled instant. */
export interface SelfImprovementJobInfo {
  status: IntervalJobStatus;
  /** ISO time of the next daily run, or null when the run time is invalid. */
  nextRunAt: string | null;
  /** Configured local run time (`HH:MM`) and timezone, for display. */
  runTime: string;
  timezone: string;
  /** Outcome of the last actual incorporation run, or null when it never ran. */
  lastResult: { at: string; summary: string } | null;
}

/** Current job info — reads settings for the next-run computation. */
export async function getSelfImprovementJobInfo(): Promise<SelfImprovementJobInfo> {
  const s = store();
  const [timezone, runTime] = await Promise.all([
    getTimezone().catch(() => "UTC"),
    getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
  ]);
  const now = new Date();
  const due = isDailyRunDue({ timeOfDay: runTime, now, timeZone: timezone, lastRunAt: s.lastDailyRunAt });
  // When today's run is still owed, the next instant is "now" (the next tick);
  // otherwise the next daily occurrence.
  const next = due
    ? now
    : computeNextRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);
  return {
    status: s.scheduler.getStatus(),
    nextRunAt: next ? next.toISOString() : null,
    runTime,
    timezone,
    lastResult: s.lastResult,
  };
}
