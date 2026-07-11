import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { ApiError } from "@/lib/api-error";
import type { Trace, TraceBundle, TraceStatus } from "@/lib/trace";
import {
  getEventsForTraces,
  getTrace,
  listFeatures,
  listTraces,
} from "./repository";

/**
 * Shared Debug service — the single boundary the Debug pages and the
 * `app/api/traces/**` handlers call to read traces. Repositories stay pure data
 * access; this layer owns defaults, not-found mapping, and bundle assembly so
 * every feature's Debug view behaves identically.
 */

/** Hard cap on a single downloadable bundle so an export can't page the whole table. */
const BUNDLE_MAX = 500;

export interface TraceQuery {
  feature?: string;
  status?: TraceStatus;
  limit?: number;
  offset?: number;
}

export interface TraceListView {
  /** Trace headers (no events), newest first. */
  traces: Trace[];
  /** Total matching the filter, for pagination. */
  total: number;
  /** Distinct feature names for the filter dropdown. */
  features: string[];
  limit: number;
  offset: number;
}

/** Paginated trace headers plus the feature list that powers the Debug filter. */
export async function getTraceList(
  query: TraceQuery = {},
  db: DrizzleDb = getDb(),
): Promise<TraceListView> {
  const [page, features] = await Promise.all([
    listTraces(db, query),
    listFeatures(db),
  ]);
  return {
    traces: page.traces,
    total: page.total,
    features,
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
  };
}

/** Full trace with ordered events, or a `not_found` ApiError. */
export async function getTraceDetail(id: string, db: DrizzleDb = getDb()): Promise<Trace> {
  const trace = await getTrace(db, id);
  if (!trace) throw ApiError.notFound(`Trace ${id} not found`);
  return trace;
}

const bundle = (traces: Trace[]): TraceBundle => ({
  schema: "llm-tg-bot/trace-bundle@1",
  exportedAt: new Date().toISOString(),
  traces,
});

/** Downloadable bundle for a single trace (with its events). */
export async function buildTraceBundle(
  id: string,
  db: DrizzleDb = getDb(),
): Promise<TraceBundle> {
  return bundle([await getTraceDetail(id, db)]);
}

/**
 * Downloadable bundle for a filtered set of traces, each with its events. Capped
 * at {@link BUNDLE_MAX} newest matches; events are fetched in one grouped query.
 */
export async function buildTraceListBundle(
  query: TraceQuery = {},
  db: DrizzleDb = getDb(),
): Promise<TraceBundle> {
  const { traces: headers } = await listTraces(db, { ...query, limit: BUNDLE_MAX, offset: 0 });
  const events = await getEventsForTraces(
    db,
    headers.map((t) => t.id),
  );
  const full = headers.map((header) => ({ ...header, events: events.get(header.id) ?? [] }));
  return bundle(full);
}
