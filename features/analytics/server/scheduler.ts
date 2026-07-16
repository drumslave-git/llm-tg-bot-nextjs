import "server-only";

import { getDb } from "@/db/drizzle";
import { computeNextRun, zonedDate } from "@/features/scheduled-tasks/schedule";
import {
  DEFAULT_DAILY_JOBS_RUN_TIME,
  getDailyJobsRunTime,
  getLlmRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { isDailyRunDue } from "@/server/jobs/daily-due";
import {
  createIntervalScheduler,
  type IntervalRunContext,
  type IntervalScheduler,
} from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { chatCompletion } from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";

import type { AnalyticsJobInfo } from "../types";
import { runAnalyticsInsights } from "./insights";
import { countDaysNeedingInsight } from "./repository";

/**
 * In-process daily scheduler for the analytics insight job — the same shape as the
 * memory/summary/self-improvement jobs (the recorded background-job model): a
 * fixed-interval ticker that runs at the configured local time under the shared
 * cross-process advisory lock.
 *
 * It runs at night because it is expensive (an LLM pass per finished chat-day and
 * per touched period) and nothing live depends on it — the numeric charts are
 * computed live from the base tables, so only the mood/word/topic cards wait for
 * this. Idempotent: an unchanged day/period is skipped, so a re-run costs nothing.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 60_000;

const FEATURE = FEATURES["analytics-insights"];
const STORE_KEY = Symbol.for("llm-tg-bot.analytics.scheduler");

interface SchedulerStore {
  scheduler: IntervalScheduler;
  lastDailyRunAt: Date | null;
  forceNext: boolean;
  lastResult: { at: string; summary: string } | null;
}

/** One insight run with the real collaborators, under the advisory lock. */
async function runJob(ctx?: IntervalRunContext): Promise<string> {
  const llm = await getLlmRuntime().catch(() => null);
  if (!llm) return "LLM not configured";
  const timeZone = await getTimezone().catch(() => "UTC");
  const conn = { baseUrl: llm.baseUrl, apiKey: llm.apiKey };

  const outcome = await withAdvisoryLock("analytics", () =>
    runAnalyticsInsights({
      complete: (messages) => chatCompletion(conn, { model: llm.model, messages }),
      timeZone,
      onProgress: ctx?.reportProgress,
    }),
  );
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
      !isDailyRunDue({ timeOfDay: runTime, now, timeZone: timezone, lastRunAt: store.lastDailyRunAt })
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
        name: "analytics",
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
export function startAnalyticsScheduler(): void {
  store().scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopAnalyticsScheduler(): void {
  store().scheduler.stop();
}

/** Force an insight run as soon as possible (dashboard "Run now"). */
export function runAnalyticsInsightsNow(): Promise<void> {
  const s = store();
  s.forceNext = true;
  return s.scheduler.runNow();
}

/** Current job info — reads settings and counts the outstanding backlog. */
export async function getAnalyticsJobInfo(): Promise<AnalyticsJobInfo> {
  const s = store();
  const [timezone, runTime, llm] = await Promise.all([
    getTimezone().catch(() => "UTC"),
    getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
    getLlmRuntime().catch(() => null),
  ]);
  const now = new Date();
  const zoned = zonedDate(now, timezone);
  const today = `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
  const pendingDays = await countDaysNeedingInsight(getDb(), { timeZone: timezone, today }).catch(() => 0);

  const due = isDailyRunDue({ timeOfDay: runTime, now, timeZone: timezone, lastRunAt: s.lastDailyRunAt });
  const next = due ? now : computeNextRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);

  return {
    status: s.scheduler.getStatus(),
    nextRunAt: next ? next.toISOString() : null,
    runTime,
    timezone,
    lastResult: s.lastResult,
    pendingDays,
    llmConfigured: llm != null,
  };
}
