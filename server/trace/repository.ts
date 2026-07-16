import "server-only";

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { traceEvents, traces, type TraceEventRow, type TraceRow } from "@/db/schema";
import type { Trace, TraceEvent, TraceStatus, TraceTrigger } from "@/lib/trace";

/**
 * Persistence for the shared trace contract via Drizzle. Pure data access: no
 * policy, no secrets. Every function takes a {@link DrizzleDb} so it runs
 * against the pool or a test instance.
 */

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

function mapEventRow(row: TraceEventRow): TraceEvent {
  return {
    id: row.id,
    traceId: row.traceId,
    seq: row.seq,
    ts: row.ts.toISOString(),
    type: row.type as TraceEvent["type"],
    level: row.level as TraceEvent["level"],
    message: row.message,
    data: row.data ?? undefined,
    usage: row.usage ?? undefined,
  };
}

function mapTraceRow(row: TraceRow, events: TraceEvent[]): Trace {
  return {
    id: row.id,
    feature: row.feature,
    action: row.action,
    status: row.status as TraceStatus,
    trigger: {
      kind: row.triggerKind as TraceTrigger["kind"],
      actor: row.triggerActor ?? undefined,
      correlationId: row.correlationId ?? undefined,
    },
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    inputSummary: row.inputSummary ?? undefined,
    outputSummary: row.outputSummary ?? undefined,
    error: row.error ?? null,
    relatedIds: row.relatedIds ?? undefined,
    events,
  };
}

export interface InsertTraceInput {
  id: string;
  feature: string;
  action: string;
  status: TraceStatus;
  trigger: TraceTrigger;
  startedAt: string;
  inputSummary?: string;
}

export async function insertTrace(db: DrizzleDb, input: InsertTraceInput): Promise<void> {
  await db.insert(traces).values({
    id: input.id,
    feature: input.feature,
    action: input.action,
    status: input.status,
    triggerKind: input.trigger.kind,
    triggerActor: input.trigger.actor ?? null,
    correlationId: input.trigger.correlationId ?? null,
    inputSummary: input.inputSummary ?? null,
    startedAt: new Date(input.startedAt),
  });
}

export interface FinishTraceInput {
  status: TraceStatus;
  finishedAt: string;
  outputSummary?: string;
  error?: Trace["error"];
  relatedIds?: Record<string, string[]>;
  /** Replaces the correlation the trace opened with; see `recorder.ts`. */
  correlationId?: string;
}

export async function finishTrace(
  db: DrizzleDb,
  id: string,
  input: FinishTraceInput,
): Promise<void> {
  await db
    .update(traces)
    .set({
      status: input.status,
      finishedAt: new Date(input.finishedAt),
      error: input.error ?? null,
      relatedIds: input.relatedIds ?? null,
      // Only overwrite the summary when a new one is provided.
      ...(input.outputSummary !== undefined
        ? { outputSummary: input.outputSummary }
        : {}),
      // Likewise the correlation: only an action that learned it by acting
      // settles with one, and it must not clear what `startTrace` set.
      ...(input.correlationId !== undefined
        ? { correlationId: input.correlationId }
        : {}),
    })
    .where(eq(traces.id, id));
}

export async function insertEvent(db: DrizzleDb, event: TraceEvent): Promise<void> {
  await db.insert(traceEvents).values({
    id: event.id,
    traceId: event.traceId,
    seq: event.seq,
    ts: new Date(event.ts),
    type: event.type,
    level: event.level,
    message: event.message,
    data: event.data ?? null,
    usage: event.usage ?? null,
  });
}

/** Full trace with ordered events, or null if not found. */
export async function getTrace(db: DrizzleDb, id: string): Promise<Trace | null> {
  const row = await db.query.traces.findFirst({ where: eq(traces.id, id) });
  if (!row) return null;

  const events = await db.query.traceEvents.findMany({
    where: eq(traceEvents.traceId, id),
    orderBy: (t, { asc }) => [asc(t.seq)],
  });
  return mapTraceRow(row, events.map(mapEventRow));
}

export interface ListTracesInput {
  feature?: string;
  status?: TraceStatus;
  limit?: number;
  offset?: number;
}

export interface ListTracesResult {
  /** Trace headers, newest first. Events are omitted for list performance. */
  traces: Trace[];
  total: number;
}

/** List trace headers (without events), newest first, with total count. */
export async function listTraces(
  db: DrizzleDb,
  input: ListTracesInput = {},
): Promise<ListTracesResult> {
  const filters: SQL[] = [];
  if (input.feature) filters.push(eq(traces.feature, input.feature));
  if (input.status) filters.push(eq(traces.status, input.status));
  const where = filters.length ? and(...filters) : undefined;

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(traces)
    .where(where);

  // An undefined limit returns every matching trace (the Debug list is not
  // paginated — MVP capped at 50; the operator wants the full history). Callers
  // that must bound the result (e.g. bundle export) pass an explicit limit.
  const base = db.select().from(traces).where(where).orderBy(desc(traces.startedAt)).$dynamic();
  const rows =
    input.limit !== undefined
      ? await base.limit(Math.max(input.limit, 1)).offset(Math.max(input.offset ?? 0, 0))
      : await base;

  return {
    traces: rows.map((row) => mapTraceRow(row, [])),
    total: count,
  };
}

/** Distinct feature names that have recorded traces, alphabetically. Powers the Debug filter. */
export async function listFeatures(db: DrizzleDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ feature: traces.feature })
    .from(traces)
    .orderBy(traces.feature);
  return rows.map((row) => row.feature);
}

/**
 * Ordered events for many traces in one query, grouped by trace id. Used to
 * assemble a download bundle without an N+1 per-trace fetch.
 */
export async function getEventsForTraces(
  db: DrizzleDb,
  ids: string[],
): Promise<Map<string, TraceEvent[]>> {
  const grouped = new Map<string, TraceEvent[]>();
  if (ids.length === 0) return grouped;

  const rows = await db
    .select()
    .from(traceEvents)
    .where(inArray(traceEvents.traceId, ids))
    .orderBy(traceEvents.traceId, traceEvents.seq);

  for (const row of rows) {
    const event = mapEventRow(row);
    const list = grouped.get(event.traceId);
    if (list) list.push(event);
    else grouped.set(event.traceId, [event]);
  }
  return grouped;
}

/**
 * Latest trace id for each of the given correlation ids, in one query. Powers
 * "jump to the trace that handled this message" links from other features — a
 * trace's correlation id is `${chatId}:${messageId}`. When several traces share
 * a correlation id, only the most recent is returned.
 *
 * A correlation id is **not** unique to one feature: several features key a
 * trace on the same message (a reply, an edit of it, feedback collected on it).
 * Pass `features` when you want the trace of a *particular* kind of action
 * rather than whichever touched the message last.
 */
export async function getLatestTraceIdsByCorrelation(
  db: DrizzleDb,
  correlationIds: string[],
  options: { features?: string[] } = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(correlationIds.filter(Boolean))];
  if (unique.length === 0) return result;

  const rows = await db
    .select({ id: traces.id, correlationId: traces.correlationId })
    .from(traces)
    .where(
      options.features?.length
        ? and(inArray(traces.correlationId, unique), inArray(traces.feature, options.features))
        : inArray(traces.correlationId, unique),
    )
    .orderBy(desc(traces.startedAt));

  for (const row of rows) {
    if (row.correlationId && !result.has(row.correlationId)) {
      result.set(row.correlationId, row.id);
    }
  }
  return result;
}
