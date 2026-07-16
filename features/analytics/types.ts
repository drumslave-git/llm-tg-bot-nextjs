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
export type Granularity = "day" | "week" | "month" | "year" | "all";

export const GRANULARITIES: Granularity[] = ["day", "week", "month", "year", "all"];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  all: "All time",
};

/** The LLM-derived insight is stored at every granularity. */
export type PeriodGranularity = Granularity;

/**
 * One kind of request made to a model, identified by the trace `feature`/`action`
 * that issued it — `vision`/`describe`, `bot-messaging`/`reply`,
 * `history-summaries`/`summarize`, and so on.
 *
 * This is the level latency is meaningful at. Describing an image, generating a
 * reply through a tool loop, and answering a one-line auxiliary prompt are
 * different workloads with different shapes, and a single per-model average of them
 * mostly reports which mix happened to run.
 */
export interface RequestTypeStat {
  /** Trace feature id — `featureLabel()` turns it into a human name. */
  feature: string;
  /** Trace action, e.g. `reply`, `describe`, `summarize`. */
  action: string;
  /** Completions counted. */
  calls: number;
  /** Mean end-to-end latency in ms. */
  avgLatencyMs: number;
  /** Median latency in ms — the typical call. Null when no call reported latency. */
  latencyP50: number | null;
  /** 95th-percentile latency in ms — the slow tail. Null when no call reported latency. */
  latencyP95: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Completion tokens per second of latency, or null when latency is unknown. */
  tokensPerSec: number | null;
}

/**
 * One model's total usage, broken down by request type.
 *
 * The model level deliberately carries no latency average: it would be a mean over
 * unlike request types. It carries volume (calls, tokens) and throughput —
 * a ratio of sums, which stays well-defined across a mix. Latency lives on
 * {@link requestTypes}.
 */
export interface ModelStat {
  /** Clean model name (registry prefixes stripped). */
  model: string;
  /** Completions counted, across every request type. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Completion tokens per second of latency, or null when latency is unknown. */
  tokensPerSec: number | null;
  /** This model's request types, busiest first. */
  requestTypes: RequestTypeStat[];
}

/**
 * Deterministic bot-health signals (no LLM), over all history.
 *
 * Every field here is a measurement with an agreed meaning. There is deliberately
 * no composite "health score": rolling satisfaction, error rate, and latency into
 * one number requires inventing weights and thresholds nobody agreed on, so the
 * result looks authoritative while encoding an opinion. Active users and the raw
 * reaction count are absent too — they are reported by the Users tile and by
 * satisfaction respectively, and a second copy just invites the two to disagree.
 */
export interface HealthSignals {
  /** 👍 / 👎 reaction counts on the bot's replies — the basis of `satisfaction`. */
  feedbackUp: number;
  feedbackDown: number;
  /** up / (up + down), or null when there is no feedback yet. */
  satisfaction: number | null;
  /** Failed bot-messaging traces / total, or null when there is no traffic. */
  errorRate: number | null;
  botTraces: number;
  botErrors: number;
  /** Mean latency (ms) of a bot reply's LLM calls, or null when there are none. */
  avgReplyLatencyMs: number | null;
}

/** One user's activity within the window. */
export interface UserStat {
  userId: string;
  label: string;
  messages: number;
  /** Prompt tokens attributed to this user's turns. */
  tokens: number;
}

/** Which chat/user the reader asked for. */
export type MetricScopeKind = "global" | "chat" | "user";

/**
 * The filters one card carries. Every card owns its own set — the dashboard has no
 * single global filter, so two cards can show different periods side by side (this
 * week's mood next to the year's token trend) without one clobbering the other.
 */
export interface CardFilters {
  granularity: Granularity;
  chatId: string | null;
  userId: string | null;
}

/** Everything a card's response carries about *what it is*, echoed back from the filters. */
export interface MetricContext {
  granularity: Granularity;
  timezone: string;
  scope: MetricScopeKind;
  chatId: string | null;
  userId: string | null;
}

/** Which time series a chart card is asking for. */
export type SeriesSection = "volume" | "tokens" | "users" | "mood";

export const SERIES_SECTIONS: SeriesSection[] = ["volume", "tokens", "users", "mood"];

/**
 * One line on a chart. `null` is a real gap (no data for that bucket), which is
 * not the same as `0` — an unscored day has no mood, it does not have a mood of 0.
 */
export interface NamedSeries {
  name: string;
  data: (number | null)[];
}

/** A chart card's payload: the dense bucket axis plus its lines. */
export interface SeriesPayload extends MetricContext {
  section: SeriesSection;
  /** Bucket labels, oldest → newest. Every series' data is aligned to this. */
  buckets: string[];
  series: NamedSeries[];
  /** Fixed y-axis maximum where the metric has one (mood is 0–100). */
  yMax?: number;
}

/** The traffic tiles' payload. */
export interface TotalsPayload extends MetricContext {
  totals: {
    messages: number;
    humanMessages: number;
    botMessages: number;
    tokensProcessed: number;
    tokensGenerated: number;
    activeUsers: number;
    media: number;
  };
}

/**
 * The unfiltered, system-level cards: bot health, model performance, top users.
 * These cover **all history** and take no period or chat/user filter — they
 * describe the bot itself rather than a slice of conversation.
 */
export interface SystemStats {
  health: HealthSignals;
  models: ModelStat[];
  topUsers: UserStat[];
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
  /**
   * Per-granularity, the buckets that hold scored days — what "Regenerate" can be
   * pointed at. Empty lists mean there is nothing stored to drop.
   */
  regenerateBuckets: Record<Granularity, string[]>;
}
