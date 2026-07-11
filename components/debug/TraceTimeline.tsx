import type { TraceEvent, TraceLevel } from "@/lib/trace";
import { formatTime } from "@/lib/format";
import { JsonBlock } from "./JsonBlock";

/** Event level → text colour for the timeline gutter/label. */
const LEVEL_TEXT: Record<TraceLevel, string> = {
  debug: "text-faint",
  info: "text-muted",
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
 * Shared ordered event timeline for a trace. Renders each step's type, level,
 * message, LLM usage, and structured payload. Used by every feature's Debug
 * detail view.
 */
export function TraceTimeline({ events }: { events: TraceEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-faint">No events recorded for this trace.</p>;
  }

  return (
    <ol className="space-y-3">
      {events.map((event) => (
        <li
          key={event.id}
          className="rounded-md border border-border bg-surface px-3 py-2.5"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-faint tabular-nums">
              #{event.seq}
            </span>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
              {event.type}
            </span>
            <span className={`text-sm font-medium ${LEVEL_TEXT[event.level]}`}>
              {event.message}
            </span>
            <span className="ml-auto font-mono text-xs text-faint tabular-nums">
              {formatTime(event.ts)}
            </span>
          </div>
          {event.usage ? <UsageLine usage={event.usage} /> : null}
          {event.data !== undefined && event.data !== null ? (
            <div className="mt-2">
              <JsonBlock value={event.data} />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
