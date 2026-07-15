import { z } from "zod";

/**
 * Per-chat reply language — shared, framework-free helpers.
 *
 * Each chat (a group, or a person's private chat) may have an operator-configured
 * language stored as a free-text string on its `known_groups` / `known_users` row.
 * When none is set the bot replies in {@link DEFAULT_CHAT_LANGUAGE}. The resolved
 * language is turned into a strict system directive by {@link buildLanguageInstruction}
 * and injected into every reply, so the bot always writes in the configured language
 * regardless of the language the user (or history, or a tool result) used.
 *
 * Pure and dependency-light (only zod) so the same helpers back the persistence
 * schemas, the Route Handlers, the dashboard, and the reply runtime.
 */

/** The language used when a chat has no configured language. */
export const DEFAULT_CHAT_LANGUAGE = "English";

/** Upper bound for the free-text language field (a language name, not a sentence). */
export const MAX_LANGUAGE_LEN = 100;

/** Collapse internal whitespace and trim, so "  Brazilian   Portuguese " → "Brazilian Portuguese". */
export function normalizeChatLanguage(language: string): string {
  return language.replace(/\s+/g, " ").trim();
}

/**
 * The language the bot must reply in for a chat: the stored value when set,
 * otherwise the default. Whitespace-only stored values fall back to the default.
 */
export function resolveRequiredLanguage(stored: string | null | undefined): string {
  const normalized = stored ? normalizeChatLanguage(stored) : "";
  return normalized || DEFAULT_CHAT_LANGUAGE;
}

/**
 * The strict system directive ordering the bot to reply in `language`. Worded to
 * override the language of anything else in the conversation — the incoming
 * message, quoted text, history, tool output, and the active personality — so the
 * reply language is controlled by configuration, not by whatever language the user
 * happened to write in. Tool-agnostic (names no tool).
 */
export function buildLanguageInstruction(language: string): string {
  const lang = normalizeChatLanguage(language) || DEFAULT_CHAT_LANGUAGE;
  return (
    `Write your reply in ${lang}. Every message you send to this chat must be in ${lang}. ` +
    `This is required and overrides the language of the incoming message, quoted text, conversation ` +
    `history, tool results, and the active personality: compose your reply in ${lang} even when the ` +
    `user writes in another language. You may still quote a foreign word or name where it is genuinely ` +
    `needed, but the reply itself must be written in ${lang}.`
  );
}

/**
 * Zod field for the operator-editable language input: a free-text language name.
 * Normalized (whitespace collapsed, trimmed); an empty result becomes null, which
 * clears the configuration so the chat falls back to {@link DEFAULT_CHAT_LANGUAGE}.
 */
export const languageField = z
  .string()
  .max(MAX_LANGUAGE_LEN, { message: `Language must be ${MAX_LANGUAGE_LEN} characters or fewer` })
  .transform((value) => {
    const normalized = normalizeChatLanguage(value);
    return normalized.length > 0 ? normalized : null;
  });
