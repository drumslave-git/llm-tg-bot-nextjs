"use client";

import { Badge } from "@/components/ui";
import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import type { MemoryJobInfo } from "@/features/memory/server/scheduler";

/**
 * Status + control card for the nightly memory-consolidation job, built on the
 * shared {@link JobStatusCard}.
 */
export function MemoryJobCard({ initial }: { initial: MemoryJobInfo }) {
  const { status, nextRunAt, runTime, timezone, lastResult, pendingNotes, embeddingsConfigured } =
    initial;

  return (
    <JobStatusCard
      title="Memory consolidation"
      description={`Folds the facts the bot saved during the day into durable memory — one merge per person, one reconcile per general fact — every day at ${runTime} (${timezone}).`}
      activity={intervalJobActivity(status)}
      runEndpoint="/api/memory/run"
      runDisabled={pendingNotes === 0}
      badges={
        <>
          <Badge tone={pendingNotes > 0 ? "warning" : "neutral"}>
            {pendingNotes === 0
              ? "No notes pending"
              : `${pendingNotes} note${pendingNotes === 1 ? "" : "s"} pending`}
          </Badge>
          {embeddingsConfigured ? null : (
            <Badge tone="warning">No embedding model — keyword search only</Badge>
          )}
        </>
      }
      notice={
        embeddingsConfigured ? null : (
          <>
            No embedding model is configured, so memory is stored and injected but can only be
            searched by keyword, not by meaning. Set one in Settings → Embeddings.
          </>
        )
      }
      nextRunAt={nextRunAt}
      lastRunAt={lastResult?.at ?? null}
      lastResult={lastResult?.summary ?? null}
      failed={status.lastError != null}
    />
  );
}
