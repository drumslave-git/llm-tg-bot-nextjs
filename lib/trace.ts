import { z } from "zod";

/**
 * Shared trace contract.
 *
 * Every feature records its meaningful actions as a `Trace` with ordered
 * `TraceEvent`s. This is the single schema behind every Debug page, the JSON
 * log/trace download bundle, and the dashboard status feeds. Feature code must
 * not invent its own trace shape — add event types here instead.
 *
 * These are pure types/schemas (no DB, no secrets) so they can be imported by
 * both server recording code and client debug UI. The server-only recorder and
 * persistence live under `server/trace`.
 */

/** Terminal + in-flight states shared by traces and background jobs. */
export const traceStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "error",
  "skipped",
]);
export type TraceStatus = z.infer<typeof traceStatusSchema>;

/** Severity for an individual event line. */
export const traceLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type TraceLevel = z.infer<typeof traceLevelSchema>;

/**
 * Kind of step recorded within a trace. Kept as an open-ended string union so
 * features can record domain steps, but the common cross-cutting kinds are
 * enumerated for consistent debug rendering.
 */
export const traceEventTypeSchema = z.enum([
  "step", // generic decision/step
  "input", // input received / parsed
  "output", // output produced
  "external_call", // outbound HTTP / API / tool call
  "llm_request", // LLM request metadata
  "llm_response", // LLM response + usage
  "db", // database read/write of interest
  "error", // recorded failure
]);
export type TraceEventType = z.infer<typeof traceEventTypeSchema>;

/** What or who triggered a traced action. */
export const traceTriggerSchema = z.object({
  kind: z.enum(["telegram", "dashboard", "cron", "system", "api", "test"]),
  /** Human-readable actor, e.g. chat id, user, job name. */
  actor: z.string().optional(),
  /** Correlation id linking related traces (e.g. a Telegram update id). */
  correlationId: z.string().optional(),
});
export type TraceTrigger = z.infer<typeof traceTriggerSchema>;

/** Token usage for LLM-related events. */
export const llmUsageSchema = z.object({
  model: z.string().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

/** One ordered step within a trace. */
export const traceEventSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  /** Monotonic order within the trace, starting at 0. */
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  type: traceEventTypeSchema,
  level: traceLevelSchema.default("info"),
  message: z.string(),
  /** Structured, client-safe payload for this event. */
  data: z.unknown().optional(),
  usage: llmUsageSchema.optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

/** A single meaningful action, e.g. handling one Telegram message. */
export const traceSchema = z.object({
  id: z.string(),
  feature: z.string(),
  action: z.string(),
  status: traceStatusSchema,
  trigger: traceTriggerSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
  /** Short human summary of the input. */
  inputSummary: z.string().optional(),
  /** Short human summary of the output. */
  outputSummary: z.string().optional(),
  /** Client-safe error summary when status is `error`. */
  error: z
    .object({ code: z.string().optional(), message: z.string() })
    .nullable()
    .default(null),
  /** Related database row ids by table, for operator drill-down. */
  relatedIds: z.record(z.string(), z.array(z.string())).optional(),
  events: z.array(traceEventSchema).default([]),
});
export type Trace = z.infer<typeof traceSchema>;

/** Downloadable log/trace bundle format shared by every feature's Debug page. */
export const traceBundleSchema = z.object({
  schema: z.literal("llm-tg-bot/trace-bundle@1"),
  exportedAt: z.string().datetime(),
  traces: z.array(traceSchema),
});
export type TraceBundle = z.infer<typeof traceBundleSchema>;
