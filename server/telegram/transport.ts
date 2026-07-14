import type { Message } from "@grammyjs/types";

import type { BotIdentity } from "@/features/bot-messaging/server/addressing";

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
