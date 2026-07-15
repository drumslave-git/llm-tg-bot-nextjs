import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatDayInsights, periodInsights } from "@/db/schema";

import { bucketFormat, truncUnit } from "../period";
import type { Granularity, PeriodGranularity } from "../types";

/**
 * Typed persistence + live-SQL aggregation for analytics. Pure data access: no
 * policy, no LLM, no tracing (the services own those). Numeric metrics are
 * computed live over the base tables (exact, self-healing); only the LLM-derived
 * insight rows are stored here.
 */

/** Common time/scope filter for the message-based metric queries. */
export interface MetricScope {
  startUtc: Date;
  chatId?: string | null;
  userId?: string | null;
}

/** The wall-clock bucket key expression for a timestamptz column, or `'all'`. */
function bucketExpr(column: SQL, granularity: Granularity, timeZone: string): SQL {
  const unit = truncUnit(granularity);
  if (!unit) return sql`'all'`;
  return sql`to_char(date_trunc(${unit}, (${column} at time zone ${timeZone})), ${bucketFormat(granularity)})`;
}

/** Build the shared `chat_messages` WHERE clause from a scope. */
function messageWhere(scope: MetricScope): SQL {
  const parts: SQL[] = [sql`deleted_at is null`, sql`sent_at >= ${scope.startUtc}`];
  if (scope.chatId) parts.push(sql`chat_id = ${scope.chatId}`);
  if (scope.userId) parts.push(sql`user_id = ${scope.userId}`);
  return sql.join(parts, sql` and `);
}

export interface MessageSeriesRow {
  bucket: string;
  human: number;
  bot: number;
  charsProcessed: number;
  charsGenerated: number;
  activeUsers: number;
}

/** Per-bucket message volume, character volume, and active users. */
export async function getMessageSeries(
  db: DrizzleDb,
  params: MetricScope & { granularity: Granularity; timeZone: string },
): Promise<MessageSeriesRow[]> {
  const bucket = bucketExpr(sql`sent_at`, params.granularity, params.timeZone);
  const rows = await db.execute<{
    bucket: string;
    human: number;
    bot: number;
    chars_processed: string;
    chars_generated: string;
    active_users: number;
  }>(sql`
    select
      ${bucket} as bucket,
      count(*) filter (where role = 'user')::int as human,
      count(*) filter (where role = 'assistant')::int as bot,
      coalesce(sum(char_length(content)) filter (where role = 'user'), 0)::bigint as chars_processed,
      coalesce(sum(char_length(content)) filter (where role = 'assistant'), 0)::bigint as chars_generated,
      count(distinct user_id) filter (where role = 'user')::int as active_users
    from chat_messages
    where ${messageWhere(params)}
    group by 1
  `);
  return rows.rows.map((r) => ({
    bucket: r.bucket,
    human: Number(r.human),
    bot: Number(r.bot),
    charsProcessed: Number(r.chars_processed),
    charsGenerated: Number(r.chars_generated),
    activeUsers: Number(r.active_users),
  }));
}

/** Per-bucket count of users first seen in the window (global only). */
export async function getNewUserSeries(
  db: DrizzleDb,
  params: { startUtc: Date; granularity: Granularity; timeZone: string },
): Promise<Map<string, number>> {
  const bucket = bucketExpr(sql`first_seen_at`, params.granularity, params.timeZone);
  const rows = await db.execute<{ bucket: string; new_users: number }>(sql`
    select ${bucket} as bucket, count(*)::int as new_users
    from known_users
    where first_seen_at >= ${params.startUtc}
    group by 1
  `);
  return new Map(rows.rows.map((r) => [r.bucket, Number(r.new_users)]));
}

export interface MetricTotals {
  human: number;
  bot: number;
  charsProcessed: number;
  charsGenerated: number;
  activeUsers: number;
}

/** Whole-window totals (a distinct-user count that a per-bucket sum can't give). */
export async function getTotals(db: DrizzleDb, scope: MetricScope): Promise<MetricTotals> {
  const rows = await db.execute<{
    human: number;
    bot: number;
    chars_processed: string;
    chars_generated: string;
    active_users: number;
  }>(sql`
    select
      count(*) filter (where role = 'user')::int as human,
      count(*) filter (where role = 'assistant')::int as bot,
      coalesce(sum(char_length(content)) filter (where role = 'user'), 0)::bigint as chars_processed,
      coalesce(sum(char_length(content)) filter (where role = 'assistant'), 0)::bigint as chars_generated,
      count(distinct user_id) filter (where role = 'user')::int as active_users
    from chat_messages
    where ${messageWhere(scope)}
  `);
  const r = rows.rows[0];
  return {
    human: Number(r?.human ?? 0),
    bot: Number(r?.bot ?? 0),
    charsProcessed: Number(r?.chars_processed ?? 0),
    charsGenerated: Number(r?.chars_generated ?? 0),
    activeUsers: Number(r?.active_users ?? 0),
  };
}

