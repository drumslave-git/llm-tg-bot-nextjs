import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import type { ChatMessage } from "@/server/llm/client";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { getLatestTraceIdsByCorrelation } from "@/server/trace/repository";
import { collectUserIds, startOfUtcDay, toPriorTurn } from "./format";
import {
  appendChatMessage,
  getChatMessages,
  getChatMessagesSince,
  listChatSummaries,
  updateChatMessageContent,
  type ChatMessageRecord,
  type ChatSummary,
} from "./repository";
import {
  applyEditSchema,
  recordMessageSchema,
  type ApplyEditInput,
  type ChatMessageWithTrace,
  type RecordMessageInput,
} from "./schema";

/**
 * History domain service — the boundary the Telegram runtime and dashboard call.
 *
 * The runtime records every human message (passively, even un-addressed group
 * chatter) and every delivered reply, so `chat_messages` becomes a 1:1 mirror of
 * the conversation. For each reply the service assembles the current-day window
 * as structured prior turns. Passive capture is high-volume and intentionally
 * untraced (the mirror itself is the record); mutating edits are traced.
 */

const FEATURE = "history";

/** Input for capturing an incoming human message (role is always `user`). */
export interface IncomingHistoryMessage {
  chatId: string;
  telegramMessageId: number;
  userId: string | null;
  content: string;
  replyToMessageId?: number | null;
  sentAt: Date;
}

/** Input for capturing a delivered assistant reply. */
export interface AssistantHistoryMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  replyToMessageId?: number | null;
  sentAt?: Date;
}

/**
 * Capture an incoming human message into the mirror. Best-effort and untraced:
 * returns the stored record, or null when it was empty/invalid or already stored
 * (a re-delivered update). Never throws on validation — a bad row must not break
 * message handling.
 */
export async function recordIncomingMessage(
  input: IncomingHistoryMessage,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  const parsed = recordMessageSchema.safeParse({ ...input, role: "user" } satisfies RecordMessageInput);
  if (!parsed.success) return null;
  const record = await appendChatMessage(db, {
    chatId: parsed.data.chatId,
    telegramMessageId: parsed.data.telegramMessageId,
    role: "user",
    userId: parsed.data.userId ?? null,
    content: parsed.data.content,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
    sentAt: parsed.data.sentAt,
  });
  if (record) publishEvent("history");
  return record;
}

/**
 * Capture a delivered assistant reply into the mirror. Best-effort and untraced
 * (the reply is already traced by bot-messaging). Returns the stored record or
 * null.
 */
export async function recordAssistantMessage(
  input: AssistantHistoryMessage,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  const parsed = recordMessageSchema.safeParse({
    chatId: input.chatId,
    telegramMessageId: input.telegramMessageId,
    role: "assistant",
    userId: null,
    content: input.content,
    replyToMessageId: input.replyToMessageId ?? null,
    sentAt: input.sentAt ?? new Date(),
  } satisfies RecordMessageInput);
  if (!parsed.success) return null;
  const record = await appendChatMessage(db, {
    chatId: parsed.data.chatId,
    telegramMessageId: parsed.data.telegramMessageId,
    role: "assistant",
    userId: null,
    content: parsed.data.content,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
    sentAt: parsed.data.sentAt,
  });
  if (record) publishEvent("history");
  return record;
}

/**
 * Apply a Telegram `edited_message` to the mirror, keeping it 1:1 with the live
 * chat. Traced (a mutation). If the edited message was never stored, the trace
 * records that the target was unknown rather than fabricating a row.
 */
export async function applyMessageEdit(
  input: ApplyEditInput,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  const trace = await startTrace(
    {
      feature: FEATURE,
      action: "edit",
      trigger,
      inputSummary: input.content,
    },
    db,
  );
  try {
    const parsed = applyEditSchema.parse(input);
    const before = await updateChatMessageContent(
      db,
      parsed.chatId,
      parsed.telegramMessageId,
      parsed.content,
      parsed.editedAt,
    );
    if (!before) {
      await trace.event({
        type: "db",
        level: "warn",
        message: "edit target not found",
        data: { chatId: parsed.chatId, telegramMessageId: parsed.telegramMessageId },
      });
      await trace.skip("edit target not found");
      return null;
    }
    await trace.event({
      type: "db",
      message: "message edited",
      data: { telegramMessageId: parsed.telegramMessageId, content: parsed.content },
    });
    publishEvent("history");
    await trace.succeed({
      outputSummary: parsed.content,
      relatedIds: { chat_messages: [String(before.id)] },
    });
    return before;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** The current-day conversation window as structured prior turns. */
export interface ConversationWindow {
  messages: ChatMessage[];
  count: number;
}

/**
 * Build the recent-history window for a reply: the current day's messages in the
 * chat (excluding the current turn), rendered as prior `user`/`assistant` turns.
 * In a group, human turns are labelled with the sender's known-user name.
 */
export async function getConversationWindow(
  params: { chatId: string; isGroup: boolean; excludeTelegramMessageId?: number; now?: Date },
  db: DrizzleDb = getDb(),
): Promise<ConversationWindow> {
  const since = startOfUtcDay(params.now ?? new Date());
  const records = await getChatMessagesSince(db, params.chatId, since, {
    excludeTelegramMessageId: params.excludeTelegramMessageId,
  });

  let speakerLabels: Map<string, string> | undefined;
  if (params.isGroup) {
    const userIds = collectUserIds(records);
    if (userIds.length > 0) {
      const users = await getKnownUsersByIds(db, userIds);
      speakerLabels = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
    }
  }

  const messages = records.map((record) =>
    toPriorTurn(record, { isGroup: params.isGroup, speakerLabels }),
  );
  return { messages, count: messages.length };
}

/** Per-chat rollups for the History dashboard. */
export async function getHistoryOverview(db: DrizzleDb = getDb()): Promise<ChatSummary[]> {
  return listChatSummaries(db);
}

/**
 * Correlation id of the trace that handled a message's turn. A trace's
 * correlation id is `${chatId}:${incomingMessageId}` (see the bot-messaging
 * service), so a user row uses its own Telegram id and an assistant row uses the
 * message it replied to (the incoming turn). Null when there is no anchor.
 */
function traceCorrelationFor(record: ChatMessageRecord): string | null {
  const anchor = record.role === "assistant" ? record.replyToMessageId : record.telegramMessageId;
  return anchor != null ? `${record.chatId}:${anchor}` : null;
}

/**
 * The full stored mirror for one chat (dashboard detail view), each message
 * annotated with the id of the trace that handled its turn so the UI can link
 * straight to `/debug/[id]`.
 */
export async function getChatHistory(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageWithTrace[]> {
  const records = await getChatMessages(db, chatId);
  const correlations = records
    .map(traceCorrelationFor)
    .filter((value): value is string => value != null);
  const traceIds = await getLatestTraceIdsByCorrelation(db, correlations);
  return records.map((record) => {
    const correlation = traceCorrelationFor(record);
    return { ...record, traceId: correlation ? (traceIds.get(correlation) ?? null) : null };
  });
}
