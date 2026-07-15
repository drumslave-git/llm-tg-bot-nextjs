/**
 * Client-safe analytics types — shared by the server services (the trace/metric
 * writers) and the dashboard UI (the readers). Pure: no server-only *runtime*
 * import (the one type import below is erased), so a Client Component can use them.
 */

import type { IntervalJobStatus } from "@/server/jobs/interval-scheduler";

/**
 * The period selector — the same options everywhere (numeric charts, word of the
 * period, top topic, mood). `all` collapses all history into a single bucket.
 */
export type Granularity = "day" | "week" | "month" | "all";

export const GRANULARITIES: Granularity[] = ["day", "week", "month", "all"];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  all: "All time",
};

/** How the insight card names the period, per granularity. */
export const PERIOD_NOUN: Record<Granularity, string> = {
  day: "day",
  week: "week",
  month: "month",
  all: "all time",
};

/** The LLM-derived insight is stored at every granularity. */
export type PeriodGranularity = Granularity;

/** Per-model speed + token volume, across all chats (system-level). */
export interface ModelStat {
  /** Clean model name (registry prefixes stripped). */
  model: string;
  /** Completions counted. */
  calls: number;
  /** Mean end-to-end latency in ms. */
  avgLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Completion tokens per second of latency, or null when latency is unknown. */
  tokensPerSec: number | null;
}

/** Deterministic chat-health signals (no LLM). */
export interface HealthSignals {
  /** 👍 / 👎 reaction counts on the bot's replies. */
  feedbackUp: number;
  feedbackDown: number;
  /** up / (up + down), or null when there is no feedback yet. */
  satisfaction: number | null;
  /** Failed bot-messaging traces / total, or null when there is no traffic. */
  errorRate: number | null;
  botTraces: number;
  botErrors: number;
  /** Mean reply latency (ms) across LLM responses, or null when none. */
  avgReplyLatencyMs: number | null;
  /** Distinct human senders in the window. */
  activeUsers: number;
  /** Human messages in the window. */
  messages: number;
  /** Composite 0–100 health score from the available sub-signals, or null. */
  score: number | null;
}

/** One user's activity within the window. */
export interface UserStat {
  userId: string;
  label: string;
  messages: number;
  /** Prompt tokens attributed to this user's turns. */
  tokens: number;
}

/** The full numeric metrics payload the dashboard charts render. */
export interface AnalyticsMetrics {
  granularity: Granularity;
  timezone: string;
  scope: "global" | "chat" | "user";
  chatId: string | null;
  userId: string | null;
  /** Bucket labels, oldest → newest. All value arrays are aligned to this. */
  buckets: string[];
  volume: { human: number[]; bot: number[] };
  /** LLM tokens per bucket: processed = prompt, generated = completion. */
  tokens: { processed: number[]; generated: number[] };
  /** `new` is null when a chat/user filter is set (new-user counts are global). */
  users: { active: number[]; new: number[] | null };
  totals: {
    messages: number;
    humanMessages: number;
    botMessages: number;
    tokensProcessed: number;
    tokensGenerated: number;
    activeUsers: number;
    media: number;
  };
  models: ModelStat[];
  topUsers: UserStat[];
  health: HealthSignals;
}

/** One bucket's mood point, for the mood trend chart (at the selected granularity). */
export interface MoodPoint {
  bucket: string;
  moodScore: number;
  moodLabel: string;
}

/** The LLM-derived insight for a selected period (mood + word of the period + topic). */
export interface PeriodInsight {
  granularity: PeriodGranularity;
  bucket: string;
  scope: "global" | "chat";
  chatId: string | null;
  wordOfPeriod: string;
  topTopic: string;
  moodScore: number;
  moodLabel: string;
  sourceDays: number;
  messageCount: number;
  model: string;
  computedAt: string;
}

/** Status + backlog info for the analytics insight job's dashboard card. */
export interface AnalyticsJobInfo {
  status: IntervalJobStatus;
  /** ISO time of the next daily run, or null when the run time is invalid. */
  nextRunAt: string | null;
  /** Configured local run time (`HH:MM`) and the timezone it is read in. */
  runTime: string;
  timezone: string;
  /** Outcome of the last actual run, or null when it has never run. */
  lastResult: { at: string; summary: string } | null;
  /** Days still awaiting an insight — the visible backlog. */
  pendingDays: number;
  /** Whether an LLM is configured (else the job settles as a no-op). */
  llmConfigured: boolean;
}
