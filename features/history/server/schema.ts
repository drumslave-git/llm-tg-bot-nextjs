import { z } from "zod";

import type { ChatMessageRecord, ChatSummary } from "./repository";

/**
 * Validation schemas and client-facing types for the history mirror. Unlike most
 * features, history is driven by the Telegram runtime rather than a client form,
 * so these schemas validate the runtime's inputs before they reach persistence.
 */

/** Upper bound on a single stored message (mirrors Telegram's own message cap). */
export const MAX_CONTENT_CHARS = 8192;

const chatId = z.string().min(1);
const telegramMessageId = z.number().int().positive();

/** A human/assistant message captured into the mirror. */
export const recordMessageSchema = z.object({
  chatId,
  telegramMessageId,
  role: z.enum(["user", "assistant"]),
  userId: z.string().min(1).nullable().optional(),
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
  replyToMessageId: z.number().int().positive().nullable().optional(),
  sentAt: z.date(),
});
export type RecordMessageInput = z.infer<typeof recordMessageSchema>;

/** An `edited_message` update rewriting a previously stored row. */
export const applyEditSchema = z.object({
  chatId,
  telegramMessageId,
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
  editedAt: z.date(),
});
export type ApplyEditInput = z.infer<typeof applyEditSchema>;

/** Client-facing shapes (already free of secrets). */
export type ChatMessageView = ChatMessageRecord;
export type ChatSummaryView = ChatSummary;
