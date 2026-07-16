import { extractJsonObject } from "@/lib/json";
import type { ChatMessage } from "@/server/llm/client";

import type { BotIdentity } from "./addressing";

/**
 * The LLM half of the addressing check: does this group message call the bot by
 * name in a form a literal match cannot see — the same name in another alphabet,
 * or an inflected/vocative form?
 *
 * Prompt building and parsing are pure, so the whole decision is unit-testable
 * without a provider. The caller (the bot-messaging service) owns the completion
 * and the trace; this module owns what is asked and how the answer is read.
 *
 * The model classifies *how* the name appears instead of answering yes/no. A
 * bounded enum makes it commit to a conclusion that the decision is then derived
 * from in code, so a hedging or chatty model cannot talk its way into a reply —
 * and "absent" stays a specific, checkable answer rather than a shade of no.
 */

/** How the display name appears in the message. Anything but `absent` replies. */
export const NAME_MATCH_VALUES = ["exact", "other_alphabet", "inflected", "absent"] as const;

export type NameMatch = (typeof NAME_MATCH_VALUES)[number];

export const ANALYZER_SYSTEM_PROMPT = `You decide whether a group-chat message calls a Telegram bot by its display name.

@username mentions, replies to the bot, and slash commands are already handled elsewhere — judge only the spoken display name. An automated scan has already looked for the name spelled exactly as configured and found nothing, but it can only catch that exact spelling: it misses other alphabets, transliterations, and inflected forms. Judge the message yourself.

Classify how the display name appears:
- "exact" — the name, or a clear spelling/case variation of it
- "other_alphabet" — the same name written in another language or alphabet (for example a Cyrillic spelling of a Latin name)
- "inflected" — a vocative or otherwise declined grammatical form of the name (many languages inflect a name when addressing someone)
- "absent" — the name is not there

Answer "absent" when:
- The display name does not appear and is not clearly referenced
- People are talking among themselves; a second-person "you" alone is not the bot's name
- Generic words like "bot", "assistant", or "AI" appear without the specific display name
- It is background chatter the bot should not interrupt

Reply with ONLY a JSON object of the shape {"name_match": "exact" | "other_alphabet" | "inflected" | "absent"} — no code fences, no commentary.`;

export interface AnalyzerInput {
  bot: BotIdentity;
  chatType: string;
  /** The message's user text (body or caption). */
  text: string;
}

/** The messages for one analyzer call: the fixed rules, then this message. */
export function buildAnalyzerMessages(input: AnalyzerInput): ChatMessage[] {
  return [
    { role: "system", content: ANALYZER_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Bot display name: ${input.bot.displayName.trim()}\n` +
        `Bot username: @${input.bot.username.replace(/^@/, "")}\n` +
        `Chat type: ${input.chatType}\n\n` +
        `Message:\n${input.text.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface AnalyzerVerdict {
  addressed: boolean;
  /** The classification the model committed to, or null when it emitted none. */
  nameMatch: NameMatch | null;
  reason: string;
}

/**
 * Read the model's classification and derive the decision from it. An answer we
 * cannot understand is a "no": the bot stays out of a conversation it was never
 * shown to be part of.
 */
export function parseAnalyzerVerdict(content: string): AnalyzerVerdict {
  const raw = extractJsonObject(content)?.name_match;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (!value || !NAME_MATCH_VALUES.includes(value as NameMatch)) {
    return { addressed: false, nameMatch: null, reason: "unreadable analyzer answer" };
  }
  const nameMatch = value as NameMatch;
  const addressed = nameMatch !== "absent";
  return {
    addressed,
    nameMatch,
    reason: addressed ? `display name appears as ${nameMatch}` : "display name absent",
  };
}
