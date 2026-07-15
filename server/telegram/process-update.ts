import "server-only";

import type { Message } from "@grammyjs/types";

import {
  getBotPolicy,
  getLlmRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import type { BotPolicy } from "@/features/settings/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { buildTimeContext } from "@/features/bot-messaging/server/prompt";
import {
  handleIncomingMessage,
  type BotMessagingDeps,
  type HandleOutcome,
  type IncomingMessage,
} from "@/features/bot-messaging/server/service";
import {
  applyMessageEdit,
  composeCurrentTurn,
  getConversationWindow,
  recordAssistantMessage,
  recordIncomingMessage,
} from "@/features/history/server/service";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getUserContext, rememberUser } from "@/features/known-users/server/service";
import {
  getGroupContext,
  rememberGroupActivity,
} from "@/features/known-groups/server/service";
import { getMemoryContext } from "@/features/memory/server/service";
import { getToolset } from "@/features/mcp-tools/server/service";
import { findReplyMediaMessage, messageHasVisionMedia } from "@/features/vision/detect";
import { mediaKindLabel, toVisionParts } from "@/features/vision/format";
import {
  describeAndStore,
  getMediaSuffixesForMessages,
  ingestMessageMedia,
  loadReplyTargetImages,
} from "@/features/vision/server/service";
import {
  captureFeedbackReply,
  getLatestSelfCorrectionPrompt,
  getPreferencesContext,
} from "@/features/self-improvement/server/service";
import { pokeVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import { ApiError } from "@/lib/api-error";
import { chatCompletion, type ChatContentPart, type ChatMessage } from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import { runWithToolContext } from "@/server/mcp/context";

import type { IncomingUpdate, ReplyTransport } from "./transport";

/**
 * Transport-agnostic message-processing pipeline. This is the whole runtime
 * between the Telegram edges: remember the sender, mirror the message into
 * history, ingest + recognize any media, compose the reply context, run the
 * (tool-augmented) LLM, deliver, and mirror the reply back. It reaches Telegram
 * only through the injected {@link ReplyTransport} and the update's lazy token
 * resolver, so the exact same code runs behind a live grammy `Context` (the bot
 * manager) and behind a synthetic update + capturing sink (the test harness).
 */

/** Optional seams for tests; every field defaults to the real implementation. */
export interface ProcessOverrides {
  /**
   * Inject a deterministic reply generator instead of hitting the configured
   * LLM. When absent, the real DB-configured LLM (+ tool loop) is used — which is
   * exactly what the opt-in real-LLM flow test wants.
   */
  generateReply?: BotMessagingDeps["generateReply"];
  /**
   * Rewrite a feedback-menu message once a free-text answer is captured (real:
   * the bot manager's grammy adapter). When absent (no edit capability), the
   * capture is confirmed with a plain reply instead.
   */
  editFeedbackMenu?: (input: { chatId: string; messageId: number; text: string }) => Promise<void>;
}

/** Telegram expires a chat action after ~5s; refresh just under that. */
const TYPING_REFRESH_MS = 4_500;

/** Human label for a raw Telegram user, matching the known-user label shape. */
function labelForTelegramUser(user: {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}): string {
  return formatKnownUserLabel({
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    userId: String(user.id),
  });
}

/** Build the per-message collaborators the bot-messaging service needs. */
function buildDeps(
  update: IncomingUpdate,
  transport: ReplyTransport,
  policy: BotPolicy,
  personalityPrompt: string | null,
  selfCorrection: string | null,
  timeContext: string | null,
  visionAttachment: {
    imageParts: ChatContentPart[];
    note?: string;
    /**
     * The current message's id when its freshly-ingested media must be recognized
     * *before* the reply (pass 1 — always, so history stores the description).
     * Absent for replied-to media, which is not re-described here.
     */
    recognizeMessageId?: number;
    /** Whether to attach the images to the reply (pass 2 — only when the message has text). */
    attachToReply: boolean;
  } | null,
  overrides?: ProcessOverrides,
): BotMessagingDeps {
  const message = update.message;
  const bot = update.botInfo;
  const chatId = String(message.chat.id);
  const isGroup = message.chat.type !== "private";
  const currentMessageId = message.message_id;
  const senderId = message.from?.id != null ? String(message.from.id) : null;
  const botLabel = `You (@${bot.username})`;
  const threadId = message.message_thread_id;

  return {
    bot,
    policy,
    personalityPrompt,
    selfCorrection,
    timeContext,
    // Called only for an addressed message about to be answered (after the
    // addressing/maintenance gates), so recognition here runs exactly when the
    // flow wants it: recognize → store in history → reply with images + result.
    loadVision: visionAttachment
      ? async () => {
          const va = visionAttachment;
          let note = va.note;
          let description: string | null = null;
          let mediaLabel = "media";
          // Pass 1 (always for the current media): recognize it and store the
          // description on the media row — this drops the stored bytes, so the
          // /history mirror shows it and there is nothing left to backfill.
          if (va.recognizeMessageId != null) {
            const runtime = await getLlmRuntime().catch(() => null);
            if (runtime) {
              const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };
              const described = await describeAndStore(
                { chatId, telegramMessageId: va.recognizeMessageId },
                { complete: (messages) => chatCompletion(conn, { model: runtime.model, messages }) },
              ).catch(() => null);
              if (described?.description) {
                description = described.description;
                mediaLabel = mediaKindLabel(described.kind);
              }
            }
          }
          // Pass 2 (conditional): attach the images to the reply only when asked
          // (the message had text). Otherwise the reply is generated from the
          // recognition text alone — no images, one vision pass total.
          if (va.attachToReply) {
            if (description) {
              const recognized = `Recognition of the media above: ${description}`;
              note = note ? `${note}\n\n${recognized}` : recognized;
            }
            return { imageParts: va.imageParts, note };
          }
          const recognized = description
            ? `The user sent a ${mediaLabel} (no caption). Its content: ${description}`
            : note;
          return { imageParts: [], note: recognized };
        }
      : undefined,
    startTyping() {
      // Preserve the forum-topic thread so typing shows in the right place.
      const tick = () => transport.sendTyping({ threadId });
      tick();
      const interval = setInterval(tick, TYPING_REFRESH_MS);
      return () => clearInterval(interval);
    },
    loadHistory() {
      return getConversationWindow({
        chatId,
        botLabel,
        excludeTelegramMessageId: currentMessageId,
        // Turn stored media descriptions into transcript suffixes so a past image
        // turn reads as text (e.g. ` [photo: a red car…]`).
        loadMediaSuffixes: (ids) => getMediaSuffixesForMessages(chatId, ids),
      });
    },
    // Render the current message as a transcript line: id anchor, sender label,
    // and its reply target resolved against the mirror (an anchor when stored,
    // the quoted sender + full text inlined when not). Best-effort — a failure
    // falls back to the raw text rather than dropping the reply.
    loadCurrentTurn: () => {
      const from = message.from;
      const replyTo = message.reply_to_message;
      return composeCurrentTurn({
        chatId,
        telegramMessageId: currentMessageId,
        senderLabel: from && !from.is_bot ? labelForTelegramUser(from) : null,
        content: message.text ?? message.caption ?? "",
        replyTo: replyTo
          ? {
              telegramMessageId: replyTo.message_id,
              senderLabel: replyTo.from
                ? replyTo.from.id === bot.id
                  ? botLabel
                  : labelForTelegramUser(replyTo.from)
                : null,
              text: replyTo.text ?? replyTo.caption ?? null,
              quote: message.quote?.text ?? null,
            }
          : null,
      }).catch(() => null);
    },
    // Inject the chat's identity context: in a group the known-participant
    // roster, in a private chat who the bot is talking to (so the model can
    // address them and has a reference name for the alias tool). Best-effort — a
    // lookup failure resolves null rather than dropping the reply.
    loadChatContext: isGroup
      ? () =>
          getGroupContext(chatId)
            .then((c) => (c ? { content: c.content, data: { memberCount: c.memberCount } } : null))
            .catch(() => null)
      : senderId != null
        ? () => getUserContext(senderId).catch(() => null)
        : undefined,
    // What the bot durably knows about the people here: the sender, plus the other
    // known participants in a group (so it can follow talk *about* someone it
    // knows without being asked to look them up). General memory is not injected —
    // the model reaches it with the memory tools. Best-effort — a lookup failure
    // resolves null rather than dropping the reply.
    loadMemory: () =>
      getMemoryContext({ chatId, senderId, isGroup }).catch(() => null),
    // The sender's learned communication preferences (from their 👍/👎
    // feedback), so the reply adapts to this person in groups and DMs alike.
    // Best-effort — a lookup failure resolves null rather than dropping the reply.
    loadSenderPreferences:
      senderId != null ? () => getPreferencesContext(senderId).catch(() => null) : undefined,
    async recordReply(input) {
      await recordAssistantMessage({
        chatId,
        telegramMessageId: input.telegramMessageId,
        content: input.content,
        replyToMessageId: input.replyToMessageId,
      });
    },
    generateReply:
      overrides?.generateReply ??
      (async (messages: ChatMessage[], onToolCall) => {
        const runtime = await getLlmRuntime();
        if (!runtime) {
          throw ApiError.serviceUnavailable(
            "LLM is not configured — set the endpoint and model in Settings",
          );
        }
        const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };
        // No tools registered → a single inference (cache-friendly path). A reply
        // that needs no tool still costs one inference even when tools are offered.
        const toolset = await getToolset();
        if (!toolset) {
          return chatCompletion(conn, { model: runtime.model, messages });
        }
        // Run the tool-call loop with the current chat bound, so tools only ever
        // read this conversation's data. The sender + thread are bound too, so a
        // task tool records who created a task and delivers into the right thread.
        return runWithToolContext({ chatId, userId: senderId, threadId }, () =>
          chatCompletionWithTools(conn, {
            model: runtime.model,
            messages,
            tools: toolset.tools,
            callTool: toolset.callTool,
            onToolCall: (rec) =>
              onToolCall?.({ name: rec.name, args: rec.args, result: rec.result, ok: rec.ok }),
          }),
        );
      }),
    async sendReply(text: string) {
      return transport.sendReply(text, { replyToMessageId: currentMessageId });
    },
  };
}

