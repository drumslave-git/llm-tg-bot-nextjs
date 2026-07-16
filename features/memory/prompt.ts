/**
 * The two LLM passes the nightly consolidation job runs, and the parsing of what
 * they return. Pure and client-safe (no DB, no provider) so the whole decision
 * surface of the job is unit-testable without a database or a model.
 *
 * Both scopes are stored as one merged document (operator decision, 2026-07-16),
 * so both passes are a *merge*: existing document + new notes → rewritten
 * document, sharing {@link parseMergedDocument}. They stay two prompts rather than
 * one because they are rewriting genuinely different things — a `user` document is
 * about ONE named person and may say "they"; the `general` document is shared
 * knowledge where every fact must name its own subject.
 *
 * A `general` merge previously reconciled one note at a time (insert / skip /
 * replace) against the stored facts most similar to it, because general knowledge
 * was a set of independently embedded rows. That is gone with the rows.
 */

import { extractJsonObject } from "@/lib/json";

/** Bounds on what may be stored. A note longer than this is rejected at the tool. */
export const MIN_FACT_LENGTH = 2;
export const MAX_FACT_LENGTH = 4_000;

/* --------------------------------------------------- shared durability policy */

/**
 * What "durable" means, as one policy shared by both producers of the pending
 * queue: the `memory_save` tool (the model saving mid-reply) and passive
 * extraction (the nightly job reading the mirror). They are worded for different
 * jobs — one pushes a model to act now, the other harvests a finished day — but
 * they must agree on *what is worth remembering*, or the same sentence would be
 * remembered when the bot was spoken to and dropped when it was not.
 */
export const DURABLE_FACT_KINDS =
  "their name or what they want to be called, where they live or are from, their job or " +
  "studies, their family and pets, a stable preference or taste, a skill, a health constraint, " +
  "a boundary, a recurring plan, or a standing instruction about how they want you to behave";

/** The other half of the policy: what must never reach the queue. */
export const NON_DURABLE_FACT_KINDS =
  "guesses or inferences from vibes, passing moods, jokes, insults, one-off plans, or ordinary " +
  "chit-chat";

/** How a stored fact must be written, so it survives losing its conversation. */
export const SELF_CONTAINED_FACT_RULE =
  "write each as a single self-contained sentence that will still make sense to someone reading " +
  "it months later with no memory of this conversation (include the who and the what, not 'he " +
  "said yes')";

/* ------------------------------------------------------------------ user doc */

/** System prompt for the per-user document merge. */
export const USER_MERGE_PROMPT =
  "You maintain the long-term memory document a Telegram chat bot keeps about ONE person. " +
  "You are given the current document and newly saved facts about that same person. Rewrite the " +
  "document to incorporate the new facts.\n" +
  "Rules:\n" +
  "- Preserve every unique durable detail. This is lossless except where a fact is a duplicate, " +
  "is contradicted, or was never durable.\n" +
  "- Drop duplicates and near-duplicates: if a new fact restates something already there in " +
  "different words, keep one concise version.\n" +
  "- When a new fact contradicts an old one, keep the new one and drop the outdated line — people " +
  "move, change jobs, and change their minds.\n" +
  "- Write one fact per line, no bullet characters, no section headers, no preamble.\n" +
  "- Order loosely: identity and background first, then how they communicate, then what they like, " +
  "then what they dislike or want you to avoid.\n" +
  "- Never invent a fact that is not in the inputs.\n" +
  'Reply with ONLY a JSON object of the shape {"memory": string} — the whole document as one ' +
  'string with newline-separated facts. Use {"memory": ""} if nothing durable remains.';

export interface UserMergeInput {
  /** Human label of the person, so the document reads about someone rather than "the user". */
  label: string;
  /** The current document's facts (empty for a person with no memory yet). */
  existing: string[];
  /** The pending notes to fold in. */
  incoming: string[];
}

/** Build the user-document merge request (the user turn; system prompt is separate). */
export function buildUserMergeRequest(input: UserMergeInput): string {
  const existing = input.existing.length > 0 ? input.existing.join("\n") : "(nothing known yet)";
  const incoming = input.incoming.map((fact) => `- ${fact}`).join("\n");
  return [
    `The person this document is about: ${input.label}.`,
    "",
    "Current memory document:",
    existing,
    "",
    "Newly saved facts to fold in:",
    incoming,
  ].join("\n");
}

/**
 * The merged document the model returned, normalized to fact lines. Empty array
 * when the model reported nothing durable (or returned something unusable) —
 * callers treat an empty result as "leave the existing document alone" rather
 * than as "erase this person", so a bad model response can never destroy memory.
 */
export function parseMergedDocument(content: string): string[] {
  const obj = extractJsonObject(content);
  const raw = typeof obj?.memory === "string" ? obj.memory : null;
  if (raw == null) return [];
  return raw
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length >= MIN_FACT_LENGTH && !/^none$/i.test(line));
}

/* ----------------------------------------------------------------- general */

/** System prompt for the general-knowledge document merge. */
export const GENERAL_MERGE_PROMPT =
  "You maintain the long-term memory document a Telegram chat bot keeps of GENERAL knowledge — " +
  "shared facts, definitions, rules and conventions, plus facts about people the bot cannot file " +
  "under a person of their own. You are given the current document and newly saved facts. Rewrite " +
  "the document to incorporate the new facts.\n" +
  "Rules:\n" +
  "- Preserve every unique durable detail. This is lossless except where a fact is a duplicate, " +
  "is contradicted, or was never durable.\n" +
  "- Drop duplicates and near-duplicates: if a new fact restates something already there in " +
  "different words, keep one concise version.\n" +
  "- When a new fact contradicts an old one, keep the new one and drop the outdated line — " +
  "arrangements change and facts get corrected.\n" +
  "- Every line must name its own subject and stand on its own: this document is read with no " +
  "conversation around it, so never write 'he', 'they', or 'the above'. A fact about a person " +
  "must name that person.\n" +
  "- Write one fact per line, no bullet characters, no section headers, no preamble.\n" +
  "- Group related facts near each other so the document stays readable as it grows.\n" +
  "- Never invent a fact that is not in the inputs.\n" +
  'Reply with ONLY a JSON object of the shape {"memory": string} — the whole document as one ' +
  'string with newline-separated facts. Use {"memory": ""} if nothing durable remains.';

export interface GeneralMergeInput {
  /** The current document's facts (empty for a store with nothing in it yet). */
  existing: string[];
  /** The pending notes to fold in. */
  incoming: string[];
}

/** Build the general-document merge request (the user turn; system prompt is separate). */
export function buildGeneralMergeRequest(input: GeneralMergeInput): string {
  const existing = input.existing.length > 0 ? input.existing.join("\n") : "(nothing known yet)";
  const incoming = input.incoming.map((fact) => `- ${fact}`).join("\n");
  return [
    "Current general knowledge document:",
    existing,
    "",
    "Newly saved facts to fold in:",
    incoming,
  ].join("\n");
}
