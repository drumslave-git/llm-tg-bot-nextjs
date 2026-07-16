import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { normalizeModelName } from "@/features/self-improvement/model-name";
import { zonedDate } from "@/features/scheduled-tasks/schedule";
import { FEATURES } from "@/lib/features";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import type { JobProgress } from "@/server/jobs/progress";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { moodLabelForScore } from "../mood";
import { weekBucketOf } from "../period";
import type { Granularity } from "../types";
import {
  buildDayInsightRequest,
  buildPeriodInsightRequest,
  DAY_INSIGHT_PROMPT,
  formatTranscript,
  parseDayInsight,
  parsePeriodInsight,
  PERIOD_INSIGHT_PROMPT,
} from "./prompt";
import {
  getDayMessages,
  getDaySummaryTopics,
  listAllInsightDays,
  listDayInsightsForPeriod,
  listDaysNeedingInsight,
  listExistingPeriodKeys,
  type PeriodDayRow,
  upsertChatDayInsight,
  upsertPeriodInsight,
} from "./repository";

/**
 * The nightly analytics insight job. It scores each finished chat-day's mood, top
 * topic, and word (one LLM call, self-healing), then rolls those day rows up into
 * a **word of the period + top topic + aggregate mood for every period the day
 * touches** — the day, its week, its month, and all-time — for both the global and
 * the per-chat view. That is what makes "word of the day/week/month/all time" and
 * "most-discussed topic" available at every granularity the selector offers.
 *
 * A roll-up over a single day row copies that row's word/topic (no LLM); a roll-up
 * over several days makes one LLM call. Mood is always a deterministic
 * message-weighted average, so it never depends on a fragile parse.
 *
 * Fails **closed** per unit: an unusable model response leaves the stored row
 * untouched. Idempotent: an unchanged day/period is skipped, costing no tokens.
 */

const FEATURE = FEATURES["analytics-insights"];

/** Safety valves on one run (not business rules) — bound a runaway backlog. */
const MAX_DAYS_PER_RUN = 200;
const MAX_PERIODS_PER_RUN = 400;

