import "server-only";

import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { computeNextRun, parseTimeOfDay, zonedDate, zonedWallClockToUtc } from "@/features/scheduled-tasks/schedule";
import {
  getLlmRuntime,
  getSelfImprovementRunTime,
  getTimezone,
} from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { chatCompletion } from "@/server/llm/client";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
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
 * time (`settings.self_improvement_run_time`, in the operator timezone) has been
 * reached today and the job has not run since; when due it incorporates the
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

/**
 * Today's run instant (UTC) for a local `HH:MM` in `timeZone`, or null for an
 * unparseable time. Exported for the due-math unit tests.
 */
export function todaysRunInstant(timeOfDay: string, now: Date, timeZone: string): Date | null {
  const time = parseTimeOfDay(timeOfDay);
  if (!time) return null;
  const today = zonedDate(now, timeZone);
  return zonedWallClockToUtc(today.year, today.month, today.day, time.hour, time.minute, timeZone);
}

/**
 * Whether the daily run is due: today's run instant has passed and no run has
 * happened at/after it. Exported for the due-math unit tests.
 */
export function isDailyRunDue(input: {
  timeOfDay: string;
  now: Date;
  timeZone: string;
  lastRunAt: Date | null;
}): boolean {
  const target = todaysRunInstant(input.timeOfDay, input.now, input.timeZone);
  if (!target) return false;
  if (input.now.getTime() < target.getTime()) return false;
  return input.lastRunAt === null || input.lastRunAt.getTime() < target.getTime();
}

/** One incorporation run with the real collaborators, under the advisory lock. */
async function runIncorporation(): Promise<string> {
  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return "LLM not configured";
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };

  const outcome = await withAdvisoryLock("self-improvement", async () => {
    const personalityPrompt = await getActivePersonalityPrompt().catch(() => null);
    return runSelfImprovement({
      complete: (messages) => chatCompletion(conn, { model: runtime.model, messages }),
      personalityPrompt,
      model: runtime.model,
    });
  });
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

/** One poll tick: run when forced or when the daily wall-clock time is due. */
async function runTick(store: SchedulerStore): Promise<{ summary: string }> {
  const forced = store.forceNext;
  store.forceNext = false;

  if (!forced) {
    const [timezone, runTime] = await Promise.all([
      getTimezone().catch(() => "UTC"),
      getSelfImprovementRunTime().catch(() => "04:00"),
    ]);
    const now = new Date();
    if (!isDailyRunDue({ timeOfDay: runTime, now, timeZone: timezone, lastRunAt: store.lastDailyRunAt })) {
      const next = computeNextRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);
      return { summary: `waiting${next ? ` (next run ${next.toISOString()})` : ""}` };
    }
    store.lastDailyRunAt = now;
  }

  const summary = await runIncorporation();
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
        run: () => runTick(s as SchedulerStore),
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
    getSelfImprovementRunTime().catch(() => "04:00"),
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
