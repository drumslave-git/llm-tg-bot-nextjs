import "server-only";

import type { Message } from "@grammyjs/types";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { FEATURES } from "@/lib/features";
import type { ChatContentPart, ChatMessage, ChatUsage } from "@/server/llm/client";
import { sanitizeMessagesForTrace } from "@/server/llm/client";
import { startTrace } from "@/server/trace";
import { checkAddressed, type AddressSource, type BotIdentity } from "./addressing";
import { checkMaintenance, isOwner, type BotPolicy } from "./policy";
import { buildAddressingHint, buildSystemPrompt, hasPersonality } from "./prompt";
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

const FEATURE = FEATURES["bot-messaging"];

const ERROR_REPLY = "Sorry — I couldn't generate a reply just now. Please try again.";

const MAINTENANCE_REPLY =
  "🛠️ The bot is in maintenance mode and is only responding to its owner right now. " +
  "Please try again later.";

/** Result of a reply generation, as returned by the injected generator. */
export interface GeneratedReply {
  content: string;
  model: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Raw provider response body, recorded verbatim in the trace. */
  responseBody?: unknown;
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
  /**
   * Whether this turn carries visual media the bot can read (an image on the
   * message, or on a replied-to message). A media-only message with no caption is
   * still real content — it must be addressed, answered, and described like any
   * other message — so it is not treated as empty.
   */
  hasVision?: boolean;
}

/** A delivered Telegram message, as reported back by the runtime. */
export interface SentMessage {
  messageId: number;
}

/**
 * A tool call executed while generating a reply, surfaced by the generator so the
 * service can record it on the reply trace. `result` is the tool's raw result.
 */
export interface ReplyToolCall {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

/** Collaborators the service needs; injected for testability. */
export interface BotMessagingDeps {
  bot: BotIdentity;
  /**
   * Generate assistant reply text. Throws on provider/config failure. When tools
   * are enabled the generator runs a tool-call loop and reports each executed
   * call via `onToolCall`, so the service records them on the reply trace.
   */
  generateReply: (
    messages: ChatMessage[],
    onToolCall?: (call: ReplyToolCall) => void | Promise<void>,
  ) => Promise<GeneratedReply>;
  /** Deliver a reply back to the originating chat; resolves with its delivered id. */
  sendReply: (text: string) => Promise<SentMessage>;
  /**
   * Load the current-day conversation window as prior turns to inject before the
   * current message. Injected so the service stays free of DB/history coupling.
   */
  loadHistory: () => Promise<{ messages: ChatMessage[]; count: number }>;
  /**
   * Load a context block to inject as a system message after the base system
   * prompt: in a group, the participant roster (known members + operator notes);
   * in a private chat, who the bot is talking to and their known names. Resolves
   * null when there is nothing to inject. `data` is recorded verbatim on the trace
   * step. Best-effort — must never fail the reply.
   */
  loadChatContext?: () => Promise<{ content: string; data?: Record<string, unknown> } | null>;
  /**
   * Render the current message in transcript-line format (`[#<id>] <sender> …`),
   * with its reply target resolved against the history mirror. `senderLabel`
   * feeds the group addressing hint; `data` is recorded verbatim on the trace
   * step. Best-effort — resolves null (raw text is used) rather than failing.
   */
  loadCurrentTurn?: () => Promise<{
    content: string;
    senderLabel: string | null;
    data?: Record<string, unknown>;
  } | null>;
  /**
   * Load visual media to attach to the current turn (photo/sticker/etc. on the
   * message, or on a replied-to message). Returns the image content parts to
   * splice into the user turn plus an optional note (e.g. "asking about the
   * photo they replied to"). Null when the turn carries no media. Best-effort —
   * the reply proceeds text-only if this fails.
   */
  loadVision?: () => Promise<{ imageParts: ChatContentPart[]; note?: string } | null>;
  /** Persist the delivered assistant reply into the history mirror (best-effort). */
  recordReply: (input: {
    content: string;
    telegramMessageId: number;
    replyToMessageId: number;
  }) => Promise<void>;
  /**
   * Begin showing the "typing…" chat action, returning a function that stops it.
   * Called as soon as a message is addressed and stopped once the turn settles,
   * so the user sees activity during reply generation. The runtime owns
   * refreshing the action (Telegram expires it after a few seconds).
   */
  startTyping: () => () => void;
  /** Owner + maintenance-mode state, resolved from settings by the runtime. */
  policy: BotPolicy;
  /**
   * Operator-configured persona instructions (from settings), composed into the
   * system prompt for this reply. Null/absent → base prompt only.
   */
  personalityPrompt?: string | null;
  db?: DrizzleDb;
}

export type HandleOutcome =
  | { status: "ignored"; reason: string; source?: AddressSource }
  | { status: "replied"; text: string }
  | { status: "error"; message: string };

/** Reason codes for an ignored message (kept stable for logs/metrics). */
type IgnoreReason = "from_bot" | "no_content" | "not_addressed" | "maintenance_mode";

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
  // A media-only message (no caption) still carries content — its image — so it
  // is processed like any other message rather than ignored as empty.
  if (!text && !incoming.hasVision) return ignored("no_content");

