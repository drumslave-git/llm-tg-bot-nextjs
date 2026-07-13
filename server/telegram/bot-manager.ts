import "server-only";

import { Bot, type Context } from "grammy";

import {
  getBotPolicy,
  getLlmRuntime,
  getTelegramBotToken,
} from "@/features/settings/server/service";
import type { BotPolicy } from "@/features/settings/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import {
  handleIncomingMessage,
  type BotMessagingDeps,
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
import { getToolset } from "@/features/mcp-tools/server/service";
import { findReplyMediaMessage, messageHasVisionMedia } from "@/features/vision/detect";
import { mediaKindLabel, renderMediaSuffix, toVisionParts } from "@/features/vision/format";
import {
  describeAndStore,
  getMediaAnnotationsForMessages,
  ingestMessageMedia,
  loadReplyTargetImages,
} from "@/features/vision/server/service";
import { pokeVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import { ApiError } from "@/lib/api-error";
import { chatCompletion, type ChatContentPart, type ChatMessage } from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import { runWithToolContext } from "@/server/mcp/context";

/**
 * In-process Telegram bot lifecycle (long polling), owned by a single manager.
 *
 * Per the recorded decision: the poller runs inside the Next.js server process
 * (started from `instrumentation.ts`), not a separate worker. Telegram permits
 * exactly one `getUpdates` consumer per token, so exactly one poller may run —
 * enforced here by a `globalThis` singleton that survives module re-evaluation
 * across Next bundles (instrumentation vs. Route Handlers) and dev hot-reload.
 *
 * The manager reads its token and LLM runtime from DB-backed settings at
 * start/handle time, so no bot secret lives in env. Reply generation resolves
 * the current LLM config per message; a token change requires a restart (the
 * poller binds the token at start).
 */

export type BotState = "stopped" | "running" | "error";

export interface BotStatus {
  state: BotState;
  username: string | null;
  /** ISO time the current run started, or null when not running. */
  since: string | null;
  /** Last error message when `state` is `error`, else null. */
  error: string | null;
}

interface ManagerStore {
  bot: Bot | null;
  status: BotStatus;
  /** Guards against overlapping start/stop calls. */
  transitioning: boolean;
}

const STORE_KEY = Symbol.for("llm-tg-bot.telegram.bot-manager");

const STOPPED: BotStatus = { state: "stopped", username: null, since: null, error: null };

function store(): ManagerStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: ManagerStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { bot: null, status: { ...STOPPED }, transitioning: false };
  }
  return g[STORE_KEY];
}

/** Current bot status. Cheap and synchronous — safe for status probes. */
export function getBotStatus(): BotStatus {
  return { ...store().status };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  ctx: Context,
  bot: { id: number; username: string },
  policy: BotPolicy,
  personalityPrompt: string | null,
  visionAttachment: { imageParts: ChatContentPart[]; note?: string } | null,
): BotMessagingDeps {
  const chatId = String(ctx.chat!.id);
  const isGroup = ctx.chat!.type !== "private";
  const currentMessageId = ctx.message!.message_id;
  const senderId = ctx.from?.id != null ? String(ctx.from.id) : null;
  const botLabel = `You (@${bot.username})`;

  return {
    bot,
    policy,
    personalityPrompt,
    loadVision: visionAttachment ? async () => visionAttachment : undefined,
    startTyping() {
      // Preserve the forum-topic thread so typing shows in the right place.
      const threadId = ctx.message?.message_thread_id;
      const other = threadId != null ? { message_thread_id: threadId } : undefined;
      const tick = () => void ctx.replyWithChatAction("typing", other).catch(() => undefined);
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
        loadMediaSuffixes: async (ids) => {
          const annotations = await getMediaAnnotationsForMessages(chatId, ids);
          const suffixes = new Map<number, string>();
          for (const [id, annotation] of annotations) {
            const suffix = renderMediaSuffix(annotation);
            if (suffix) suffixes.set(id, suffix);
          }
          return suffixes;
        },
      });
    },
    // Render the current message as a transcript line: id anchor, sender label,
    // and its reply target resolved against the mirror (an anchor when stored,
    // the quoted sender + full text inlined when not). Best-effort — a failure
    // falls back to the raw text rather than dropping the reply.
    loadCurrentTurn: () => {
      const message = ctx.message!;
      const from = ctx.from;
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
    async recordReply(input) {
      await recordAssistantMessage({
        chatId,
        telegramMessageId: input.telegramMessageId,
        content: input.content,
        replyToMessageId: input.replyToMessageId,
      });
    },
    async generateReply(messages: ChatMessage[], onToolCall) {
      const runtime = await getLlmRuntime();
      if (!runtime) {
        throw ApiError.serviceUnavailable("LLM is not configured — set the endpoint and model in Settings");
      }
      const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };
      // No tools registered → a single inference (cache-friendly path). A reply
      // that needs no tool still costs one inference even when tools are offered.
      const toolset = await getToolset();
      if (!toolset) {
        return chatCompletion(conn, { model: runtime.model, messages });
      }
      // Run the tool-call loop with the current chat bound, so tools only ever
      // read this conversation's data.
      return runWithToolContext({ chatId }, () =>
        chatCompletionWithTools(conn, {
          model: runtime.model,
          messages,
          tools: toolset.tools,
          callTool: toolset.callTool,
          onToolCall: (rec) =>
            onToolCall?.({ name: rec.name, args: rec.args, result: rec.result, ok: rec.ok }),
        }),
      );
    },
    async sendReply(text: string) {
      const sent = await ctx.reply(text, {
        reply_parameters: { message_id: currentMessageId },
      });
      return { messageId: sent.message_id };
    },
  };
}

