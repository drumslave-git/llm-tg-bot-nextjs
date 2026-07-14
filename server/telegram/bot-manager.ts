import "server-only";

import { Bot, type Context } from "grammy";

import { getTelegramBotToken } from "@/features/settings/server/service";

import { processEditedUpdate, processUpdate } from "./process-update";
import type { IncomingUpdate, ReplyTransport } from "./transport";

/**
 * In-process Telegram bot lifecycle (long polling), owned by a single manager.
 *
 * Per the recorded decision: the poller runs inside the Next.js server process
 * (started from `instrumentation.ts`), not a separate worker. Telegram permits
 * exactly one `getUpdates` consumer per token, so exactly one poller may run —
 * enforced here by a `globalThis` singleton that survives module re-evaluation
 * across Next bundles (instrumentation vs. Route Handlers) and dev hot-reload.
 *
 * This module is now only the Telegram *edge*: the poller lifecycle plus a thin
 * grammy adapter that maps a live `Context` onto the transport-agnostic
 * {@link processUpdate} pipeline. All message-handling logic lives in
 * `process-update.ts`, so it runs identically without a bot (see `test/simulate`).
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

/**
 * Send an out-of-band message to a chat, outside any incoming update (used by the
 * scheduled-tasks fire path). Requires the poller to be running — Telegram's `api`
 * lives on the active bot. Throws when the bot is not running so the caller can
 * record the failure. Resolves the delivered message id.
 */
export async function sendChatMessage(
  chatId: string,
  text: string,
  opts: { threadId?: number | null } = {},
): Promise<{ messageId: number }> {
  const bot = store().bot;
  if (!bot) throw new Error("Telegram bot is not running");
  const sent = await bot.api.sendMessage(chatId, text, {
    ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
  });
  return { messageId: sent.message_id };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Grammy `Context` as the outbound sink for the pipeline. */
function grammyTransport(ctx: Context): ReplyTransport {
  return {
    async sendReply(text, opts) {
      const sent = await ctx.reply(text, {
        reply_parameters: { message_id: opts.replyToMessageId },
      });
      return { messageId: sent.message_id };
    },
    sendTyping(opts) {
      const other =
        opts.threadId != null ? { message_thread_id: opts.threadId } : undefined;
      void ctx.replyWithChatAction("typing", other).catch(() => undefined);
    },
  };
}

/** Map a grammy message update onto the transport-agnostic pipeline. */
async function onMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  const update: IncomingUpdate = {
    message,
    botInfo: { id: ctx.me.id, username: ctx.me.username },
    // The token is only needed when the turn carries media; resolve it lazily.
    resolveToken: () => getTelegramBotToken(),
  };
  await processUpdate(update, grammyTransport(ctx));
}

/** Map a grammy `edited_message` update onto the history-edit mirror. */
async function onEditedMessage(ctx: Context): Promise<void> {
  const edited = ctx.editedMessage;
  if (!edited || !ctx.chat) return;
  await processEditedUpdate(edited);
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
