import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { normalizeModelName } from "@/features/self-improvement/model-name";
import { zonedDate } from "@/features/scheduled-tasks/schedule";
import { FEATURES } from "@/lib/features";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { moodLabelForScore } from "../mood";
import type { PeriodGranularity } from "../types";
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
  listDayInsightsForPeriod,
  listDaysNeedingInsight,
  upsertChatDayInsight,
  upsertPeriodInsight,
} from "./repository";

/**
 * The nightly analytics insight job: score each finished chat-day's mood + top
 * topic, then roll the touched month/year/all-time periods up into "word of the
 * period" + top topic + an aggregate mood.
 *
 * Two passes, one trace:
 *  - **days** — one LLM call per (chat, day) that is missing an insight or whose
 *    message count changed (self-healing, exactly like the summarizer). The mood
 *    score is the model's; the day is the base grain of everything above it.
 *  - **periods** — for every month/year/all bucket the day pass touched, one LLM
 *    call for the word + topic, while the mood is a deterministic message-weighted
 *    average of the period's day rows (so mood never depends on a fragile parse).
 *
 * Fails **closed** per unit: an unusable model response leaves that day's or
 * period's stored row untouched, so a bad night can never corrupt accumulated
 * analytics. Idempotent: an unchanged day/period is skipped, costing no tokens.
 */

const FEATURE = FEATURES["analytics-insights"];

/** Safety valves on one run (not business rules) — bound a runaway backlog. */
const MAX_DAYS_PER_RUN = 200;
const MAX_PERIODS_PER_RUN = 150;

export interface AnalyticsInsightsDeps {
  /** One LLM pass (real: `chatCompletion` with the configured model). */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /** Operator timezone the days are bucketed in. */
  timeZone: string;
  /** Overridable clock for tests. */
  now?: Date;
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
  granularity: PeriodGranularity;
  bucket: string;
  scope: "global" | "chat";
  chatId: string;
}

/** Encode a period target as a set key. */
function targetKey(t: PeriodTarget): string {
  return `${t.granularity}|${t.bucket}|${t.scope}|${t.chatId}`;
}

/** The month/year/all buckets a (date, chat) touches, for both global and chat scope. */
function periodsForDay(date: string, chatId: string): PeriodTarget[] {
  const [year, month] = date.split("-");
  const buckets: [PeriodGranularity, string][] = [
    ["month", `${year}-${month}`],
    ["year", year],
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
  const weighted = days.reduce((a, d) => a + d.moodScore * d.messageCount, 0);
  return Math.round(weighted / totalMsgs);
}

/**
 * Run one insight pass. Never throws for a per-unit failure. Records one trace
 * only when there is work, so a nightly tick with nothing to do stays silent.
 */
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
  if (pending.length === 0) {
    return { ...EMPTY, summary: "nothing to compute" };
  }

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "insights",
      trigger: { kind: "system", actor: "analytics" },
      inputSummary: `${pending.length} day(s) pending`,
    },
    db,
  );

  const result = { ...EMPTY };

  /** One LLM pass, fully traced (request + response with usage). Null on failure. */
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
    const touched = new Map<string, PeriodTarget>();

    /* Pass 1 — one insight per pending (chat, day). */
    for (const day of pending) {
      const [messages, topics] = await Promise.all([
        getDayMessages(db, { chatId: day.chatId, date: day.insightDate, timeZone: deps.timeZone }),
        getDaySummaryTopics(db, { chatId: day.chatId, date: day.insightDate }),
      ]);
      const transcript = formatTranscript(messages);
      if (!transcript) {
        // A day with only media/empty content: nothing to read. Record a neutral
        // row so it is not rescanned forever, keyed by the same message count.
        await upsertChatDayInsight(db, {
          chatId: day.chatId,
          insightDate: day.insightDate,
          moodScore: 50,
          moodLabel: moodLabelForScore(50),
          moodSummary: "No readable text this day.",
          topTopic: "—",
          messageCount: day.messageCount,
          model: "n/a",
        });
        result.daysComputed += 1;
        for (const t of periodsForDay(day.insightDate, day.chatId)) touched.set(targetKey(t), t);
        continue;
      }

      const out = await complete(
        DAY_INSIGHT_PROMPT,
        buildDayInsightRequest({ transcript, topics }),
      );
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

    /* Pass 2 — roll up every touched period (word + topic via LLM, mood weighted). */
    const targets = [...touched.values()].slice(0, MAX_PERIODS_PER_RUN);
    for (const target of targets) {
      const days = await listDayInsightsForPeriod(db, {
        granularity: target.granularity,
        bucket: target.bucket,
        chatId: target.scope === "chat" ? target.chatId : null,
      });
      if (days.length === 0) continue;

      const out = await complete(
        PERIOD_INSIGHT_PROMPT,
        buildPeriodInsightRequest({
          granularity: target.granularity,
          bucket: target.bucket,
          days: days.map((d) => ({
            insightDate: d.insightDate,
            moodLabel: d.moodLabel,
            topTopic: d.topTopic,
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

      const moodScore = weightedMood(days);
      await upsertPeriodInsight(db, {
        granularity: target.granularity,
        bucket: target.bucket,
        scope: target.scope,
        chatId: target.chatId,
        wordOfPeriod: parsed.wordOfPeriod,
        topTopic: parsed.topTopic,
        moodScore,
        moodLabel: moodLabelForScore(moodScore),
        sourceDays: days.length,
        messageCount: days.reduce((a, d) => a + d.messageCount, 0),
        model: out.model,
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