/** Media rows captured in the window (optionally scoped to one chat). */
export async function getMediaTotal(
  db: DrizzleDb,
  params: { startUtc: Date; chatId?: string | null },
): Promise<number> {
  const parts: SQL[] = [sql`created_at >= ${params.startUtc}`];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from message_media where ${sql.join(parts, sql` and `)}
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

export interface ModelStatRaw {
  model: string;
  calls: number;
  latencySum: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Raw per-(reported)-model LLM usage from the trace timeline. Grouped by the
 * model string exactly as the provider reported it; the service normalizes and
 * merges registry-prefixed variants. Latency is summed (not averaged) so the
 * merge can recompute a correct mean.
 */
export async function getModelStatsRaw(
  db: DrizzleDb,
  params: { startUtc: Date },
): Promise<ModelStatRaw[]> {
  const rows = await db.execute<{
    model: string;
    calls: number;
    latency_sum: string;
    prompt_tokens: string;
    completion_tokens: string;
    total_tokens: string;
  }>(sql`
    select
      e.usage->>'model' as model,
      count(*)::int as calls,
      coalesce(sum((e.usage->>'latencyMs')::numeric), 0) as latency_sum,
      coalesce(sum((e.usage->>'promptTokens')::numeric), 0) as prompt_tokens,
      coalesce(sum((e.usage->>'completionTokens')::numeric), 0) as completion_tokens,
      coalesce(sum((e.usage->>'totalTokens')::numeric), 0) as total_tokens
    from trace_events e
    join traces t on t.id = e.trace_id
    where e.type = 'llm_response'
      and e.usage is not null
      and (e.usage->>'model') is not null
      and t.started_at >= ${params.startUtc}
    group by 1
  `);
  return rows.rows.map((r) => ({
    model: r.model,
    calls: Number(r.calls),
    latencySum: Number(r.latency_sum),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
  }));
}

/** 👍 / 👎 reaction counts on bot replies in the window. */
export async function getFeedbackCounts(
  db: DrizzleDb,
  params: { startUtc: Date; chatId?: string | null },
): Promise<{ up: number; down: number }> {
  const parts: SQL[] = [sql`created_at >= ${params.startUtc}`];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ up: number; down: number }>(sql`
    select
      count(*) filter (where reaction = 'up')::int as up,
      count(*) filter (where reaction = 'down')::int as down
    from users_feedbacks
    where ${sql.join(parts, sql` and `)}
  `);
  return { up: Number(rows.rows[0]?.up ?? 0), down: Number(rows.rows[0]?.down ?? 0) };
}

/** Bot-messaging trace reliability in the window. */
export async function getBotTraceHealth(
  db: DrizzleDb,
  params: { startUtc: Date },
): Promise<{ total: number; errors: number }> {
  const rows = await db.execute<{ total: number; errors: number }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'error')::int as errors
    from traces
    where feature = 'bot-messaging' and started_at >= ${params.startUtc}
  `);
  return { total: Number(rows.rows[0]?.total ?? 0), errors: Number(rows.rows[0]?.errors ?? 0) };
}

export interface TopUserRow {
  userId: string;
  messages: number;
  chars: number;
}

/** The most active human senders in the window (optionally within one chat). */
export async function getTopUsers(
  db: DrizzleDb,
  params: { startUtc: Date; chatId?: string | null; limit: number },
): Promise<TopUserRow[]> {
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`role = 'user'`,
    sql`user_id is not null`,
    sql`sent_at >= ${params.startUtc}`,
  ];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ user_id: string; messages: number; chars: string }>(sql`
    select user_id, count(*)::int as messages, coalesce(sum(char_length(content)), 0)::bigint as chars
    from chat_messages
    where ${sql.join(parts, sql` and `)}
    group by user_id
    order by messages desc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({
    userId: r.user_id,
    messages: Number(r.messages),
    chars: Number(r.chars),
  }));
}

export interface MoodTrendRow {
  date: string;
  moodScore: number;
  moodLabel: string | null;
}