export interface AnalyticsInsightsDeps {
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  timeZone: string;
  now?: Date;
  /** Publish live per-day / per-period progress (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  db?: DrizzleDb;
}

export interface AnalyticsInsightsResult {
  daysComputed: number;
  daysFailed: number;
  periodsComputed: number;
  periodsFailed: number;
  summary: string;
}

const EMPTY: Omit<AnalyticsInsightsResult, "summary"> = {
  daysComputed: 0,
  daysFailed: 0,
  periodsComputed: 0,
  periodsFailed: 0,
};

interface PeriodTarget {
  granularity: Granularity;
  bucket: string;
  scope: "global" | "chat";
  chatId: string;
}

function targetKey(t: PeriodTarget): string {
  return `${t.granularity}|${t.bucket}|${t.scope}|${t.chatId}`;
}

/** Every period bucket a (date, chat) touches — day/week/month/all × global/chat. */
function periodsForDay(date: string, chatId: string): PeriodTarget[] {
  const [year, month] = date.split("-");
  const buckets: [Granularity, string][] = [
    ["day", date],
    ["week", weekBucketOf(date)],
    ["month", `${year}-${month}`],
    ["all", "all"],
  ];
  const out: PeriodTarget[] = [];
  for (const [granularity, bucket] of buckets) {
    out.push({ granularity, bucket, scope: "global", chatId: "" });
    out.push({ granularity, bucket, scope: "chat", chatId });
  }
  return out;
}

/** Message-weighted mean mood across a period's day rows. */
function weightedMood(days: { moodScore: number; messageCount: number }[]): number {
  const totalMsgs = days.reduce((a, d) => a + d.messageCount, 0);
  if (totalMsgs === 0) return 50;
  return Math.round(days.reduce((a, d) => a + d.moodScore * d.messageCount, 0) / totalMsgs);
}

export async function runAnalyticsInsights(
  deps: AnalyticsInsightsDeps,
): Promise<AnalyticsInsightsResult> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const zoned = zonedDate(now, deps.timeZone);
  const today = `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;

  const pending = await listDaysNeedingInsight(db, {
    timeZone: deps.timeZone,
    today,
    limit: MAX_DAYS_PER_RUN,
  });

  // Self-heal: any period a scored day *should* have but doesn't (e.g. a new
  // granularity was added after the day was first scored) is backfilled, so the
  // roll-up never depends on a day being re-scored in the same run.
  const [allDays, existingKeys] = await Promise.all([
    listAllInsightDays(db),
    listExistingPeriodKeys(db),
  ]);
  const missing = new Map<string, PeriodTarget>();
  for (const d of allDays) {
    for (const t of periodsForDay(d.insightDate, d.chatId)) {
      const key = targetKey(t);
      if (!existingKeys.has(key)) missing.set(key, t);
    }
  }

  if (pending.length === 0 && missing.size === 0) {
    return { ...EMPTY, summary: "nothing to compute" };
  }

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "insights",
      trigger: { kind: "system", actor: "analytics" },
      inputSummary: `${pending.length} day(s) pending, ${missing.size} period(s) to backfill`,
    },
    db,
  );

  const result = { ...EMPTY };

  /** One LLM pass, fully traced. Null on failure. */
  async function complete(system: string, userContent: string): Promise<{ content: string; model: string } | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];
    await trace.event({ type: "llm_request", message: "request", data: { messages } });
    try {
      const completion = await deps.complete(messages);
      await trace.event({
        type: "llm_response",
        message: "response",
        data: completion.responseBody ?? { content: completion.content },
        usage: {
          model: completion.model,
          promptTokens: completion.usage?.promptTokens,
          completionTokens: completion.usage?.completionTokens,
          totalTokens: completion.usage?.totalTokens,
          latencyMs: completion.latencyMs,
        },
      });
      return { content: completion.content, model: normalizeModelName(completion.model) };
    } catch (err) {
      await trace.event({
        type: "error",
        level: "warn",
        message: "LLM pass failed — left for the next run",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  try {
    // Seed with the missing periods to backfill; Pass 1 adds the periods of any
    // freshly-scored day.
    const touched = new Map<string, PeriodTarget>(missing);

    /* Pass 1 — score each pending (chat, day). */
    let dayIdx = 0;
    for (const day of pending) {
      deps.onProgress?.({
        step: `Scoring day ${day.insightDate}`,
        current: ++dayIdx,
        total: pending.length,
      });
      const [messages, topics] = await Promise.all([
        getDayMessages(db, { chatId: day.chatId, date: day.insightDate, timeZone: deps.timeZone }),
        getDaySummaryTopics(db, { chatId: day.chatId, date: day.insightDate }),
      ]);
      const transcript = formatTranscript(messages);
      if (!transcript) {
        await upsertChatDayInsight(db, {
          chatId: day.chatId,
          insightDate: day.insightDate,
          moodScore: 50,
          moodLabel: moodLabelForScore(50),
          moodSummary: "No readable text this day.",
          topTopic: "—",
          word: "—",
          messageCount: day.messageCount,
          model: "n/a",
        });
        result.daysComputed += 1;
        for (const t of periodsForDay(day.insightDate, day.chatId)) touched.set(targetKey(t), t);
        continue;
      }

      const out = await complete(DAY_INSIGHT_PROMPT, buildDayInsightRequest({ transcript, topics }));
      if (!out) {
        result.daysFailed += 1;
        continue;
      }
      const parsed = parseDayInsight(out.content);
      if (!parsed) {
        result.daysFailed += 1;
        await trace.event({
          type: "step",
          level: "warn",
          message: "unusable day insight — left for the next run",
          data: { chatId: day.chatId, date: day.insightDate, content: out.content },
        });
        continue;
      }

      await upsertChatDayInsight(db, {
        chatId: day.chatId,
        insightDate: day.insightDate,
        moodScore: parsed.moodScore,
        moodLabel: parsed.moodLabel,
        moodSummary: parsed.moodSummary,
        topTopic: parsed.topTopic,
        word: parsed.word,
        messageCount: day.messageCount,
        model: out.model,
      });
      result.daysComputed += 1;
      for (const t of periodsForDay(day.insightDate, day.chatId)) touched.set(targetKey(t), t);

      await trace.event({
        type: "step",
        level: "success",
        message: `day scored: ${day.chatId} ${day.insightDate}`,
        data: { ...parsed, messageCount: day.messageCount },
      });
    }

    /* Pass 2 — roll up every touched period. */
    const targets = [...touched.values()].slice(0, MAX_PERIODS_PER_RUN);
    let periodIdx = 0;
    for (const target of targets) {
      deps.onProgress?.({
        step: `Rolling up ${target.granularity} ${target.bucket}`,
        current: ++periodIdx,
        total: targets.length,
      });
      const days = await listDayInsightsForPeriod(db, {
        granularity: target.granularity,
        bucket: target.bucket,
        chatId: target.scope === "chat" ? target.chatId : null,
      });
      if (days.length === 0) continue;

      const moodScore = weightedMood(days);
      const messageCount = days.reduce((a, d) => a + d.messageCount, 0);

      let word: string;
      let topTopic: string;
      let model: string;

      if (days.length === 1) {
        // A single scored day: copy its word/topic — no LLM call needed.
        const only = days[0];
        word = only.word ?? only.topTopic;
        topTopic = only.topTopic;
        model = "copy";
      } else {
        const out = await complete(
          PERIOD_INSIGHT_PROMPT,
          buildPeriodInsightRequest({
            granularity: target.granularity,
            bucket: target.bucket,
            days: days.map((d: PeriodDayRow) => ({
              insightDate: d.insightDate,
              moodLabel: d.moodLabel,
              topTopic: d.topTopic,
              word: d.word ?? d.topTopic,
              messageCount: d.messageCount,
            })),
          }),
        );
        if (!out) {
          result.periodsFailed += 1;
          continue;
        }
        const parsed = parsePeriodInsight(out.content);
        if (!parsed) {
          result.periodsFailed += 1;
          await trace.event({
            type: "step",
            level: "warn",
            message: "unusable period roll-up — left for the next run",
            data: { ...target, content: out.content },
          });
          continue;
        }
        word = parsed.wordOfPeriod;
        topTopic = parsed.topTopic;
        model = out.model;
      }

      await upsertPeriodInsight(db, {
        granularity: target.granularity,
        bucket: target.bucket,
        scope: target.scope,
        chatId: target.chatId,
        wordOfPeriod: word,
        topTopic,
        moodScore,
        moodLabel: moodLabelForScore(moodScore),
        sourceDays: days.length,
        messageCount,
        model,
      });
      result.periodsComputed += 1;
    }

    const summary =
      `${result.daysComputed} day(s) scored, ${result.periodsComputed} period(s) rolled up` +
      (result.daysFailed + result.periodsFailed > 0
        ? `, ${result.daysFailed + result.periodsFailed} left pending`
        : "");

    await trace.succeed({ outputSummary: summary });
    publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
    return { ...result, summary };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
