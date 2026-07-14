import Link from "next/link";
import { Bug, ChevronRight } from "lucide-react";

import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { formatDuration } from "@/lib/format";
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
    <Table minWidth={680}>
      <TableHead>
        <TableRow header>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Feature</TableHeaderCell>
          <TableHeaderCell>Action</TableHeaderCell>
          <TableHeaderCell>Trigger</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell align="right">Duration</TableHeaderCell>
          <TableHeaderCell className="w-8 px-2" aria-hidden />
        </TableRow>
      </TableHead>
      <TableBody>
        {traces.map((trace) => {
          const duration = formatDuration(trace.startedAt, trace.finishedAt);
          return (
            <TableRow key={trace.id} interactive>
              <TableCell>
                <TraceStatusBadge status={trace.status} />
              </TableCell>
              <TableCell className="text-muted">{trace.feature}</TableCell>
              <TableCell>
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
              </TableCell>
              <TableCell className="text-muted">
                {trace.trigger.kind}
                {trace.trigger.actor ? (
                  <span className="text-faint"> · {trace.trigger.actor}</span>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted">
                <Timestamp iso={trace.startedAt} />
              </TableCell>
              <TableCell align="right" className="whitespace-nowrap text-muted">
                {duration ?? "—"}
              </TableCell>
              <TableCell valign="middle" className="px-2 text-faint group-hover:text-primary">
                <ChevronRight className="h-4 w-4" aria-hidden />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