/**
 * Recent per-day mood, newest last. For one chat it is that chat's stored row; for
 * the global view it is the message-weighted average across chats (label derived
 * by the service).
 */
export async function getMoodTrend(
  db: DrizzleDb,
  params: { chatId?: string | null; limit: number },
): Promise<MoodTrendRow[]> {
  if (params.chatId) {
    const rows = await db.execute<{ date: string; mood_score: number; mood_label: string }>(sql`
      select insight_date as date, mood_score, mood_label
      from chat_day_insights
      where chat_id = ${params.chatId}
      order by insight_date desc
      limit ${params.limit}
    `);
    return rows.rows
      .map((r) => ({ date: r.date, moodScore: Number(r.mood_score), moodLabel: r.mood_label }))
      .reverse();
  }
  const rows = await db.execute<{ date: string; mood_score: number }>(sql`
    select
      insight_date as date,
      round(sum(mood_score::numeric * message_count) / nullif(sum(message_count), 0))::int as mood_score
    from chat_day_insights
    group by insight_date
    order by insight_date desc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({ date: r.date, moodScore: Number(r.mood_score), moodLabel: null })).reverse();
}

/* ------------------------------------------------------------------------- *
 * Insight-row persistence (written by the nightly job).
 * ------------------------------------------------------------------------- */

export interface PendingInsightDay {
  chatId: string;
  insightDate: string;
  messageCount: number;
}

/**
 * (chat, day) pairs whose LLM insight is missing or stale — the same self-healing
 * scan the summarizer uses ({@link listDaysNeedingSummary}): a day is owed when it
 * has no insight row, or when its live message count no longer matches the stored
 * one. The current (unfinished) day is excluded.
 */
export async function listDaysNeedingInsight(
  db: DrizzleDb,
  params: { timeZone: string; today: string; limit: number },
): Promise<PendingInsightDay[]> {
  const rows = await db.execute<{ chat_id: string; insight_date: string; message_count: number }>(sql`
    with days as (
      select
        chat_id,
        to_char((sent_at at time zone ${params.timeZone})::date, 'YYYY-MM-DD') as insight_date,
        count(*)::int as message_count
      from chat_messages
      where deleted_at is null
      group by 1, 2
    )
    select days.chat_id, days.insight_date, days.message_count
    from days
    left join chat_day_insights i
      on i.chat_id = days.chat_id and i.insight_date = days.insight_date
    where days.insight_date < ${params.today}
      and (i.id is null or i.message_count <> days.message_count)
    order by days.insight_date asc, days.chat_id asc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({
    chatId: r.chat_id,
    insightDate: r.insight_date,
    messageCount: Number(r.message_count),
  }));
}

/** How many (chat, day) pairs still need an insight — for the dashboard backlog. */
export async function countDaysNeedingInsight(
  db: DrizzleDb,
  params: { timeZone: string; today: string },
): Promise<number> {
  const pending = await listDaysNeedingInsight(db, { ...params, limit: 100_000 });
  return pending.length;
}

/** A day's messages (role + text), oldest first — the LLM insight input. */
export async function getDayMessages(
  db: DrizzleDb,
  params: { chatId: string; date: string; timeZone: string },
): Promise<{ role: "user" | "assistant"; userId: string | null; content: string }[]> {
  const rows = await db.execute<{ role: string; user_id: string | null; content: string }>(sql`
    select role, user_id, content
    from chat_messages
    where chat_id = ${params.chatId}
      and deleted_at is null
      and to_char((sent_at at time zone ${params.timeZone})::date, 'YYYY-MM-DD') = ${params.date}
    order by sent_at asc, id asc
  `);
  return rows.rows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    userId: r.user_id,
    content: r.content,
  }));
}

/** A day's already-distilled topic summaries for a chat (extra insight context). */
export async function getDaySummaryTopics(
  db: DrizzleDb,
  params: { chatId: string; date: string },
): Promise<string[]> {
  const rows = await db.execute<{ content: string }>(sql`
    select content from chat_summaries
    where chat_id = ${params.chatId} and summary_date = ${params.date}
    order by id asc
  `);
  return rows.rows.map((r) => r.content);
}

export interface UpsertDayInsight {
  chatId: string;
  insightDate: string;
  moodScore: number;
  moodLabel: string;
  moodSummary: string;
  topTopic: string;
  messageCount: number;
  model: string;
}

