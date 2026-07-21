"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { cn } from "@/lib/cn";
import { Globe } from "lucide-react";

import type { BrowserAgentRun, BrowserAgentRunDetail } from "../types";
import { runStatusBadge } from "./statusTone";

/** Human MB for a byte count. */
function mb(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return value < 1 ? "<1 MB" : `${Math.round(value)} MB`;
}

/** The expanded detail for one run: report/error, downloads, and screenshots. */
function RunDetail({ run }: { run: BrowserAgentRun }) {
  const [detail, setDetail] = useState<BrowserAgentRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/browser/${run.id}`);
        if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
        const body = (await res.json()) as { data: BrowserAgentRunDetail };
        if (!cancelled) setDetail(body.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load run");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when the run's own state advances (status/steps change on refresh).
  }, [run.id, run.status, run.steps, run.finishedAt]);

  const screenshotSeqs = detail?.screenshotSeqs ?? [];

  return (
    <div className="space-y-4 bg-surface-2/40 px-4 py-4">
      {run.error ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">Error</p>
          <p className="mt-1 text-sm text-danger">{run.error}</p>
        </div>
      ) : null}

      {run.report ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">Report</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{run.report}</p>
        </div>
      ) : run.status === "running" || run.status === "queued" ? (
        <p className="text-sm text-muted">No report yet — the run is still in progress.</p>
      ) : null}

      {run.downloads.length > 0 ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">Downloads</p>
          <ul className="mt-1 space-y-1">
            {run.downloads.map((file, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <Download className="h-3.5 w-3.5 text-muted" aria-hidden />
                <span>{file.filename}</span>
                <span className="text-muted">
                  · {mb(file.sizeBytes)} · {file.inline ? "attached to chat" : "downloads folder"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {screenshotSeqs.length > 0 ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">
            Screenshots ({screenshotSeqs.length})
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {screenshotSeqs.map((seq) => (
              <a
                key={seq}
                href={`/api/browser/${run.id}/screenshot/${seq}`}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- run screenshots are dynamic bytea served from our API, not build-time assets */}
                <img
                  src={`/api/browser/${run.id}/screenshot/${seq}`}
                  alt={`Screenshot ${seq + 1}`}
                  className="h-32 w-full object-cover object-top"
                />
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live-refreshing table of browser-agent runs. Each row expands to show the
 * report, downloads, and screenshots (fetched lazily on expand). The page as a
 * whole re-renders on the `browser` SSE topic, so status/step counts advance
 * without a manual reload; this component only owns the expand state.
 */
export function RunsList({ runs }: { runs: BrowserAgentRun[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useCallback(
    (id: string) => setOpenId((current) => (current === id ? null : id)),
    [],
  );

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="No runs yet"
        description="Start a run above, or ask the bot in Telegram to browse the web for you."
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table minWidth={640}>
          <TableHead>
            <TableRow header>
              <TableHeaderCell className="w-8" />
              <TableHeaderCell>Goal</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell align="right">Steps</TableHeaderCell>
              <TableHeaderCell align="right">Files</TableHeaderCell>
              <TableHeaderCell>Started</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {runs.map((run) => {
              const open = openId === run.id;
              const badge = runStatusBadge(run.status);
              return (
                <Fragment key={run.id}>
                  <TableRow interactive onClick={() => toggle(run.id)} aria-expanded={open}>
                    <TableCell valign="middle" className="text-muted">
                      {open ? (
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      )}
                    </TableCell>
                    <TableCell valign="middle" className="max-w-md">
                      <span className={cn("line-clamp-2", !open && "truncate")}>{run.goal}</span>
                    </TableCell>
                    <TableCell valign="middle">
                      <Badge tone={badge.tone} dot={run.status === "running"}>
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell valign="middle" align="right">
                      {run.steps}
                    </TableCell>
                    <TableCell valign="middle" align="right">
                      {run.downloads.length}
                    </TableCell>
                    <TableCell valign="middle" className="whitespace-nowrap text-muted">
                      <Timestamp iso={run.startedAt ?? run.createdAt} />
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <tr>
                      <td colSpan={6} className="border-b border-border p-0">
                        <RunDetail run={run} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
