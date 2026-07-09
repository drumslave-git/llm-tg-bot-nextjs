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
import { finishTrace, insertEvent, insertTrace } from "./repository";

/**
 * Trace recorder — the single entry point features use to record a meaningful
 * action. Persists a `running` trace up front, appends ordered events, and
 * settles once as `success`/`error`/`skipped`. Ids are generated in app code so
 * the schema stays extension-free and portable.
 *
 * Traces are operator-facing debug data (never returned to end users), so full
 * error messages are recorded for debugging.
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

function toTraceError(error: unknown): NonNullable<Trace["error"]> {
  if (isApiError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
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

  let seq = 0;
  let settled = false;

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
      });
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
      });
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
      });
    },
  };
}
