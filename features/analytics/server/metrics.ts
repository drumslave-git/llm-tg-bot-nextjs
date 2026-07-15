import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { normalizeModelName } from "@/features/self-improvement/model-name";
import { getTimezone } from "@/features/settings/server/service";

import { moodLabelForScore } from "../mood";
import { bucketKeyOfInstant, bucketWindow, densify } from "../period";
import type {
  AnalyticsMetrics,
  Granularity,
  HealthSignals,
  ModelStat,
  MoodPoint,
  PeriodGranularity,
  PeriodInsight,
} from "../types";
import type { MetricsQuery } from "./schema";
import {
  getBotTraceHealth,
  getFeedbackCounts,
  getMediaTotal,
  getMessageSeries,
  getModelStatsRaw,
  getMoodTrend,
  getNewUserSeries,
  getPeriodInsight,
  getTopUsers,
  getTotals,
} from "./repository";

/**
 * The analytics read service — the boundary the Route Handlers and the dashboard
 * Server Component call. Numeric metrics are computed live from the base tables;
 * the LLM-derived cards are read from the stored insight rows.
 */

const TOP_USERS = 10;
const MOOD_TREND_DAYS = 90;

/** Merge registry-prefixed model variants and compute per-model derived stats. */
function mergeModelStats(
  raw: { model: string; calls: number; latencySum: number; promptTokens: number; completionTokens: number; totalTokens: number }[],
): ModelStat[] {
  const byName = new Map<string, { calls: number; latencySum: number; prompt: number; completion: number; total: number }>();
  for (const r of raw) {
    const name = normalizeModelName(r.model);
    const acc = byName.get(name) ?? { calls: 0, latencySum: 0, prompt: 0, completion: 0, total: 0 };
    acc.calls += r.calls;
    acc.latencySum += r.latencySum;
    acc.prompt += r.promptTokens;
    acc.completion += r.completionTokens;
    acc.total += r.totalTokens;
    byName.set(name, acc);
  }
  return [...byName.entries()]
    .map(([model, a]) => ({
      model,
      calls: a.calls,
      avgLatencyMs: a.calls > 0 ? Math.round(a.latencySum / a.calls) : 0,
      promptTokens: a.prompt,
      completionTokens: a.completion,
      totalTokens: a.total,
      tokensPerSec: a.latencySum > 0 ? Math.round((a.completion / (a.latencySum / 1000)) * 10) / 10 : null,
    }))
    .sort((x, y) => y.calls - x.calls);
}

/** Map mean reply latency (ms) to a 0–100 responsiveness sub-score. */
function responsivenessScore(avgLatencyMs: number): number {
  const fast = 2_000;
  const slow = 20_000;
  if (avgLatencyMs <= fast) return 100;
  if (avgLatencyMs >= slow) return 0;
  return Math.round(100 * (1 - (avgLatencyMs - fast) / (slow - fast)));
}

function buildHealth(input: {
  up: number;
  down: number;
  botTraces: number;
  botErrors: number;
  latencySum: number;
  latencyCalls: number;
  activeUsers: number;
  messages: number;
}): HealthSignals {
  const feedbackTotal = input.up + input.down;
  const satisfaction = feedbackTotal > 0 ? input.up / feedbackTotal : null;
  const errorRate = input.botTraces > 0 ? input.botErrors / input.botTraces : null;
  const avgReplyLatencyMs = input.latencyCalls > 0 ? Math.round(input.latencySum / input.latencyCalls) : null;

  const sub: number[] = [];
  if (satisfaction !== null) sub.push(satisfaction * 100);
  if (errorRate !== null) sub.push((1 - errorRate) * 100);
  if (avgReplyLatencyMs !== null) sub.push(responsivenessScore(avgReplyLatencyMs));
  const score = sub.length > 0 ? Math.round(sub.reduce((a, b) => a + b, 0) / sub.length) : null;

  return {
    feedbackUp: input.up,
    feedbackDown: input.down,
    satisfaction,
    errorRate,
    botTraces: input.botTraces,
    botErrors: input.botErrors,
    avgReplyLatencyMs,
    activeUsers: input.activeUsers,
    messages: input.messages,
    score,
  };
}