/**
 * Handle one incoming message end to end through the transport-agnostic pipeline.
 * Maps the normalized update to the bot-messaging service's input, wiring the
 * real (or injected) collaborators. Returns the service outcome so callers/tests
 * can assert on it (the bot manager ignores it).
 */
export async function processUpdate(
  update: IncomingUpdate,
  transport: ReplyTransport,
  overrides?: ProcessOverrides,
): Promise<HandleOutcome> {
  const message = update.message;

  // Live traffic: push the idle vision-backfill run out and yield any batch in
  // flight, so backfill only ever runs while the bot is quiet.
  pokeVisionBackfill();

  // Remember every human sender + mirror every human message (addressed or not),
  // so the operator sees who talks to the bot and the history window has the full
  // running conversation. Both are best-effort and must not block handling.
  const from = message.from;
  const text = message.text ?? message.caption ?? "";
  const chat = message.chat;
  const chatId = String(chat.id);
  const hasMedia = messageHasVisionMedia(message);
  if (from && !from.is_bot) {
    await rememberUser({
      userId: String(from.id),
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    });
    // In a group, also remember the group and record this sender as a member, so
    // the operator sees the bot's groups and the roster is available for context.
    // Runs after rememberUser so the membership FK to known_users is satisfied.
    if (chat.type === "group" || chat.type === "supergroup") {
      await rememberGroupActivity({
        chatId,
        title: chat.title,
        type: chat.type,
        userId: String(from.id),
      });
    }
    // Mirror the message when it has text or media (a media-only message still
    // belongs in the transcript — its image is described separately).
    if (text.trim() || hasMedia) {
      await recordIncomingMessage({
        chatId,
        telegramMessageId: message.message_id,
        userId: String(from.id),
        content: text,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        sentAt: new Date(message.date * 1000),
        hasMedia,
      });
    }
  }

  // Feedback capture: a reply to an `awaiting_text` feedback menu from the
  // reactor is the free-text answer to the 👍/👎 menu — record it and stop, the
  // message is not a turn for the bot to answer (it stays mirrored above).
  if (from && !from.is_bot && message.reply_to_message && text.trim()) {
    const captured = await captureFeedbackReply({
      chatId,
      menuMessageId: message.reply_to_message.message_id,
      userId: String(from.id),
      text,
    }).catch(() => null);
    if (captured) {
      if (overrides?.editFeedbackMenu) {
        await overrides
          .editFeedbackMenu({
            chatId,
            messageId: captured.menuMessageId,
            text: captured.confirmation,
          })
          .catch(() => undefined);
      } else {
        await transport
          .sendReply(captured.confirmation, { replyToMessageId: message.message_id })
          .catch(() => undefined);
      }
      return { status: "ignored", reason: "feedback_captured" };
    }
  }

  // Vision: ingest this message's media (passive, stored as base64) and resolve
  // the image(s) to attach to the current turn — either on the message itself or
  // on a replied-to image. The bot token (from settings) is needed to download
  // Telegram files. Best-effort — any failure just yields a text-only reply.
  let visionAttachment:
    | {
        imageParts: ChatContentPart[];
        note?: string;
        /** Current media to describe+store (pass 1). Always set for current media. */
        recognizeMessageId?: number;
        /** Whether to attach the images to the reply (pass 2). */
        attachToReply: boolean;
      }
    | null = null;
  const replyMedia = hasMedia ? null : findReplyMediaMessage(message);
  if (hasMedia || replyMedia) {
    const token = await update.resolveToken().catch(() => null);
    if (token) {
      if (hasMedia) {
        const ingested = await ingestMessageMedia({
          token,
          chatId,
          telegramMessageId: message.message_id,
          message,
        }).catch(() => null);
        if (ingested && ingested.images.length > 0) {
          // Pass 1 (always): recognize + store the current media in history.
          // Pass 2 (conditional): attach the images to the reply only when the
          // message also carries text (a real question). A media-only message is
          // answered from the recognition text alone — one vision pass.
          visionAttachment = {
            imageParts: toVisionParts(ingested.images),
            note: ingested.note ?? undefined,
            recognizeMessageId: message.message_id,
            attachToReply: Boolean(text.trim()),
          };
        }
      } else if (replyMedia) {
        const loaded = await loadReplyTargetImages({ token, chatId, message: replyMedia }).catch(
          () => null,
        );
        if (loaded && loaded.images.length > 0) {
          const base = `The user is asking about the ${mediaKindLabel(loaded.kind)} they replied to (shown here).`;
          // A replied-to reference is explicit — always show the media to the reply.
          visionAttachment = {
            imageParts: toVisionParts(loaded.images),
            note: loaded.note ? `${base} ${loaded.note}` : base,
            attachToReply: true,
          };
        }
      }
    }
  }

  const incoming: IncomingMessage = {
    message,
    chatId: chat.id,
    chatType: chat.type,
    messageId: message.message_id,
    fromId: from?.id,
    fromIsBot: from?.is_bot ?? false,
    text,
    // A loadable image (on this message or a replied-to one) makes a caption-less
    // message real content, so it is answered and described like any other.
    hasVision: visionAttachment != null,
  };

  const [policy, personalityPrompt, selfCorrection, timezone] = await Promise.all([
    getBotPolicy(),
    getActivePersonalityPrompt(),
    getLatestSelfCorrectionPrompt().catch(() => null),
    getTimezone().catch(() => "UTC"),
  ]);
  const timeContext = buildTimeContext(new Date(), timezone);

  // Recognition of the current message's media happens *before* the reply, inside
  // `loadVision` (only for an addressed message that also carries text): it is
  // described, stored in history, and its bytes dropped. A media-only message is
  // answered in one pass and its media, like unaddressed media, is described later
  // by the backfill job.
  return handleIncomingMessage(
    incoming,
    buildDeps(
      update,
      transport,
      policy,
      personalityPrompt,
      selfCorrection,
      timeContext,
      visionAttachment,
      overrides,
    ),
  );
}

/**
 * Mirror a Telegram `edited_message` into history so the stored conversation
 * tracks edits 1:1. Only text/caption edits are mirrored; edits with no textual
 * content are ignored.
 */
export async function processEditedUpdate(edited: Message): Promise<void> {
  const content = edited.text ?? edited.caption ?? "";
  if (!content.trim()) return;

  await applyMessageEdit(
    {
      chatId: String(edited.chat.id),
      telegramMessageId: edited.message_id,
      content,
      editedAt: new Date((edited.edit_date ?? edited.date) * 1000),
    },
    {
      kind: "telegram",
      actor: edited.from ? String(edited.from.id) : String(edited.chat.id),
      correlationId: `${edited.chat.id}:${edited.message_id}`,
    },
  ).catch((err) => {
    console.error(
      "Failed to mirror edited message:",
      err instanceof Error ? err.message : String(err),
    );
  });
}
