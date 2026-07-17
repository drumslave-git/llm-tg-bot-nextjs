import "server-only";

import { getDb, type DrizzleDb } from "@/db/drizzle";
import { llmUsage, traceFacts, type LlmUsageInsert } from "@/db/schema";
import type { TraceEvent, TraceStatus, TraceTrigger } from "@/lib/trace";

/**
 * Compact analytics facts distilled from a settled trace and written to Postgres.
 *
 * Full trace bodies live in the file-backed store; only these queryable facts are
 * kept in the DB so the Analytics dashboard can aggregate tokens, per-model speed,
 * per-user tokens, and bot reliability live. One `trace_facts` row per trace, plus
 * one `llm_usage` row per usage-bearing `llm_response` event.
 *
 * Best-effort by contract: a facts-write failure must never break the traced
 * action, and when no database is configured (Docker-free unit tests) it is a
 * no-op, so the file store works without a DB.
 */

export interface RecordTraceFactsInput {
  id: string;
  feature: string;
  action: string;
  status: TraceStatus;
  /** The final trigger (its `correlationId` may have been resolved at settle). */
  trigger: TraceTrigger;
  startedAt: string;
  finishedAt: string;
  /** Every event recorded on the trace; the usage-bearing ones become `llm_usage` rows. */
  events: TraceEvent[];
}

/** Whether a database is configured at all — env is bootstrap plumbing here. */
function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);
}

export async function recordTraceFacts(
  input: RecordTraceFactsInput,
  db?: DrizzleDb,
): Promise<void> {
  // Guard first: resolving the pool eagerly (e.g. a default arg) would throw in
  // Docker-free unit tests where no DATABASE_URL is set.
  if (!hasDatabase()) return;
  const database = db ?? getDb();
  const startedAt = new Date(input.startedAt);
  const correlationId = input.trigger.correlationId ?? null;
  const triggerActor = input.trigger.actor ?? null;

  const usageRows: LlmUsageInsert[] = input.events
    .filter((e) => e.type === "llm_response" && e.usage != null)
    .map((e) => ({
      id: e.id,
      traceId: input.id,
      feature: input.feature,
      action: input.action,
      triggerActor,
      correlationId,
      model: e.usage!.model ?? null,
      servedModel: e.usage!.servedModel ?? null,
      promptTokens: e.usage!.promptTokens ?? null,
      completionTokens: e.usage!.completionTokens ?? null,
      totalTokens: e.usage!.totalTokens ?? null,
      latencyMs: e.usage!.latencyMs ?? null,
      startedAt,
    }));

  try {
    await database.insert(traceFacts).values({
      id: input.id,
      feature: input.feature,
      action: input.action,
      status: input.status,
      triggerActor,
      correlationId,
      startedAt,
      finishedAt: new Date(input.finishedAt),
    });
    if (usageRows.length > 0) await database.insert(llmUsage).values(usageRows);
  } catch (err) {
    // Analytics facts are best-effort — never break the traced action on a DB hiccup.
    console.error(`Failed to record trace facts for ${input.id}:`, err);
  }
}
