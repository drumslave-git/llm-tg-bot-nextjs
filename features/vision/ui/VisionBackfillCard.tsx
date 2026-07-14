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
  type BadgeTone,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import type { ApiErrorBody } from "@/lib/api-error";
import type { IdleJobStatus } from "@/server/jobs/idle-scheduler";

/** The shape `GET/POST /api/vision/backfill` returns. */
export interface VisionBackfillView {
  status: IdleJobStatus;
  pending: number;
}

const PHASE_LABEL: Record<IdleJobStatus["phase"], string> = {
  idle: "Idle",
  scheduled: "Scheduled",
  running: "Running",
};

const PHASE_TONE: Record<IdleJobStatus["phase"], BadgeTone> = {
  idle: "neutral",
  scheduled: "warning",
  running: "success",
};

/**
 * Status + control card for the vision backfill job. Client Component: shows the
 * in-process scheduler's phase, backlog size, and last-run outcome, with a "Run
 * now" trigger. Live updates arrive via the page's `vision` SSE subscription
 * (the scheduler publishes on every status change); `initial` is re-supplied by
 * the server on each refresh.
 */
export function VisionBackfillCard({ initial }: { initial: VisionBackfillView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { status, pending } = initial;
  const running = status.phase === "running";

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vision/backfill", { method: "POST" });
      const body = (await res.json()) as { data?: VisionBackfillView } & ApiErrorBody;
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
            Backfill
            <Badge tone={PHASE_TONE[status.phase]} dot>
              {PHASE_LABEL[status.phase]}
            </Badge>
          </CardTitle>
          <CardDescription>
            {pending === 0
              ? "No media awaiting a description."
              : `${pending} media ${pending === 1 ? "row" : "rows"} awaiting a description. Runs automatically while the bot is quiet.`}
          </CardDescription>
        </div>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runNow}
            disabled={busy || running || pending === 0}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            {running ? "Running…" : busy ? "Starting…" : "Run now"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt>Last run</dt>
            <dd className="text-foreground">
              <Timestamp iso={status.lastRunAt} />
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Last result</dt>
            <dd className={status.lastError ? "text-danger" : "text-foreground"}>
              {status.lastSummary ?? "—"}
            </dd>
          </div>
        </dl>
        {error ? <p className="mt-2 text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