/** Map a grammy update to the service's normalized input and handle it. */
async function onMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  // Live traffic: push the idle vision-backfill run out and yield any batch in
  // flight, so backfill only ever runs while the bot is quiet.
  pokeVisionBackfill();

  // Remember every human sender + mirror every human message (addressed or not),
  // so the operator sees who talks to the bot and the history window has the full
  // running conversation. Both are best-effort and must not block handling.
  const from = ctx.from;
  const text = message.text ?? message.caption ?? "";
  const chat = ctx.chat;
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

  // Vision: ingest this message's media (passive, stored as base64) and resolve
  // the image(s) to attach to the current turn — either on the message itself or
  // on a replied-to image. The bot token (from settings) is needed to download
  // Telegram files. Best-effort — any failure just yields a text-only reply.
  let visionAttachment: { imageParts: ChatContentPart[]; note?: string } | null = null;
  let currentMediaIngested = false;
  const replyMedia = hasMedia ? null : findReplyMediaMessage(message);
  if (hasMedia || replyMedia) {
    const token = await getTelegramBotToken().catch(() => null);
    if (token) {
      if (hasMedia) {
        const ingested = await ingestMessageMedia({
          token,
          chatId,
          telegramMessageId: message.message_id,
          message,
        }).catch(() => null);
        if (ingested && ingested.images.length > 0) {
          // A video/GIF becomes an ordered, labelled frame sequence; the note
          // explains the frames are one clip in order.
          visionAttachment = {
            imageParts: toVisionParts(ingested.images),
            note: ingested.note ?? undefined,
          };
          currentMediaIngested = true;
        }
      } else if (replyMedia) {
        const loaded = await loadReplyTargetImages({ token, chatId, message: replyMedia }).catch(
          () => null,
        );
        if (loaded && loaded.images.length > 0) {
          const base = `The user is asking about the ${mediaKindLabel(loaded.kind)} they replied to (shown here).`;
          visionAttachment = {
            imageParts: toVisionParts(loaded.images),
            note: loaded.note ? `${base} ${loaded.note}` : base,
          };
        }
      }
    }
  }

  const incoming: IncomingMessage = {
    message,
    chatId: ctx.chat.id,
    chatType: ctx.chat.type,
    messageId: message.message_id,
    fromId: ctx.from?.id,
    fromIsBot: ctx.from?.is_bot ?? false,
    text,
    // A loadable image (on this message or a replied-to one) makes a caption-less
    // message real content, so it is answered and described like any other.
    hasVision: visionAttachment != null,
  };

  const [policy, personalityPrompt] = await Promise.all([
    getBotPolicy(),
    getActivePersonalityPrompt(),
  ]);

  const outcome = await handleIncomingMessage(
    incoming,
    buildDeps(
      ctx,
      { id: ctx.me.id, username: ctx.me.username },
      policy,
      personalityPrompt,
      visionAttachment,
    ),
  );

  // Immediate describe + resave for media on the answered message: the model
  // already saw the image in the reply; now caption it to text and drop the
  // bytes so the next turn's transcript carries a description, not base64. Only
  // the current message's media is described now — other media waits for the
  // backfill job (priority 8).
  if (currentMediaIngested && outcome.status === "replied") {
    const runtime = await getLlmRuntime().catch(() => null);
    if (runtime) {
      const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };
      await describeAndStore(
        { chatId, telegramMessageId: message.message_id },
        { complete: (messages) => chatCompletion(conn, { model: runtime.model, messages }) },
      ).catch(() => undefined);
    }
  }
}

