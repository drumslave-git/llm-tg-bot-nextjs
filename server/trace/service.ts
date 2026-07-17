import "server-only";

import { ApiError } from "@/lib/api-error";
import type { Trace, TraceBundle, TraceStatus } from "@/lib/trace";
import { getEventsForTraces, getTrace, listFeatures, listTraces } from "./store";

/**
 * Shared Debug service — the single boundary the Debug pages and the
 * `app/api/traces/**` handlers call to read traces. The store stays pure
 * state/IO/queries; this layer owns defaults, not-found mapping, and bundle
 * assembly so every feature's Debug view behaves identically.
 */

/** Hard cap on a single downloadable bundle so an export can't page the whole store. */
const BUNDLE_MAX = 500;

export interface TraceQuery {
  feature?: string;
  status?: TraceStatus;
  limit?: number;
  offset?: number;
}

export interface TraceListView {
  /** Trace headers (no events), newest first. Not capped by default. */
  traces: Trace[];
  /** Total matching the filter. */
  total: number;
  /** Distinct feature names for the filter dropdown. */
  features: string[];
}

/**
 * Trace headers (all matching the filter, newest first) plus the feature list
 * that powers the Debug filter. The Debug list is intentionally uncapped — pass
 * an explicit `limit` only for a bounded/programmatic read.
 */
export async function getTraceList(query: TraceQuery = {}): Promise<TraceListView> {
  const [page, features] = await Promise.all([listTraces(query), listFeatures()]);
  return { traces: page.traces, total: page.total, features };
}

/** Full trace with ordered events, or a `not_found` ApiError. */
export async function getTraceDetail(id: string): Promise<Trace> {
  const trace = await getTrace(id);
  if (!trace) throw ApiError.notFound(`Trace ${id} not found`);
  return trace;
}

const bundle = (traces: Trace[]): TraceBundle => ({
  schema: "llm-tg-bot/trace-bundle@1",
  exportedAt: new Date().toISOString(),
  traces,
});

/** Downloadable bundle for a single trace (with its events). */
export async function buildTraceBundle(id: string): Promise<TraceBundle> {
  return bundle([await getTraceDetail(id)]);
}

/**
 * Downloadable bundle for a filtered set of traces, each with its events. Capped
 * at {@link BUNDLE_MAX} newest matches; events are fetched in one grouped query.
 */
export async function buildTraceListBundle(query: TraceQuery = {}): Promise<TraceBundle> {
  const { traces: headers } = await listTraces({ ...query, limit: BUNDLE_MAX, offset: 0 });
  const events = await getEventsForTraces(headers.map((t) => t.id));
  const full = headers.map((header) => ({ ...header, events: events.get(header.id) ?? [] }));
  return bundle(full);
}
