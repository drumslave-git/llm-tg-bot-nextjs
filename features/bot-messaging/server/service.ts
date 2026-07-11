import "server-only";

import type { Message } from "@grammyjs/types";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import type { ChatMessage, ChatUsage } from "@/server/llm/client";
import { startTrace } from "@/server/trace";
import { checkAddressed, type AddressSource, type BotIdentity } from "./addressing";
import { formatReply } from "./reply";

/**
 * Bot-messaging domain service — the boundary the Telegram runtime calls for
 * each incoming message. It owns addressing, ignore policy, reply generation,
 * delivery, and trace recording. Collaborators (reply generation, delivery) are
 * injected so the policy is unit-testable without a live LLM or Telegram.
 *
 * Only messages the bot actually acts on are traced; ordinary un-addressed group
 * chatter returns an `ignored` outcome without writing a trace (avoids noise).
 */

const FEATURE = "bot-messaging";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant replying to Telegram messages. " +
  "Keep replies concise and plain-text.";

const ERROR_REPLY = "Sorry — I couldn't generate a reply just now. Please try again.";

/** Result of a reply generation, as returned by the injected generator. */
export interface GeneratedReply {
  content: string;
  model: string;
  usage?: ChatUsage;
  latencyMs: number;
}

/** Normalized view of an incoming Telegram message (built by the runtime). */
export interface IncomingMessage {
  message: Message;
  chatId: number;
  chatType: string;
  messageId: number;
  fromId?: number;
  fromIsBot: boolean;
  /** Extracted user text (message text or media caption). */
  text: string;
}

/** Collaborators the service needs; injected for testability. */
export interface BotMessagingDeps {
  bot: BotIdentity;
  /** Generate assistant reply text. Throws on provider/config failure. */
  generateReply: (messages: ChatMessage[]) => Promise<GeneratedReply>;
  /** Deliver a reply back to the originating chat. */
  sendReply: (text: string) => Promise<void>;
  /**
   * Begin showing the "typing…" chat action, returning a function that stops it.
   * Called as soon as a message is addressed and stopped once the turn settles,
   * so the user sees activity during reply generation. The runtime owns
   * refreshing the action (Telegram expires it after a few seconds).
   */
  startTyping: () => () => void;
  db?: DrizzleDb;
}

export type HandleOutcome =
  | { status: "ignored"; reason: string; source?: AddressSource }
  | { status: "replied"; text: string }
  | { status: "error"; message: string };

/** Reason codes for an ignored message (kept stable for logs/metrics). */
type IgnoreReason = "from_bot" | "no_content" | "not_addressed";

function ignored(reason: IgnoreReason, source?: AddressSource): HandleOutcome {
  return { status: "ignored", reason, source };
}

/**
 * Handle one incoming Telegram message end to end: decide, generate, deliver,
 * and trace. Cheap ignore checks run before any trace is opened.
 */
export async function handleIncomingMessage(
  incoming: IncomingMessage,
  deps: BotMessagingDeps,
): Promise<HandleOutcome> {
  const db = deps.db ?? getDb();

  if (incoming.fromIsBot) return ignored("from_bot");

  const text = incoming.text.trim();
  if (!text) return ignored("no_content");

  const decision = checkAddressed(incoming.message, incoming.chatType, deps.bot);
  if (!decision.addressed) return ignored("not_addressed");

  // Addressed: show "typing…" immediately and keep it up until the turn settles.
  const stopTyping = deps.startTyping();
  try {
    const trace = await startTrace(
      {
        feature: FEATURE,
        action: "reply",
        trigger: {
          kind: "telegram",
          actor: incoming.fromId != null ? String(incoming.fromId) : String(incoming.chatId),
          correlationId: `${incoming.chatId}:${incoming.messageId}`,
        },
        inputSummary: text.slice(0, 200),
      },
      db,
    );

    try {
      await trace.event({
        type: "input",
        message: `addressed via ${decision.source}`,
        data: { chatType: incoming.chatType, source: decision.source },
      });

      const messages: ChatMessage[] = [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: text },
      ];
      await trace.event({ type: "llm_request", message: "chat completion requested" });

      const reply = await deps.generateReply(messages);
      await trace.event({
        type: "llm_response",
        message: "chat completion received",
        usage: {
          model: reply.model,
          promptTokens: reply.usage?.promptTokens,
          completionTokens: reply.usage?.completionTokens,
          totalTokens: reply.usage?.totalTokens,
          latencyMs: reply.latencyMs,
        },
      });

      const outgoing = formatReply(reply.content);
      await deps.sendReply(outgoing);
      await trace.event({ type: "output", message: `replied (${outgoing.length} chars)` });
      await trace.succeed({ outputSummary: outgoing.slice(0, 200) });
      return { status: "replied", text: outgoing };
    } catch (err) {
      await trace.fail(err);
      // Best-effort: let the user know something went wrong; never mask the
      // original failure if this send also fails.
      try {
        await deps.sendReply(ERROR_REPLY);
      } catch {
        // swallow — the trace already records the real error
      }
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    stopTyping();
  }
}
