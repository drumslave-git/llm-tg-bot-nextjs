import { z } from "zod";

import { MAX_BUCKET_COUNT } from "../period";
import { GRANULARITIES } from "../types";

/**
 * Validated query shapes for the analytics Route Handlers. Kept pure (no
 * server-only import) so tests can build inputs against the same schema the
 * handlers parse.
 */

/** Numeric-metrics query: which granularity, and an optional chat/user filter. */
export const metricsQuerySchema = z.object({
  granularity: z.enum(GRANULARITIES).default("day"),
  /** Restrict to one chat (Telegram chat id). */
  chatId: z.string().trim().min(1).optional(),
  /** Restrict to one user's own messages (Telegram user id). */
  userId: z.string().trim().min(1).optional(),
  /** Override the default bucket count for the granularity. */
  count: z.coerce.number().int().positive().max(MAX_BUCKET_COUNT).optional(),
});

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

/** Period-insight card query: which stored roll-up to read. */
export const insightsQuerySchema = z.object({
  granularity: z.enum(["month", "year", "all"]).default("all"),
  /** Bucket key (`YYYY-MM` / `YYYY` / `all`); defaults to the current period. */
  bucket: z.string().trim().min(1).optional(),
  scope: z.enum(["global", "chat"]).default("global"),
  chatId: z.string().trim().min(1).optional(),
});

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;
