import "server-only";

import { and, asc, desc, eq, gte, isNull, ne, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatMessages, type ChatMessageRow } from "@/db/schema";

/**
 * Typed persistence for the chat-history mirror (`chat_messages`). Pure data
 * access: no policy, no validation, no trace recording (the service owns those).
 * Every function takes a {@link DrizzleDb} so it runs against the pool or a test
 * instance.
 */

/** A stored chat message. */
export interface ChatMessageRecord {
  id: number;
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId: string | null;
  content: string;
  replyToMessageId: number | null;
  sentAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

/** Fields for appending a message to the mirror. */
export interface AppendChatMessage {
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId?: string | null;
  content: string;
  replyToMessageId?: number | null;
  sentAt: Date;
}

/** A per-chat rollup for the History dashboard. */
export interface ChatSummary {
  chatId: string;
  messageCount: number;
  lastSentAt: string;
}

function mapRow(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    role: row.role === "assistant" ? "assistant" : "user",
    userId: row.userId,
    content: row.content,
    replyToMessageId: row.replyToMessageId,
    sentAt: row.sentAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Append a message to the mirror. Idempotent on `(chat_id, telegram_message_id)`
 * so a re-delivered Telegram update does not duplicate a row. Returns the stored
 * record, or null when the row already existed (conflict).
 */
export async function appendChatMessage(
  db: DrizzleDb,
  values: AppendChatMessage,
): Promise<ChatMessageRecord | null> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      chatId: values.chatId,
      telegramMessageId: values.telegramMessageId,
      role: values.role,
      userId: values.userId ?? null,
      content: values.content,
      replyToMessageId: values.replyToMessageId ?? null,
      sentAt: values.sentAt,
    })
    .onConflictDoNothing({
      target: [chatMessages.chatId, chatMessages.telegramMessageId],
    })
    .returning();
  return row ? mapRow(row) : null;
}

/** One message by its Telegram id within a chat, or null. */
export async function getChatMessageByTelegramId(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
): Promise<ChatMessageRecord | null> {
  const row = await db.query.chatMessages.findFirst({
    where: and(
      eq(chatMessages.chatId, chatId),
      eq(chatMessages.telegramMessageId, telegramMessageId),
    ),
  });
  return row ? mapRow(row) : null;
}

/**
 * Rewrite a message's content in place (an `edited_message` mirror). Returns the
 * updated record, or null when no matching row exists.
 */
export async function updateChatMessageContent(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
  content: string,
  editedAt: Date,
): Promise<ChatMessageRecord | null> {
  const [row] = await db
    .update(chatMessages)
    .set({ content, editedAt })
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        eq(chatMessages.telegramMessageId, telegramMessageId),
      ),
    )
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Non-deleted messages in a chat sent on/after `since`, oldest first (insertion
 * order). Optionally excludes one Telegram message id — used to drop the current
 * turn from its own recent-history window.
 */
export async function getChatMessagesSince(
  db: DrizzleDb,
  chatId: string,
  since: Date,
  options?: { excludeTelegramMessageId?: number },
): Promise<ChatMessageRecord[]> {
  const filters = [
    eq(chatMessages.chatId, chatId),
    gte(chatMessages.sentAt, since),
    isNull(chatMessages.deletedAt),
  ];
  if (options?.excludeTelegramMessageId != null) {
    filters.push(ne(chatMessages.telegramMessageId, options.excludeTelegramMessageId));
  }
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(...filters))
    .orderBy(asc(chatMessages.id));
  return rows.map(mapRow);
}

/** Per-chat rollups (message count + last activity), most-recently-active first. */
export async function listChatSummaries(db: DrizzleDb): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      chatId: chatMessages.chatId,
      messageCount: sql<number>`count(*)::int`,
      lastSentAt: sql<Date>`max(${chatMessages.sentAt})`,
    })
    .from(chatMessages)
    .groupBy(chatMessages.chatId)
    .orderBy(desc(sql`max(${chatMessages.sentAt})`));
  return rows.map((row) => ({
    chatId: row.chatId,
    messageCount: row.messageCount,
    lastSentAt: new Date(row.lastSentAt).toISOString(),
  }));
}

/**
 * Stored messages for one chat, newest first — the full mirror for the dashboard
 * detail view (most recent at the top). Deleted rows are included (flagged) so
 * the mirror is complete; the caller decides how to render them.
 */
export async function getChatMessages(
  db: DrizzleDb,
  chatId: string,
  limit = 500,
): Promise<ChatMessageRecord[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.id))
    .limit(limit);
  return rows.map(mapRow);
}
