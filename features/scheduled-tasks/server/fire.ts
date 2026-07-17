import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { formatReply } from "@/features/bot-messaging/server/reply";
import { buildSystemPrompt } from "@/features/bot-messaging/server/prompt";
import { FEATURES } from "@/lib/features";
import { buildLanguageInstruction } from "@/lib/language";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { llmUsageOf, sanitizeMessagesForTrace } from "@/server/llm/client";
import { startTrace } from "@/server/trace";

import type { ScheduledTask } from "../types";

/**
 * Firing a scheduled task: compose an out-of-band prompt (base system prompt +
 * active persona + the task directive), have the LLM write an in-character chat
 * message that *performs* the directive, deliver it, mirror it into history, and
 * record the whole pass as a trace under the `scheduled-tasks` feature.
 *
 * Collaborators (LLM completion, delivery, history mirror) are injected so the
 * fire is unit-testable without a live LLM or Telegram, and so the scheduler can
 * bind them once per run. Advancing the schedule (`next_run_at`) and the capped
 * `recent_deliveries` is the caller's job — {@link fireScheduledTask} only
 * returns the delivered text.
 */

const FEATURE = FEATURES["scheduled-tasks"];

/** Collaborators the fire needs. */
export interface FireDeps {
  /** The active personality prompt to compose into the system prompt, or null. */
  personalityPrompt: string | null;
  /**
   * The reply language required for this task's chat (operator-configured, or the
   * default). Injected as a strict directive before the task directive so the
   * fired message is in the chat's language. Null/absent → no directive.
   */
  requiredLanguage?: string | null;
  /** Generate the task message. Throws on provider/config failure. */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /** Deliver the message to the chat; resolves the delivered Telegram message id. */
  send: (text: string) => Promise<{ messageId: number }>;
  /** Mirror the delivered message into history (best-effort). */
  recordReply?: (input: {
    chatId: string;
    telegramMessageId: number;
    content: string;
  }) => Promise<void>;
  db?: DrizzleDb;
}

/** Outcome of a fire: whether a message was delivered, and its text/id if so. */
export interface FireResult {
  ok: boolean;
  text?: string;
  messageId?: number;
}

/** True when the text has at least one letter or digit (not just punctuation). */
function hasVisibleContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Build the directive user message. Recurring tasks get their recent deliveries
 * fed back so the model varies its wording; a one-shot has none. Grounded in the
 * MVP `features/tasks/fire.ts` `buildTaskUserMessage`, trimmed for this project's
 * plain-text (no chat-tag) delivery.
 */
export function buildTaskDirectiveMessage(
  instruction: string,
  recentDeliveries: string[],
): string {
  const previousBlock =
    recentDeliveries.length > 0
      ? `\n\nYou have delivered this recurring task before. Your most recent messages for it (newest first):\n` +
        recentDeliveries.map((text, i) => `${i + 1}. ${text}`).join("\n") +
        `\nSay the same thing a DIFFERENT way this time — fresh wording, angle, or phrasing. Do not reuse a sentence from the list above.`
      : "";
  return (
    `[SCHEDULED TASK] A standing task set up for this chat is now due. Deliver it now.\n` +
    `Directive: ${instruction}\n\n` +
    `Write ONE short, natural, in-character chat message that *performs* this directive right now. ` +
    `The message IS the reminder/nudge itself, spoken to the people it concerns.\n` +
    `- Do NOT restate the directive as an instruction. Never write "remind X to …" — instead say what you would actually tell them (e.g. directive "remind me to call mom" → "Hey, don't forget to call your mom").\n` +
    `- Address people by name when you know it; if it concerns the person who set it up, address them directly ("you").\n` +
    `- Plain spoken text only. Do not mention that this is scheduled or automated.${previousBlock}\n` +
    `Output only the message text.`
  );
}

/**
 * Generate and deliver one task's message. Returns `{ ok: false }` (never throws)
 * when generation/delivery fails or the model produced no visible content, so the
 * scheduler can still advance the schedule and move on.
 */
export async function fireScheduledTask(task: ScheduledTask, deps: FireDeps): Promise<FireResult> {
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "fire",
      trigger: { kind: "cron", actor: task.chatId, correlationId: task.id },
      inputSummary: task.instruction,
    }
  );
  try {
    const languageInstruction = deps.requiredLanguage?.trim()
      ? buildLanguageInstruction(deps.requiredLanguage)
      : null;
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ personalityPrompt: deps.personalityPrompt }) },
      ...(languageInstruction
        ? [{ role: "system" as const, content: languageInstruction }]
        : []),
      { role: "user", content: buildTaskDirectiveMessage(task.instruction, task.recentDeliveries ?? []) },
    ];
    await trace.event({
      type: "llm_request",
      message: "request",
      data: { messages: sanitizeMessagesForTrace(messages) },
    });

    let reply: ChatCompletionResult;
    try {
      reply = await deps.complete(messages);
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: "generation failed",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      await trace.skip(undefined, { outputSummary: "generation failed" });
      return { ok: false };
    }
    await trace.event({
      type: "llm_response",
      message: "response",
      data: reply.responseBody ?? { content: reply.content },
      usage: llmUsageOf(reply),
    });

    const outgoing = formatReply(reply.content);
    if (!hasVisibleContent(outgoing)) {
      await trace.event({ type: "step", level: "warn", message: "empty reply — nothing to deliver" });
      await trace.skip(undefined, { outputSummary: "empty reply" });
      return { ok: false };
    }

    let messageId: number;
    try {
      ({ messageId } = await deps.send(outgoing));
    } catch (err) {
      await trace.fail(err);
      return { ok: false };
    }
    await trace.event({
      type: "output",
      level: "success",
      message: "send message",
      data: { content: outgoing, messageId },
    });

    // Mirror into history so the fired message is part of the conversation and
    // future variation context. Best-effort — never fail a delivered message.
    try {
      await deps.recordReply?.({ chatId: task.chatId, telegramMessageId: messageId, content: outgoing });
    } catch {
      // swallow — the message was delivered; the mirror is a side record
    }

    // A fire has no incoming message to key on, so it opens on the task id and
    // settles on what it delivered. That puts it on the app-wide
    // `<chatId>:<messageId>` convention: feedback on this message can resolve the
    // trace behind it, and the chat-scoped trace queries count it like any other
    // message in the chat. The task itself stays linked via `relatedIds`.
    await trace.succeed({
      outputSummary: outgoing,
      relatedIds: { [FEATURE.relatedIdsKey]: [task.id] },
      correlationId: `${task.chatId}:${messageId}`,
    });
    return { ok: true, text: outgoing, messageId };
  } catch (err) {
    await trace.fail(err);
    return { ok: false };
  }
}