/** Assemble the full numeric metrics payload for a query. */
export async function getMetrics(query: MetricsQuery, db: DrizzleDb = getDb()): Promise<AnalyticsMetrics> {
  const timezone = await getTimezone(db);
  const now = new Date();
  const granularity: Granularity = query.granularity;
  const { keys, startUtc } = bucketWindow(granularity, { now, timeZone: timezone, count: query.count });

  const chatId = query.chatId ?? null;
  const userId = query.userId ?? null;
  const scoped = chatId !== null || userId !== null;
  const scope: AnalyticsMetrics["scope"] = userId ? "user" : chatId ? "chat" : "global";

  const [series, newUsers, totals, media, modelRaw, feedback, botHealth, topUserRows] = await Promise.all([
    getMessageSeries(db, { startUtc, chatId, userId, granularity, timeZone: timezone }),
    scoped ? Promise.resolve(null) : getNewUserSeries(db, { startUtc, granularity, timeZone: timezone }),
    getTotals(db, { startUtc, chatId, userId }),
    getMediaTotal(db, { startUtc, chatId }),
    getModelStatsRaw(db, { startUtc }),
    getFeedbackCounts(db, { startUtc, chatId }),
    getBotTraceHealth(db, { startUtc }),
    getTopUsers(db, { startUtc, chatId, limit: TOP_USERS }),
  ]);

  const byBucket = new Map(series.map((r) => [r.bucket, r]));
  const pick = (get: (r: (typeof series)[number]) => number): number[] =>
    keys.map((k) => {
      const row = byBucket.get(k);
      return row ? get(row) : 0;
    });

  const models = mergeModelStats(modelRaw);
  const latencySum = modelRaw.reduce((a, r) => a + r.latencySum, 0);
  const latencyCalls = modelRaw.reduce((a, r) => a + r.calls, 0);

  const labels =
    topUserRows.length > 0
      ? await getKnownUsersByIds(
          db,
          topUserRows.map((r) => r.userId),
        )
      : [];
  const labelById = new Map(labels.map((u) => [u.userId, formatKnownUserLabel(u)]));

  return {
    granularity,
    timezone,
    scope,
    chatId,
    userId,
    buckets: keys,
    volume: { human: pick((r) => r.human), bot: pick((r) => r.bot) },
    chars: { processed: pick((r) => r.charsProcessed), generated: pick((r) => r.charsGenerated) },
    users: {
      active: pick((r) => r.activeUsers),
      new: newUsers ? densify(keys, newUsers) : null,
    },
    totals: {
      messages: totals.human + totals.bot,
      humanMessages: totals.human,
      botMessages: totals.bot,
      charsProcessed: totals.charsProcessed,
      charsGenerated: totals.charsGenerated,
      activeUsers: totals.activeUsers,
      media,
    },
    models,
    topUsers: topUserRows.map((r) => ({
      userId: r.userId,
      label: labelById.get(r.userId) ?? `User ${r.userId}`,
      messages: r.messages,
      chars: r.chars,
    })),
    health: buildHealth({
      up: feedback.up,
      down: feedback.down,
      botTraces: botHealth.total,
      botErrors: botHealth.errors,
      latencySum,
      latencyCalls,
      activeUsers: totals.activeUsers,
      messages: totals.human,
    }),
  };
}

/** Recent per-day mood points for the trend chart (global average or one chat). */
export async function getMoodTrendPoints(
  params: { chatId?: string | null },
  db: DrizzleDb = getDb(),
): Promise<MoodPoint[]> {
  const rows = await getMoodTrend(db, { chatId: params.chatId ?? null, limit: MOOD_TREND_DAYS });
  return rows.map((r) => ({
    date: r.date,
    moodScore: r.moodScore,
    moodLabel: r.moodLabel ?? moodLabelForScore(r.moodScore),
  }));
}

/**
 * The stored period roll-up (mood + word + topic) for a selected bucket, or null
 * when it has not been computed yet (e.g. before the nightly job's first run).
 * When no bucket is given, the current period is used.
 */
export async function getPeriodInsightCard(
  params: { granularity: PeriodGranularity; bucket?: string | null; scope: "global" | "chat"; chatId?: string | null },
  db: DrizzleDb = getDb(),
): Promise<PeriodInsight | null> {
  const timezone = await getTimezone(db);
  const bucket = params.bucket ?? bucketKeyOfInstant(new Date(), params.granularity, timezone);
  const chatId = params.scope === "chat" ? (params.chatId ?? "") : "";
  const row = await getPeriodInsight(db, {
    granularity: params.granularity,
    bucket,
    scope: params.scope,
    chatId,
  });
  if (!row) return null;
  return {
    granularity: row.granularity,
    bucket: row.bucket,
    scope: row.scope,
    chatId: row.chatId || null,
    wordOfPeriod: row.wordOfPeriod,
    topTopic: row.topTopic,
    moodScore: row.moodScore,
    moodLabel: row.moodLabel,
    sourceDays: row.sourceDays,
    messageCount: row.messageCount,
    model: row.model,
    computedAt: row.computedAt,
  };
}
