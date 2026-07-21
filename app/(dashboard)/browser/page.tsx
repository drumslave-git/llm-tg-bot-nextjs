import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getBrowserAgentRuns } from "@/features/browser-agent/server/service";
import { NewRunForm } from "@/features/browser-agent/ui/NewRunForm";
import { RunsList } from "@/features/browser-agent/ui/RunsList";
import type { BrowserAgentRun } from "@/features/browser-agent/types";
import { featureDebugHref } from "@/lib/features";

// Runs are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Browser-agent dashboard page. Server Component: lists runs and lets the
 * operator start one directly. A run drives a real browser in the background and
 * reports to its chat; a dashboard-started run has no chat, so its report is read
 * here. Live-updates on the `browser` SSE topic.
 */
export default async function BrowserAgentPage() {
  let runs: BrowserAgentRun[] | null = null;
  let dbError: string | null = null;
  try {
    runs = await getBrowserAgentRuns();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read runs from the database";
  }

  return (
    <>
      <PageHeader
        title="Browser agent"
        description="Background web-browsing runs. The bot opens a real browser to research or act on the web, then reports back to the chat."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="browser" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("browser-agent")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {runs ? (
        <div className="space-y-6">
          <NewRunForm />
          <RunsList runs={runs} />
        </div>
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The browser-agent database could not be reached."}
        />
      )}
    </>
  );
}