  const decision = checkAddressed(incoming.message, incoming.chatType, deps.bot);
  if (!decision.addressed) return ignored("not_addressed");

  // Maintenance gate: the bot stays fully functional for the owner; everyone
  // else is turned away with a static notice (not silence) and generates no LLM
  // reply. The block is still traced so the operator sees who was turned away.
  const owner = isOwner({ fromId: incoming.fromId }, deps.policy);
  const maintenance = checkMaintenance({ policy: deps.policy, owner });
  if (maintenance.blocked) {
    const trace = await startTrace(
      {
        feature: FEATURE.id,
        action: "reply",
        trigger: {
          kind: "telegram",
          actor: incoming.fromId != null ? String(incoming.fromId) : String(incoming.chatId),
          correlationId: `${incoming.chatId}:${incoming.messageId}`,
        },
        inputSummary: text,
      },
      db,
    );
    await trace.event({
      type: "step",
      level: "success",
      message: "addressing check",
      data: { addressed: true, reason: decision.source },
    });
    await trace.event({
      type: "step",
      level: "warn",
      message: "maintenance mode — blocked",
      data: { reason: maintenance.reason },
    });
    // Best-effort: let the user know it's maintenance, not a failure.
    try {
      await deps.sendReply(MAINTENANCE_REPLY);
      await trace.event({
        type: "output",
        message: "maintenance notice sent",
        data: { content: MAINTENANCE_REPLY },
      });
    } catch {
      // swallow — the trace still records the block
    }
    await trace.skip(undefined, { outputSummary: `maintenance mode — ${maintenance.reason}` });
    return ignored("maintenance_mode", decision.source);
  }

