import type { Message } from "@grammyjs/types";

import type { BotIdentity } from "@/features/bot-messaging/server/addressing";
import type { MenuKeyboard } from "@/features/self-improvement/menu";

/**
 * Transport boundary between the Telegram edge and the message-processing
 * pipeline. The bot is only a *source of events* (an incoming update) and a
 * *sink* (reply + typing) — everything in between (remember, mirror, vision,
 * prompt, tools, LLM, trace) is transport-agnostic. Splitting this seam lets the
 * whole real pipeline run with no bot: the grammy adapter wraps a live `Context`,
 * a test harness wraps a synthetic update with a capturing sink.
 */

export type { BotIdentity };

/** A normalized incoming message update, decoupled from grammy's `Context`. */
export interface IncomingUpdate {
  /** The Telegram message (grammy / `@grammyjs/types` shape). */
  message: Message;
  /** The bot's own identity (id + username), used for addressing + labels. */
  botInfo: BotIdentity;
  /**
   * Resolve the Telegram bot token used to download media files (vision). Called
   * lazily — only when the turn actually carries media — so a text-only flow
   * never needs one. Returns null when unavailable (e.g. a simulated update with
   * no real Telegram files behind it).
   */
  resolveToken: () => Promise<string | null>;
}

/** The outbound sink: deliver replies + typing back to the originating chat. */
export interface ReplyTransport {
  /** Deliver a reply, resolving with its delivered message id. */
  sendReply(
    text: string,
    opts: { replyToMessageId: number; threadId?: number },
  ): Promise<{ messageId: number }>;
  /**
   * Show the "typing…" chat action once. The pipeline owns the refresh loop
   * (Telegram expires the action after a few seconds), so this is a single tick.
   */
  sendTyping(opts: { threadId?: number }): void;
}

/**
 * Outbound ops the feedback-menu flows need (reaction → menu → answer). Same
 * seam pattern as {@link ReplyTransport}: a grammy adapter in the bot manager,
 * a capturing fake in the simulation harness.
 */
export interface FeedbackTransport {
  /** Post the options menu into the chat, resolving with its message id. */
  sendMenu(input: {
    chatId: string;
    text: string;
    keyboard: MenuKeyboard;
    replyToMessageId: number;
  }): Promise<{ messageId: number }>;
  /** Rewrite a previously sent menu message (`null` keyboard removes it). */
  editMenu(input: {
    chatId: string;
    messageId: number;
    text: string;
    keyboard: MenuKeyboard | null;
  }): Promise<void>;
  /** Answer a callback query (stops the button spinner; optional toast text). */
  answerCallback(input: { callbackQueryId: string; text?: string }): Promise<void>;
}
