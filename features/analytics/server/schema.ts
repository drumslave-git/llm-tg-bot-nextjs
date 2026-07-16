import { z } from "zod";

import { MAX_BUCKET_COUNT } from "../period";
import { GRANULARITIES, SERIES_SECTIONS } from "../types";

/**
 * Validated query shapes for the analytics Route Handlers. Kept pure (no
 * server-only import) so tests can build inputs against the same schema the
 * handlers parse.
 */

/** The filters a card carries: its period, and an optional chat/user drill-down. */
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

/** A chart card's query: the card's filters plus which series it wants. */
export const seriesQuerySchema = metricsQuerySchema.extend({
  section: z.enum(SERIES_SECTIONS),
});

export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

/** Period-insight card query: which stored roll-up to read. */
export const insightsQuerySchema = z.object({
  granularity: z.enum(GRANULARITIES).default("all"),
  /** Bucket key; defaults to the latest computed period for the scope. */
  bucket: z.string().trim().min(1).optional(),
  scope: z.enum(["global", "chat"]).default("global"),
  chatId: z.string().trim().min(1).optional(),
});

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

/**
 * Drop-and-regenerate request: which period's insights to throw away and compute
 * again. `all`/`all` wipes every stored insight and re-scores the whole history.
 */
export const regenerateSchema = z.object({
  granularity: z.enum(GRANULARITIES),
  /** Bucket key at that granularity (`2026-07-16`, `2026-07`, `2026`, or `all`). */
  bucket: z.string().trim().min(1),
});

export type RegenerateInput = z.infer<typeof regenerateSchema>;
