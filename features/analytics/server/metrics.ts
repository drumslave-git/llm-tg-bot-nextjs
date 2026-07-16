import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { getTimezone } from "@/features/settings/server/service";

import { moodLabelForScore } from "../mood";
import { bucketWindow, densify } from "../period";
import type {
  Granularity,
  HealthSignals,
  MetricContext,
  ModelStat,
  MoodPoint,
  NamedSeries,
  PeriodGranularity,
  PeriodInsight,
  RequestTypeStat,
  SeriesPayload,
  SeriesSection,
  SystemStats,
  TotalsPayload,
} from "../types";
import type { MetricsQuery, SeriesQuery } from "./schema";
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
  type ModelStatRaw,
  type StoredPeriodInsight,
} from "./repository";

/**
 * The analytics read service — the boundary the Route Handlers and the dashboard
 * Server Component call. Numeric metrics are computed live from the base tables;
 * the LLM-derived cards/trend are read from the stored insight rows.
 *
 * Reads are **per card**, not one payload for the page: each card on the dashboard
 * carries its own period and chat/user filter, so a single combined query would
 * have to be re-run in full for every card that moved. {@link getTotals} and
 * {@link getSeries} each answer exactly one card.
 */

const TOP_USERS = 10;
const MOOD_TREND_LIMIT = 60;
/** Every scored day, for the all-time cards. */
const ALL_TIME = new Date(0);

/** Completion tokens per second of latency — a ratio of sums, safe across a mix. */
function throughput(completionTokens: number, latencySumMs: number): number | null {
  if (latencySumMs <= 0) return null;
  return Math.round((completionTokens / (latencySumMs / 1000)) * 10) / 10;
}

/**
 * Group the raw (model, feature, action) rows into per-model rows carrying their
 * request-type breakdown. The SQL already normalized the model name and computed
 * each request type's percentiles, so this only sums and sorts.
 */
function buildModelStats(raw: ModelStatRaw[]): ModelStat[] {
  const byModel = new Map<string, ModelStatRaw[]>();
  for (const r of raw) {
    const list = byModel.get(r.model);
    if (list) list.push(r);
    else byModel.set(r.model, [r]);
  }

  return [...byModel.entries()]
    .map(([model, rows]) => {
      const requestTypes: RequestTypeStat[] = rows
        .map((r) => ({
          feature: r.feature,
          action: r.action,
          calls: r.calls,
          avgLatencyMs: r.calls > 0 ? Math.round(r.latencySum / r.calls) : 0,
          latencyP50: r.latencyP50,
          latencyP95: r.latencyP95,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.totalTokens,
          tokensPerSec: throughput(r.completionTokens, r.latencySum),
        }))
        .sort((a, b) => b.calls - a.calls);

      const sum = (pick: (r: ModelStatRaw) => number) => rows.reduce((a, r) => a + pick(r), 0);
      const completionTokens = sum((r) => r.completionTokens);
      return {
        model,
        calls: sum((r) => r.calls),
        promptTokens: sum((r) => r.promptTokens),
        completionTokens,
        totalTokens: sum((r) => r.totalTokens),
        tokensPerSec: throughput(completionTokens, sum((r) => r.latencySum)),
        requestTypes,
      };
    })
    .sort((x, y) => y.calls - x.calls);
}

/**
 * Mean latency of the LLM calls made *while producing a bot reply*.
 *
 * Scoped to `bot-messaging`/`reply` on purpose: this is the number the "Avg reply"
 * tile claims to show, and mixing in image descriptions and nightly summary passes
 * — work no one is waiting on — makes it describe nothing in particular.
 */
function avgReplyLatency(raw: ModelStatRaw[]): number | null {
  const reply = raw.filter((r) => r.feature === "bot-messaging" && r.action === "reply");
  const calls = reply.reduce((a, r) => a + r.calls, 0);
  if (calls === 0) return null;
  return Math.round(reply.reduce((a, r) => a + r.latencySum, 0) / calls);
}

function buildHealth(input: {
  up: number;
  down: number;
  botTraces: number;
  botErrors: number;
  avgReplyLatencyMs: number | null;
}): HealthSignals {
  const feedbackTotal = input.up + input.down;
  return {
    feedbackUp: input.up,
    feedbackDown: input.down,
    satisfaction: feedbackTotal > 0 ? input.up / feedbackTotal : null,
    errorRate: input.botTraces > 0 ? input.botErrors / input.botTraces : null,
    botTraces: input.botTraces,
    botErrors: input.botErrors,
    avgReplyLatencyMs: input.avgReplyLatencyMs,
  };
}

/** The context every card's payload echoes back, resolved from its filters. */
async function contextFor(query: MetricsQuery, db: DrizzleDb): Promise<MetricContext> {
  const chatId = query.chatId ?? null;
  const userId = query.userId ?? null;
  return {
    granularity: query.granularity,
    timezone: await getTimezone(db),
    scope: userId ? "user" : chatId ? "chat" : "global",
    chatId,
    userId,
  };
}

