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
import type { ApiErrorBody } from "@/lib/api-error";
import type { SelfImprovementJobInfo } from "@/features/self-improvement/server/scheduler";

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * Status + control card for the daily self-improvement job. Client Component:
 * shows the next scheduled run (configured time + timezone), the last actual
 * incorporation outcome, and a "Run now" trigger. Live updates arrive via the
 * page's `feedback` SSE subscription; `initial` is re-supplied by the server on
 * each refresh.
 */
export function SelfImprovementJobCard({ initial }: { initial: SelfImprovementJobInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { status, nextRunAt, runTime, timezone, lastResult } = initial;
  const running = status.ticking;

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/self-improvement/run", { method: "POST" });
      const body = (await res.json()) as { data?: SelfImprovementJobInfo } & ApiErrorBody;
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
            Daily incorporation
            <Badge tone={running ? "success" : status.running ? "neutral" : "warning"} dot>
              {running ? "Running" : status.running ? "Idle" : "Stopped"}
            </Badge>
          </CardTitle>
          <CardDescription>
            Distills collected feedback into per-user preferences and global self-corrections,
            every day at {runTime} ({timezone}).
          </CardDescription>
        </div>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runNow}
            disabled={busy || running}
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
            <dd className="text-foreground">{formatTime(nextRunAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Last run</dt>
            <dd className="text-foreground">{formatTime(lastResult?.at ?? null)}</dd>
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
