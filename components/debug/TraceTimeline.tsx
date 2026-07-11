import type { TraceEvent, TraceEventType, TraceLevel } from "@/lib/trace";
import { formatDuration, formatTime } from "@/lib/format";
import { JsonBlock } from "./JsonBlock";

/**
 * Event type → human category shown in the leading badge. Groups the raw event
 * kinds into the stage they belong to (e.g. `llm_request`/`llm_response` both
 * read as `llm`) so the badge names a phase, not an implementation type.
 */
const TYPE_CATEGORY: Record<TraceEventType, string> = {
  input: "input",
  step: "pre-processing",
  llm_request: "llm",
  llm_response: "llm",
  external_call: "external",
  db: "db",
  output: "output",
  error: "error",
};

/** Event level → leading status dot colour. */
const LEVEL_DOT: Record<TraceLevel, string> = {
  debug: "bg-faint",
  info: "bg-info",
  success: "bg-success",
  warn: "bg-warning",
  error: "bg-danger",
};

/** Event level → message text colour (neutral unless it needs attention). */
const LEVEL_TEXT: Record<TraceLevel, string> = {
  debug: "text-faint",
  info: "text-foreground",
  success: "text-foreground",
  warn: "text-warning",
  error: "text-danger",
};

/** Small usage summary chip line for LLM events. */
function UsageLine({ usage }: { usage: NonNullable<TraceEvent["usage"]> }) {
  const parts: string[] = [];
  if (usage.model) parts.push(usage.model);
  if (usage.promptTokens !== undefined) parts.push(`prompt ${usage.promptTokens}`);
  if (usage.completionTokens !== undefined) parts.push(`completion ${usage.completionTokens}`);
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
  if (usage.latencyMs !== undefined) parts.push(`${Math.round(usage.latencyMs)}ms`);
  if (parts.length === 0) return null;
  return <p className="mt-1 font-mono text-xs text-info">{parts.join(" · ")}</p>;
}

/**
 * Shared ordered event timeline for a trace. Each step shows its type, level,
 * message, how long it took (elapsed since the previous step — so a response
 * shows the request's latency), LLM usage, and its full request/response body in
 * a collapsible JSON viewer. Used by every feature's Debug detail view.
 */
export function TraceTimeline({
  events,
  startedAt,
}: {
  events: TraceEvent[];
  /** Trace start, used as the baseline for the first step's elapsed time. */
  startedAt: string;
}) {
  if (events.length === 0) {
    return <p className="text-sm text-faint">No events recorded for this trace.</p>;
  }

  return (
    <ol className="space-y-3">
      {events.map((event, index) => {
        const previousTs = index === 0 ? startedAt : events[index - 1].ts;
        const took = formatDuration(previousTs, event.ts);
        return (
          <li key={event.id} className="rounded-md border border-border bg-surface px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${LEVEL_DOT[event.level]}`}
                aria-hidden
              />
              <span className="font-mono text-xs text-faint tabular-nums">#{event.seq}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
                {TYPE_CATEGORY[event.type]}
              </span>
              <span className={`text-sm font-medium ${LEVEL_TEXT[event.level]}`}>
                {event.message}
              </span>
              <span className="ml-auto flex items-center gap-2 font-mono text-xs text-faint tabular-nums">
                {took ? <span title="Time since previous step">+{took}</span> : null}
                <span>{formatTime(event.ts)}</span>
              </span>
            </div>
            {event.usage ? <UsageLine usage={event.usage} /> : null}
            {event.data !== undefined && event.data !== null ? (
              <div className="mt-2">
                <JsonBlock value={event.data} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