/** The traffic tiles for one card's filters. */
export async function getMetricTotals(
  query: MetricsQuery,
  db: DrizzleDb = getDb(),
): Promise<TotalsPayload> {
  const ctx = await contextFor(query, db);
  const { startUtc } = bucketWindow(ctx.granularity, {
    now: new Date(),
    timeZone: ctx.timezone,
    count: query.count,
  });
  const scope = { startUtc, chatId: ctx.chatId, userId: ctx.userId };

  const [totals, tokenTotals, media] = await Promise.all([
    getTotals(db, scope),
    getTokenTotals(db, scope),
    getMediaTotal(db, { startUtc, chatId: ctx.chatId }),
  ]);

  return {
    ...ctx,
    totals: {
      messages: totals.human + totals.bot,
      humanMessages: totals.human,
      botMessages: totals.bot,
      tokensProcessed: tokenTotals.processed,
      tokensGenerated: tokenTotals.generated,
      activeUsers: totals.activeUsers,
      media,
    },
  };
}

/** Build one chart card's series over the resolved bucket window. */
async function seriesFor(
  section: SeriesSection,
  db: DrizzleDb,
  ctx: MetricContext,
  window: { keys: string[]; startUtc: Date },
): Promise<{ buckets: string[]; series: NamedSeries[]; yMax?: number }> {
  const { keys, startUtc } = window;
  const scope = { startUtc, chatId: ctx.chatId, userId: ctx.userId };
  const granularity = ctx.granularity;
  const timeZone = ctx.timezone;

  switch (section) {
    case "volume": {
      const rows = await getMessageSeries(db, { ...scope, granularity, timeZone });
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      return {
        buckets: keys,
        series: [
          { name: "From users", data: keys.map((k) => byBucket.get(k)?.human ?? 0) },
          { name: "Bot replies", data: keys.map((k) => byBucket.get(k)?.bot ?? 0) },
        ],
      };
    }
    case "tokens": {
      const rows = await getTokenSeries(db, { ...scope, granularity, timeZone });
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      return {
        buckets: keys,
        series: [
          { name: "Processed", data: keys.map((k) => byBucket.get(k)?.processed ?? 0) },
          { name: "Generated", data: keys.map((k) => byBucket.get(k)?.generated ?? 0) },
        ],
      };
    }
    case "users": {
      // New-user counts are a global fact about a person's first sighting, so they
      // are meaningless inside a chat/user filter and are omitted rather than faked.
      const scoped = ctx.scope !== "global";
      const [rows, newUsers] = await Promise.all([
        getMessageSeries(db, { ...scope, granularity, timeZone }),
        scoped ? Promise.resolve(null) : getNewUserSeries(db, { startUtc, granularity, timeZone }),
      ]);
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      const series: NamedSeries[] = [
        { name: "Active users", data: keys.map((k) => byBucket.get(k)?.activeUsers ?? 0) },
      ];
      if (newUsers) series.push({ name: "New users", data: densify(keys, newUsers) });
      return { buckets: keys, series };
    }
    case "mood": {
      // Mood is stored per (period, scope) by the insight job, and only for scored
      // days — a bucket with no row is a gap, not a zero.
      const rows = await getMoodTrend(db, {
        granularity,
        scope: ctx.scope === "chat" ? "chat" : "global",
        chatId: ctx.scope === "chat" ? (ctx.chatId ?? "") : "",
        limit: MOOD_TREND_LIMIT,
      });
      const byBucket = new Map(rows.map((r) => [r.bucket, r.moodScore]));
      return {
        buckets: keys,
        series: [{ name: "Mood", data: keys.map((k) => byBucket.get(k) ?? null) }],
        yMax: 100,
      };
    }
  }
}

/** One chart card's payload. */
export async function getSeries(query: SeriesQuery, db: DrizzleDb = getDb()): Promise<SeriesPayload> {
  const ctx = await contextFor(query, db);
  const window = bucketWindow(ctx.granularity, {
    now: new Date(),
    timeZone: ctx.timezone,
    count: query.count,
  });
  const { buckets, series, yMax } = await seriesFor(query.section, db, ctx, window);
  return { ...ctx, section: query.section, buckets, series, yMax };
}

/**
 * The system-level cards: bot health, model performance, top users. All history,
 * every chat — these describe the bot, so they take no filters.
 */
export async function getSystemStats(db: DrizzleDb = getDb()): Promise<SystemStats> {
  const [modelRaw, feedback, botHealth, topUserRows] = await Promise.all([
    getModelStatsRaw(db, { startUtc: ALL_TIME }),
    getFeedbackCounts(db, { startUtc: ALL_TIME }),
    getBotTraceHealth(db, { startUtc: ALL_TIME }),
    getTopUsers(db, { startUtc: ALL_TIME, limit: TOP_USERS }),
  ]);

  const userIds = topUserRows.map((r) => r.userId);
  const [labelRows, userTokens] = await Promise.all([
    userIds.length > 0 ? getKnownUsersByIds(db, userIds) : Promise.resolve([]),
    getUserTokens(db, { startUtc: ALL_TIME, userIds }),
  ]);
  const labelById = new Map(labelRows.map((u) => [u.userId, formatKnownUserLabel(u)]));

  return {
    models: buildModelStats(modelRaw),
    health: buildHealth({
      up: feedback.up,
      down: feedback.down,
      botTraces: botHealth.total,
      botErrors: botHealth.errors,
      avgReplyLatencyMs: avgReplyLatency(modelRaw),
    }),
    topUsers: topUserRows.map((r) => ({
      userId: r.userId,
      label: labelById.get(r.userId) ?? `User ${r.userId}`,
      messages: r.messages,
      tokens: userTokens.get(r.userId) ?? 0,
    })),
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
