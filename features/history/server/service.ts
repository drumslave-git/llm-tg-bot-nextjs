import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import type { ChatMessage } from "@/server/llm/client";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { getLatestTraceIdsByCorrelation } from "@/server/trace/repository";
import {
  collectUserIds,
  fallbackSpeakerLabel,
  historyWindowStart,
  renderTranscript,
  renderTranscriptLine,
  type ReplyRef,
} from "./format";
import {
  appendChatMessage,
  getChatMessageByTelegramId,
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
 * the conversation. For each reply the service assembles the last 24 hours as an
 * id-anchored transcript (one user message) and renders the current turn in the
 * same format. Passive capture is high-volume and intentionally untraced (the
 * mirror itself is the record); mutating edits are traced.
 */

const FEATURE = FEATURES["history"];

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
  if (record) publishEvent(FEATURE.realtimeTopic);
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
  if (record) publishEvent(FEATURE.realtimeTopic);
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
      feature: FEATURE.id,
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
    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: parsed.content,
      relatedIds: { [FEATURE.relatedIdsKey]: [String(before.id)] },
    });
    return before;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/**
 * The recent-history window for a reply: zero or one `user` message holding the
 * id-anchored transcript. `count` is the number of transcript rows (for tracing).
 */
export interface ConversationWindow {
  messages: ChatMessage[];
  count: number;
}

/** Resolve known-user labels for every sender in a set of rows. */
async function resolveSpeakerLabels(
  db: DrizzleDb,
  records: readonly ChatMessageRecord[],
): Promise<Map<string, string>> {
  const userIds = collectUserIds(records);
  if (userIds.length === 0) return new Map();
  const users = await getKnownUsersByIds(db, userIds);
  return new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
}

/**
 * Build the recent-history window for a reply: the chat's messages from the last
 * 24 hours (excluding the current turn), rendered as one id-anchored transcript
 * in a single `user` message. Every human turn is labelled with the sender's
 * known-user name; the bot's own rows use `botLabel`.
 */
export async function getConversationWindow(
  params: { chatId: string; botLabel?: string; excludeTelegramMessageId?: number; now?: Date },
  db: DrizzleDb = getDb(),
): Promise<ConversationWindow> {
  const since = historyWindowStart(params.now ?? new Date());
  const records = await getChatMessagesSince(db, params.chatId, since, {
    excludeTelegramMessageId: params.excludeTelegramMessageId,
  });

  const speakerLabels = await resolveSpeakerLabels(db, records);
  const transcript = renderTranscript(records, { speakerLabels, botLabel: params.botLabel });
  return {
    messages: transcript ? [{ role: "user", content: transcript }] : [],
    count: records.length,
  };
}

/** The reply target of the current turn, as extracted from the Telegram update. */
export interface CurrentTurnReplyTo {
  telegramMessageId: number;
  /** Sender label resolved by the runtime from the quoted message's `from`. */
  senderLabel: string | null;
  /** The quoted message's text/caption, or null when it had none. */
  text: string | null;
  /** Telegram partial-quote text, when the user quoted a specific fragment. */
  quote?: string | null;
}

/** The current turn rendered in transcript format, plus data for the trace. */
export interface ComposedCurrentTurn {
  content: string;
  senderLabel: string | null;
  data: Record<string, unknown>;
}

/**
 * Render the message being answered as a transcript line, resolving its reply
 * target against the mirror: a stored target becomes a `[reply to #<id>]` anchor
 * (dereferenceable via the history tools even when outside the injected window);
 * an unstored one gets its sender and full text inlined, never trimmed.
 */
export async function composeCurrentTurn(
  params: {
    chatId: string;
    telegramMessageId: number;
    senderLabel: string | null;
    content: string;
    replyTo?: CurrentTurnReplyTo | null;
  },
  db: DrizzleDb = getDb(),
): Promise<ComposedCurrentTurn> {
  let replyRef: ReplyRef | null = null;
  if (params.replyTo) {
    const stored = await getChatMessageByTelegramId(
      db,
      params.chatId,
      params.replyTo.telegramMessageId,
    );
    replyRef = stored
      ? {
          kind: "anchor",
          telegramMessageId: params.replyTo.telegramMessageId,
          quote: params.replyTo.quote ?? null,
        }
      : { kind: "inline", label: params.replyTo.senderLabel, text: params.replyTo.text };
  }
  const content = renderTranscriptLine({
    telegramMessageId: params.telegramMessageId,
    label: params.senderLabel ?? fallbackSpeakerLabel(null),
    replyRef,
    content: params.content,
  });
  return {
    content,
    senderLabel: params.senderLabel,
    data: {
      line: content,
      replyTo: params.replyTo
        ? { telegramMessageId: params.replyTo.telegramMessageId, resolved: replyRef?.kind ?? null }
        : null,
    },
  };
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
