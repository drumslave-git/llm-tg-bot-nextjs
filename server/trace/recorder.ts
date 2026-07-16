import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { isApiError } from "@/lib/api-error";
import type {
  LlmUsage,
  Trace,
  TraceEvent,
  TraceEventType,
  TraceLevel,
  TraceTrigger,
} from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { finishTrace, insertEvent, insertTrace } from "./repository";

/**
 * Trace recorder — the single entry point features use to record a meaningful
 * action. Persists a `running` trace up front, appends ordered events, and
 * settles once as `success`/`error`/`skipped`. Ids are generated in app code so
 * the schema stays extension-free and portable.
 *
 * Traces are operator-facing debug data (never returned to end users), so full
 * error messages are recorded for debugging — including the `cause` chain, which
 * is where wrapped failures keep the part that actually explains them.
 */

export interface StartTraceInput {
  feature: string;
  action: string;
  trigger: TraceTrigger;
  inputSummary?: string;
}

export interface EventInput {
  message: string;
  type?: TraceEventType;
  level?: TraceLevel;
  data?: unknown;
  usage?: LlmUsage;
}

export interface FinishInput {
  outputSummary?: string;
  relatedIds?: Record<string, string[]>;
  /**
   * Correlation to settle with, for an action that only *learns* its correlation
   * by acting. A proactive send has no incoming message to key on at
   * `startTrace` — it knows its `<chatId>:<messageId>` only once Telegram accepts
   * the message — so it opens on what it has and settles on what it delivered.
   * Omitted → the correlation given at `startTrace` stands.
   */
  correlationId?: string;
}

export interface TraceRecorder {
  readonly id: string;
  /** Append an ordered event to the trace. */
  event(input: EventInput): Promise<TraceEvent>;
  /** Settle the trace as successful. */
  succeed(input?: FinishInput): Promise<void>;
  /** Settle the trace as skipped (nothing to do / short-circuited). */
  skip(reason?: string, input?: FinishInput): Promise<void>;
  /** Settle the trace as failed, recording the error in the timeline. */
  fail(error: unknown, input?: FinishInput): Promise<void>;
}

/**
 * Depth cap on the cause chain — enough for the deepest real wrapping (a driver
 * error inside an ORM error inside an `ApiError`), and a guard against a cyclic
 * `cause` looping forever.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * An error's message followed by its `cause` chain. The top-level message is
 * often the least useful part of a wrapped failure — Drizzle reports
 * `Failed query: insert into …` and puts the reason (`column "x" does not
 * exist`) in `cause`, so recording only the message tells an operator what ran
 * but never why it failed.
 */
function toErrorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    // A wrapper that just restates its cause adds nothing to the timeline.
    if (message && !parts.includes(message)) parts.push(message);
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  return parts.join("\ncaused by: ") || String(error);
}

function toTraceError(error: unknown): NonNullable<Trace["error"]> {
  const message = toErrorMessage(error);
  if (isApiError(error)) return { code: error.code, message };
  return { message };
}

/**
 * Begin recording a trace. Defaults to the shared Drizzle db but accepts any
 * {@link DrizzleDb} for tests/transactions.
 */
export async function startTrace(
  input: StartTraceInput,
  db: DrizzleDb = getDb(),
): Promise<TraceRecorder> {
  const id = randomUUID();
  const startedAt = new Date().toISOString();

  await insertTrace(db, {
    id,
    feature: input.feature,
    action: input.action,
    status: "running",
    trigger: input.trigger,
    startedAt,
    inputSummary: input.inputSummary,
  });
  // Notify live dashboards: a new (running) trace exists.
  publishEvent("traces", { feature: input.feature });

  let seq = 0;
  let settled = false;

  /** Notify live dashboards that this trace changed (settled). */
  const notify = () => publishEvent("traces", { feature: input.feature });

  async function appendEvent(input: EventInput): Promise<TraceEvent> {
    const event: TraceEvent = {
      id: randomUUID(),
      traceId: id,
      seq: seq++,
      ts: new Date().toISOString(),
      type: input.type ?? "step",
      level: input.level ?? "info",
      message: input.message,
      data: input.data,
      usage: input.usage,
    };
    await insertEvent(db, event);
    // Notify live dashboards so an open trace's detail view streams entries in
    // as they are recorded, not only when the trace settles.
    notify();
    return event;
  }

  function ensureOpen(): void {
    if (settled) {
      throw new Error(`Trace ${id} is already settled`);
    }
  }

  return {
    id,
    async event(eventInput) {
      ensureOpen();
      return appendEvent(eventInput);
    },
    async succeed(finish) {
      ensureOpen();
      settled = true;
      await finishTrace(db, id, {
        status: "success",
        finishedAt: new Date().toISOString(),
        outputSummary: finish?.outputSummary,
        relatedIds: finish?.relatedIds,
        correlationId: finish?.correlationId,
      });
      notify();
    },
    async skip(reason, finish) {
      ensureOpen();
      if (reason) await appendEvent({ type: "step", message: reason });
      settled = true;
      await finishTrace(db, id, {
        status: "skipped",
        finishedAt: new Date().toISOString(),
        outputSummary: finish?.outputSummary ?? reason,
        relatedIds: finish?.relatedIds,
        correlationId: finish?.correlationId,
      });
      notify();
    },
    async fail(error, finish) {
      ensureOpen();
      const traceError = toTraceError(error);
      await appendEvent({ type: "error", level: "error", message: traceError.message });
      settled = true;
      await finishTrace(db, id, {
        status: "error",
        finishedAt: new Date().toISOString(),
        outputSummary: finish?.outputSummary,
        error: traceError,
        relatedIds: finish?.relatedIds,
        correlationId: finish?.correlationId,
      });
      notify();
    },
  };
}
