import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { normalizeModelName } from "@/features/self-improvement/model-name";
import { getTimezone } from "@/features/settings/server/service";

import { moodLabelForScore } from "../mood";
import { bucketWindow, densify } from "../period";
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
  getLatestPeriodInsight,
  getMediaTotal,
  getMessageSeries,
  getModelStatsRaw,
  getMoodTrend,
  getNewUserSeries,
  getPeriodInsight,
  getTokenSeries,
  getTokenTotals,
  getTopUsers,
  getTotals,
  getUserTokens,
  type StoredPeriodInsight,
} from "./repository";

/**
 * The analytics read service — the boundary the Route Handlers and the dashboard
 * Server Component call. Numeric metrics are computed live from the base tables;
 * the LLM-derived cards/trend are read from the stored insight rows.
 */

const TOP_USERS = 10;
const MOOD_TREND_LIMIT = 60;

/** Merge registry-prefixed model variants and compute per-model derived stats. */
function mergeModelStats(raw: Awaited<ReturnType<typeof getModelStatsRaw>>): ModelStat[] {
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
  const tokenScope = { startUtc, chatId, userId, granularity, timeZone: timezone };

  const [series, tokenSeries, newUsers, totals, tokenTotals, media, modelRaw, feedback, botHealth, topUserRows] =
    await Promise.all([
      getMessageSeries(db, { startUtc, chatId, userId, granularity, timeZone: timezone }),
      getTokenSeries(db, tokenScope),
      scoped ? Promise.resolve(null) : getNewUserSeries(db, { startUtc, granularity, timeZone: timezone }),
      getTotals(db, { startUtc, chatId, userId }),
      getTokenTotals(db, { startUtc, chatId, userId }),
      getMediaTotal(db, { startUtc, chatId }),
      getModelStatsRaw(db, { startUtc }),
      getFeedbackCounts(db, { startUtc, chatId }),
      getBotTraceHealth(db, { startUtc }),
      getTopUsers(db, { startUtc, chatId, limit: TOP_USERS }),
    ]);

  const msgByBucket = new Map(series.map((r) => [r.bucket, r]));
  const tokByBucket = new Map(tokenSeries.map((r) => [r.bucket, r]));

  const models = mergeModelStats(modelRaw);
  const latencySum = modelRaw.reduce((a, r) => a + r.latencySum, 0);
  const latencyCalls = modelRaw.reduce((a, r) => a + r.calls, 0);

  const userIds = topUserRows.map((r) => r.userId);
  const [labelRows, userTokens] = await Promise.all([
    userIds.length > 0 ? getKnownUsersByIds(db, userIds) : Promise.resolve([]),
    getUserTokens(db, { startUtc, userIds, chatId }),
  ]);
  const labelById = new Map(labelRows.map((u) => [u.userId, formatKnownUserLabel(u)]));

  return {
    granularity,
    timezone,
    scope,
    chatId,
    userId,
    buckets: keys,
    volume: {
      human: keys.map((k) => msgByBucket.get(k)?.human ?? 0),
      bot: keys.map((k) => msgByBucket.get(k)?.bot ?? 0),
    },
    tokens: {
      processed: keys.map((k) => tokByBucket.get(k)?.processed ?? 0),
      generated: keys.map((k) => tokByBucket.get(k)?.generated ?? 0),
    },
    users: {
      active: keys.map((k) => msgByBucket.get(k)?.activeUsers ?? 0),
      new: newUsers ? densify(keys, newUsers) : null,
    },
    totals: {
      messages: totals.human + totals.bot,
      humanMessages: totals.human,
      botMessages: totals.bot,
      tokensProcessed: tokenTotals.processed,
      tokensGenerated: tokenTotals.generated,
      activeUsers: totals.activeUsers,
      media,
    },
    models,
    topUsers: topUserRows.map((r) => ({
      userId: r.userId,
      label: labelById.get(r.userId) ?? `User ${r.userId}`,
      messages: r.messages,
      tokens: userTokens.get(r.userId) ?? 0,
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

function toPeriodInsight(row: StoredPeriodInsight): PeriodInsight {
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

/**
 * The stored insight (mood + word of the period + top topic) for the selected
 * granularity/scope. Defaults to the latest computed bucket (the current day/week/
 * month may not be scored yet — insights cover finished days). Null before the
 * job's first run for that scope.
 */
export async function getPeriodInsightCard(
  params: { granularity: PeriodGranularity; bucket?: string | null; scope: "global" | "chat"; chatId?: string | null },
  db: DrizzleDb = getDb(),
): Promise<PeriodInsight | null> {
  const chatId = params.scope === "chat" ? (params.chatId ?? "") : "";
  const row = params.bucket
    ? await getPeriodInsight(db, { granularity: params.granularity, bucket: params.bucket, scope: params.scope, chatId })
    : await getLatestPeriodInsight(db, { granularity: params.granularity, scope: params.scope, chatId });
  return row ? toPeriodInsight(row) : null;
}

/** Per-bucket mood points for the trend chart, at the selected granularity/scope. */
export async function getMoodTrendPoints(
  params: { granularity: Granularity; scope: "global" | "chat"; chatId?: string | null },
  db: DrizzleDb = getDb(),
): Promise<MoodPoint[]> {
  const chatId = params.scope === "chat" ? (params.chatId ?? "") : "";
  const rows = await getMoodTrend(db, {
    granularity: params.granularity,
    scope: params.scope,
    chatId,
    limit: MOOD_TREND_LIMIT,
  });
  return rows.map((r) => ({
    bucket: r.bucket,
    moodScore: r.moodScore,
    moodLabel: r.moodLabel || moodLabelForScore(r.moodScore),
  }));
}
