import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getHistoryOverview } from "@/features/history/server/service";
import type { ChatSummaryView } from "@/features/history/server/schema";
import { ChatSummaryList } from "@/features/history/ui/ChatSummaryList";

// History is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * History dashboard page. Server Component: lists the chats with stored history
 * and links to each chat's full mirror.
 */
export default async function HistoryPage() {
  let chats: ChatSummaryView[] | null = null;
  let dbError: string | null = null;
  try {
    chats = await getHistoryOverview();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read history from the database";
  }

  return (
    <>
      <PageHeader
        title="History"
        description="The bot's stored conversations. Each reply injects the current day's messages as context."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="history" />
            <Button asChild variant="outline" size="sm">
              <Link href="/history/debug">
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {chats ? (
        <ChatSummaryList chats={chats} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The history database could not be reached."}
        />
      )}
    </>
  );
}