/**
 * Mirror a Telegram `edited_message` into history so the stored conversation
 * tracks edits 1:1. Only text/caption edits are mirrored; edits with no textual
 * content are ignored.
 */
async function onEditedMessage(ctx: Context): Promise<void> {
  const edited = ctx.editedMessage;
  if (!edited || !ctx.chat) return;
  const content = edited.text ?? edited.caption ?? "";
  if (!content.trim()) return;

  await applyMessageEdit(
    {
      chatId: String(ctx.chat.id),
      telegramMessageId: edited.message_id,
      content,
      editedAt: new Date((edited.edit_date ?? edited.date) * 1000),
    },
    {
      kind: "telegram",
      actor: ctx.from ? String(ctx.from.id) : String(ctx.chat.id),
      correlationId: `${ctx.chat.id}:${edited.message_id}`,
    },
  ).catch((err) => {
    console.error("Failed to mirror edited message:", errorMessage(err));
  });
}

/**
 * Start (or restart) the poller using the token from DB settings. Idempotent and
 * safe to call from autostart or a dashboard control. Returns the resulting
 * status; a missing/invalid token settles as `error` rather than throwing, so
 * boot never crashes on an unconfigured bot.
 */
export async function startBot(): Promise<BotStatus> {
  const s = store();
  if (s.transitioning) return { ...s.status };
  s.transitioning = true;
  try {
    if (s.bot) await stopBotInternal(s);

    const token = await getTelegramBotToken();
    if (!token) {
      // Not an error — the bot simply isn't configured yet. Kept as `stopped`
      // so the dashboard doesn't show a stale "error" once a token is saved.
      s.status = { ...STOPPED };
      return { ...s.status };
    }

    const bot = new Bot(token);
    bot.on("message", (ctx) => onMessage(ctx));
    bot.on("edited_message", (ctx) => onEditedMessage(ctx));
    bot.catch((err) => {
      console.error("Telegram bot error:", err.error);
    });

    try {
      await bot.init(); // getMe — validates the token and populates bot.botInfo
    } catch (err) {
      s.status = { state: "error", username: null, since: null, error: errorMessage(err) };
      return { ...s.status };
    }

    s.bot = bot;
    s.status = {
      state: "running",
      username: bot.botInfo.username,
      since: new Date().toISOString(),
      error: null,
    };

    // Long-polling loop; do not await (it resolves only when the bot stops).
    void bot.start({ allowed_updates: ["message", "edited_message"] }).catch((err) => {
      s.bot = null;
      s.status = { ...s.status, state: "error", error: errorMessage(err) };
    });

    return { ...s.status };
  } finally {
    s.transitioning = false;
  }
}

async function stopBotInternal(s: ManagerStore): Promise<void> {
  if (s.bot) {
    try {
      await s.bot.stop();
    } catch (err) {
      console.error("Failed to stop Telegram bot:", errorMessage(err));
    }
    s.bot = null;
  }
  s.status = { ...STOPPED };
}

/** Stop the poller. Idempotent. */
export async function stopBot(): Promise<BotStatus> {
  const s = store();
  if (s.transitioning) return { ...s.status };
  s.transitioning = true;
  try {
    await stopBotInternal(s);
    return { ...s.status };
  } finally {
    s.transitioning = false;
  }
}
