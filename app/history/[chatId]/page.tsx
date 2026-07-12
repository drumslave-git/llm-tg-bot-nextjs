import { ArrowLeft, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getChatHistory } from "@/features/history/server/service";
import type { ChatMessageWithTrace } from "@/features/history/server/schema";
import { ChatHistoryTable } from "@/features/history/ui/ChatHistoryTable";

// History is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Single-chat history mirror. Server Component: renders the full stored
 * conversation for one chat, including edit/delete flags.
 */
export default async function ChatHistoryPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId: raw } = await params;
  const chatId = decodeURIComponent(raw);

  let messages: ChatMessageWithTrace[] | null = null;
  let dbError: string | null = null;
  try {
    messages = await getChatHistory(chatId);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read history from the database";
  }

  return (
    <>
      <PageHeader
        title="Conversation"
        description="Full stored mirror for this chat, newest first."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="history" />
            <Button asChild variant="outline" size="sm">
              <Link href="/history">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                All chats
              </Link>
            </Button>
          </div>
        }
      />

      {messages ? (
        messages.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No messages"
            description={`No stored history for chat ${chatId}.`}
          />
        ) : (
          <ChatHistoryTable chatId={chatId} messages={messages} />
        )
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