  // Addressed: show "typing…" immediately and keep it up until the turn settles.
  const stopTyping = deps.startTyping();
  try {
    const trace = await startTrace(
      {
        feature: FEATURE.id,
        action: "reply",
        trigger: {
          kind: "telegram",
          actor: incoming.fromId != null ? String(incoming.fromId) : String(incoming.chatId),
          correlationId: `${incoming.chatId}:${incoming.messageId}`,
        },
        // The whole incoming message, never trimmed.
        inputSummary: text,
      },
      db,
    );

    try {
      // 1. Addressing decision (a passed check → green).
      await trace.event({
        type: "step",
        level: "success",
        message: "addressing check",
        data: { addressed: true, reason: decision.source },
      });

      // 2. Compose the system prompt (base + operator personality) and record it
      // so the operator can see exactly what persona drove the reply.
      const systemPrompt = buildSystemPrompt({ personalityPrompt: deps.personalityPrompt });
      await trace.event({
        type: "step",
        message: "system prompt composed",
        data: {
          personalityApplied: hasPersonality(deps.personalityPrompt),
          systemPrompt,
        },
      });

      // 2b. Chat context — injected as a system message so the model knows who it
      // is talking to: in a group, the roster of known participants (plus operator
      // notes); in a private chat, the identity of the person and their known
      // names. Skipped when there is nothing to inject.
      let chatContext: { content: string; data?: Record<string, unknown> } | null = null;
      if (deps.loadChatContext) {
        chatContext = await deps.loadChatContext();
        if (chatContext) {
          await trace.event({
            type: "step",
            message: "chat context loaded",
            data: chatContext.data ?? {},
          });
        }
      }

      // 2c. Current turn — the message being answered, rendered in the same
      // transcript-line format as history (id anchor, sender label, resolved
      // reply target). Falls back to the raw text when no loader is wired.
      const currentTurn = deps.loadCurrentTurn ? await deps.loadCurrentTurn() : null;
      // Group addressing hint: who is asking and how they addressed the bot, so
      // the model separates the requester from the people being talked about.
      const addressingHint = buildAddressingHint({
        senderLabel: currentTurn?.senderLabel ?? null,
        source: decision.source ?? "",
      });
      if (currentTurn) {
        await trace.event({
          type: "step",
          message: "current turn composed",
          data: { ...(currentTurn.data ?? { content: currentTurn.content }), addressingHint },
        });
      }

      // 3. Load the recent-history window (last 24 hours) and inject it as one
      // transcript message between the (cache-stable) system prompt and the
      // current message.
      const history = await deps.loadHistory();
      await trace.event({
        type: "step",
        message: "history window loaded",
        data: { messageCount: history.count },
      });

      // 3b. Vision — attach any image(s) on this turn (or a replied-to image) to
      // the current user message so the model reads them alongside the text.
      const userText = currentTurn?.content ?? text;
      let userContent: string | ChatContentPart[] = userText;
      const vision = deps.loadVision ? await deps.loadVision() : null;
      // Attach the images when present; otherwise (media-only, answered from the
      // recognition text) fold the description note into the turn text.
      if (vision && (vision.imageParts.length > 0 || vision.note)) {
        const promptText = vision.note ? `${userText}\n\n${vision.note}` : userText;
        userContent =
          vision.imageParts.length > 0
            ? [{ type: "text", text: promptText }, ...vision.imageParts]
            : promptText;
        await trace.event({
          type: "step",
          message: "vision media attached",
          data: { imageCount: vision.imageParts.length, hasNote: Boolean(vision.note) },
        });
      }

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...(chatContext ? [{ role: "system" as const, content: chatContext.content }] : []),
        ...(addressingHint ? [{ role: "system" as const, content: addressingHint }] : []),
        ...history.messages,
        { role: "user", content: userContent },
      ];
      // 4. LLM request — full request body (recorded before the call so the
      // response step's elapsed time reflects real provider latency). Inline
      // image bytes are replaced with a compact marker (the real image is on the
      // Vision page); all readable content is kept verbatim.
      await trace.event({
        type: "llm_request",
        message: "request",
        data: { messages: sanitizeMessagesForTrace(messages) },
      });

      // Record each tool call the generator runs (if any) as it happens, so the
      // reply trace shows the full tool-call loop between request and response.
      const reply = await deps.generateReply(messages, async (call) => {
        await trace.event({
          type: "external_call",
          level: call.ok ? "info" : "warn",
          message: `tool: ${call.name}`,
          data: { args: call.args, result: call.result },
        });
      });
      // 4. LLM response — full raw response body + model/token stats.
      await trace.event({
        type: "llm_response",
        message: "response",
        data: reply.responseBody ?? { content: reply.content },
        usage: {
          model: reply.model,
          promptTokens: reply.usage?.promptTokens,
          completionTokens: reply.usage?.completionTokens,
          totalTokens: reply.usage?.totalTokens,
          latencyMs: reply.latencyMs,
        },
      });

      const outgoing = formatReply(reply.content);
      const sent = await deps.sendReply(outgoing);
      // 5. Delivered message — full content.
      await trace.event({
        type: "output",
        level: "success",
        message: "send message",
        data: { content: outgoing, messageId: sent.messageId },
      });
      // Mirror the reply into history (best-effort — never fail a delivered
      // reply because persistence hiccupped).
      try {
        await deps.recordReply({
          content: outgoing,
          telegramMessageId: sent.messageId,
          replyToMessageId: incoming.messageId,
        });
      } catch {
        // swallow — the reply was delivered; the mirror is a side record
      }
      await trace.succeed({ outputSummary: outgoing });
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
