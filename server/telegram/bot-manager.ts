import "server-only";

import { Bot, type Context } from "grammy";

import {
  getBotPolicy,
  getLlmRuntime,
  getTelegramBotToken,
} from "@/features/settings/server/service";
import type { BotPolicy } from "@/features/settings/server/service";
import {
  handleIncomingMessage,
  type BotMessagingDeps,
  type IncomingMessage,
} from "@/features/bot-messaging/server/service";
import { rememberUser } from "@/features/known-users/server/service";
import { ApiError } from "@/lib/api-error";
import { chatCompletion, type ChatMessage } from "@/server/llm/client";

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

/** Build the per-message collaborators the bot-messaging service needs. */
function buildDeps(
  ctx: Context,
  bot: { id: number; username: string },
  policy: BotPolicy,
): BotMessagingDeps {
  return {
    bot,
    policy,
    startTyping() {
      // Preserve the forum-topic thread so typing shows in the right place.
      const threadId = ctx.message?.message_thread_id;
      const other = threadId != null ? { message_thread_id: threadId } : undefined;
      const tick = () => void ctx.replyWithChatAction("typing", other).catch(() => undefined);
      tick();
      const interval = setInterval(tick, TYPING_REFRESH_MS);
      return () => clearInterval(interval);
    },
    async generateReply(messages: ChatMessage[]) {
      const runtime = await getLlmRuntime();
      if (!runtime) {
        throw ApiError.serviceUnavailable("LLM is not configured — set the endpoint and model in Settings");
      }
      return chatCompletion(
        { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey },
        { model: runtime.model, messages },
      );
    },
    async sendReply(text: string) {
      await ctx.reply(text, {
        reply_parameters: { message_id: ctx.message!.message_id },
      });
    },
  };
}

/** Map a grammy update to the service's normalized input and handle it. */
async function onMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  // Remember every human sender (all messages, addressed or not) so the operator
  // can see who talks to the bot and pick the owner from a concrete list.
  const from = ctx.from;
  if (from && !from.is_bot) {
    await rememberUser({
      userId: String(from.id),
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    });
  }

  const incoming: IncomingMessage = {
    message,
    chatId: ctx.chat.id,
    chatType: ctx.chat.type,
    messageId: message.message_id,
    fromId: ctx.from?.id,
    fromIsBot: ctx.from?.is_bot ?? false,
    text: message.text ?? message.caption ?? "",
  };

  const policy = await getBotPolicy();

  await handleIncomingMessage(
    incoming,
    buildDeps(ctx, { id: ctx.me.id, username: ctx.me.username }, policy),
  );
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
    void bot.start({ allowed_updates: ["message"] }).catch((err) => {
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