/** Insert or refresh one (chat, day) insight. */
export async function upsertChatDayInsight(db: DrizzleDb, row: UpsertDayInsight): Promise<void> {
  await db
    .insert(chatDayInsights)
    .values(row)
    .onConflictDoUpdate({
      target: [chatDayInsights.chatId, chatDayInsights.insightDate],
      set: {
        moodScore: row.moodScore,
        moodLabel: row.moodLabel,
        moodSummary: row.moodSummary,
        topTopic: row.topTopic,
        messageCount: row.messageCount,
        model: row.model,
        updatedAt: new Date(),
      },
    });
}

export interface PeriodDayRow {
  chatId: string;
  insightDate: string;
  moodScore: number;
  moodLabel: string;
  topTopic: string;
  messageCount: number;
}

/** Day insight rows falling within a period bucket (and optional chat scope). */
export async function listDayInsightsForPeriod(
  db: DrizzleDb,
  params: { granularity: PeriodGranularity; bucket: string; chatId?: string | null },
): Promise<PeriodDayRow[]> {
  const parts: SQL[] = [];
  if (params.granularity === "month") parts.push(sql`insight_date like ${`${params.bucket}-%`}`);
  else if (params.granularity === "year") parts.push(sql`insight_date like ${`${params.bucket}-%`}`);
  // "all" → no date filter.
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const where = parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``;
  const rows = await db.execute<{
    chat_id: string;
    insight_date: string;
    mood_score: number;
    mood_label: string;
    top_topic: string;
    message_count: number;
  }>(sql`
    select chat_id, insight_date, mood_score, mood_label, top_topic, message_count
    from chat_day_insights
    ${where}
    order by insight_date asc, chat_id asc
  `);
  return rows.rows.map((r) => ({
    chatId: r.chat_id,
    insightDate: r.insight_date,
    moodScore: Number(r.mood_score),
    moodLabel: r.mood_label,
    topTopic: r.top_topic,
    messageCount: Number(r.message_count),
  }));
}

/** Distinct chats that have at least one day insight (targets for per-chat roll-ups). */
export async function listChatIdsWithInsights(db: DrizzleDb): Promise<string[]> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    select distinct chat_id from chat_day_insights order by chat_id asc
  `);
  return rows.rows.map((r) => r.chat_id);
}

export interface UpsertPeriodInsight {
  granularity: PeriodGranularity;
  bucket: string;
  scope: "global" | "chat";
  chatId: string;
  wordOfPeriod: string;
  topTopic: string;
  moodScore: number;
  moodLabel: string;
  sourceDays: number;
  messageCount: number;
  model: string;
}

/** Insert or refresh one period roll-up insight. */
export async function upsertPeriodInsight(db: DrizzleDb, row: UpsertPeriodInsight): Promise<void> {
  await db
    .insert(periodInsights)
    .values(row)
    .onConflictDoUpdate({
      target: [
        periodInsights.granularity,
        periodInsights.bucket,
        periodInsights.scope,
        periodInsights.chatId,
      ],
      set: {
        wordOfPeriod: row.wordOfPeriod,
        topTopic: row.topTopic,
        moodScore: row.moodScore,
        moodLabel: row.moodLabel,
        sourceDays: row.sourceDays,
        messageCount: row.messageCount,
        model: row.model,
        computedAt: new Date(),
      },
    });
}

/** The stored roll-up for a period, or null when it has not been computed. */
export async function getPeriodInsight(
  db: DrizzleDb,
  params: { granularity: PeriodGranularity; bucket: string; scope: "global" | "chat"; chatId: string },
): Promise<UpsertPeriodInsight & { computedAt: string } | null> {
  const rows = await db.execute<{
    granularity: string;
    bucket: string;
    scope: string;
    chat_id: string;
    word_of_period: string;
    top_topic: string;
    mood_score: number;
    mood_label: string;
    source_days: number;
    message_count: number;
    model: string;
    computed_at: string;
  }>(sql`
    select * from period_insights
    where granularity = ${params.granularity}
      and bucket = ${params.bucket}
      and scope = ${params.scope}
      and chat_id = ${params.chatId}
    limit 1
  `);
  const r = rows.rows[0];
  if (!r) return null;
  return {
    granularity: r.granularity as PeriodGranularity,
    bucket: r.bucket,
    scope: r.scope as "global" | "chat",
    chatId: r.chat_id,
    wordOfPeriod: r.word_of_period,
    topTopic: r.top_topic,
    moodScore: Number(r.mood_score),
    moodLabel: r.mood_label,
    sourceDays: Number(r.source_days),
    messageCount: Number(r.message_count),
    model: r.model,
    computedAt: new Date(r.computed_at).toISOString(),
  };
}
