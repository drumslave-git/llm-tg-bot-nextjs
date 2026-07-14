"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import type { ApiErrorBody } from "@/lib/api-error";
import type { SummaryJobInfo } from "../server/summary-scheduler";

/**
 * Status + control card for the daily history-summarization job. Client
 * Component: shows when it next runs, what the last run did, how many chat-days
 * are still owed, and whether semantic search is on. Live updates arrive over the
 * page's `history` SSE subscription (the scheduler publishes on every status
 * change); `initial` is re-supplied by the server on each refresh.
 */
export function SummaryJobCard({ initial }: { initial: SummaryJobInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { status, pendingDays, nextRunAt, runTime, lastResult, embeddingsConfigured } = initial;
  const running = status.ticking;

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/history/summaries/run", { method: "POST" });
      const body = (await res.json()) as { data?: SummaryJobInfo } & ApiErrorBody;
      if (!res.ok) {
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            Summaries
            {running ? (
              <Badge tone="success" dot>
                Running
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                Idle
              </Badge>
            )}
            {embeddingsConfigured ? null : (
              <Badge tone="warning">No embedding model — keyword search only</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Each finished day is compressed into searchable topics, so the bot can recall
            conversations older than the last 24 hours. Runs daily at {runTime}.
            {pendingDays > 0
              ? ` ${pendingDays} chat-${pendingDays === 1 ? "day" : "days"} awaiting a summary.`
              : " Everything is summarized."}
          </CardDescription>
        </div>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runNow}
            disabled={busy || running || pendingDays === 0}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            {running ? "Running…" : busy ? "Starting…" : "Run now"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt>Next run</dt>
            <dd className="text-foreground">
              <Timestamp iso={nextRunAt} />
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Last run</dt>
            <dd className="text-foreground">
              <Timestamp iso={lastResult?.at ?? null} />
            </dd>
          </div>
          <div className="flex justify-between gap-4 sm:col-span-2">
            <dt>Last result</dt>
            <dd className={status.lastError ? "text-danger" : "text-foreground"}>
              {lastResult?.summary ?? "—"}
            </dd>
          </div>
        </dl>
        {error ? <p className="mt-2 text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
