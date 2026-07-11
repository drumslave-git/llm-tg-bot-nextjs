import Link from "next/link";
import { Bug, ChevronRight } from "lucide-react";

import { EmptyState } from "@/components/ui";
import { formatDuration, formatTimestamp } from "@/lib/format";
import type { Trace } from "@/lib/trace";
import { TraceStatusBadge } from "./TraceStatusBadge";

/**
 * Shared trace list — a dense, scannable table of trace headers linking to the
 * detail view. Used by every feature's Debug page (scope by pre-filtering the
 * `traces` passed in). Events are omitted here; the detail view loads them.
 */
export function TraceList({
  traces,
  basePath = "/debug",
}: {
  traces: Trace[];
  /** Detail links are `${basePath}/${trace.id}`. */
  basePath?: string;
}) {
  if (traces.length === 0) {
    return (
      <EmptyState
        icon={Bug}
        title="No traces yet"
        description="Traced actions appear here as the bot and dashboard record them."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[680px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium tracking-wide text-faint uppercase">
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Feature</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Trigger</th>
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="w-8 px-2" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {traces.map((trace) => {
            const duration = formatDuration(trace.startedAt, trace.finishedAt);
            return (
              <tr
                key={trace.id}
                className="group relative cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface-hover"
              >
                <td className="px-3 py-2 align-top">
                  <TraceStatusBadge status={trace.status} />
                </td>
                <td className="px-3 py-2 align-top text-muted">{trace.feature}</td>
                <td className="px-3 py-2 align-top">
                  {/* Stretched link: covers the whole row so any cell click opens the trace. */}
                  <Link
                    href={`${basePath}/${trace.id}`}
                    className="font-medium text-foreground group-hover:text-primary after:absolute after:inset-0 focus-visible:underline focus-visible:outline-none"
                  >
                    {trace.action}
                  </Link>
                  {trace.inputSummary ? (
                    <p className="mt-0.5 max-w-xs truncate text-xs text-faint">
                      {trace.inputSummary}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top text-muted">
                  {trace.trigger.kind}
                  {trace.trigger.actor ? (
                    <span className="text-faint"> · {trace.trigger.actor}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top whitespace-nowrap text-muted">
                  {formatTimestamp(trace.startedAt)}
                </td>
                <td className="px-3 py-2 align-top text-right whitespace-nowrap text-muted">
                  {duration ?? "—"}
                </td>
                <td className="px-2 align-middle text-faint group-hover:text-primary">
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
