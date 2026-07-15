/**
 * The two LLM passes the nightly consolidation job runs, and the parsing of what
 * they return. Pure and client-safe (no DB, no provider) so the whole decision
 * surface of the job is unit-testable without a database or a model.
 *
 * The scopes need different passes because they are stored differently (recorded
 * decision):
 *  - a `user` memory is ONE document, so its pass is a *merge*: existing document
 *    + new notes → rewritten document.
 *  - a `general` memory is a SET of independently embedded fact rows, so its pass
 *    is a *reconcile*: one new note is compared against the existing facts most
 *    similar to it and becomes an insert, a skip, or a replacement.
 */

import { extractJsonObject } from "@/lib/json";

/** Bounds on what may be stored. A note longer than this is rejected at the tool. */
export const MIN_FACT_LENGTH = 2;
export const MAX_FACT_LENGTH = 4_000;

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

/** System prompt for the general-fact reconcile. */
export const GENERAL_RECONCILE_PROMPT =
  "You maintain the long-term store of general knowledge a Telegram chat bot keeps — shared facts, " +
  "definitions, rules, and conventions that are not about one specific person. You are given ONE " +
  "newly saved fact and the existing stored facts most similar to it. Decide what the store should " +
  "do with the new fact.\n" +
  "Choose exactly one action:\n" +
  '- "insert": the fact is new information. Provide it, cleaned up into one self-contained line.\n' +
  '- "skip": an existing fact already says this. Nothing changes.\n' +
  '- "replace": the fact corrects, contradicts, or supersedes one or more existing facts. Provide ' +
  "the replacement line and list the ids of every fact it supersedes.\n" +
  "Rules:\n" +
  "- A fact must stand on its own: someone reading it months later, with no conversation around " +
  "it, must understand it.\n" +
  "- Prefer 'skip' over storing a near-duplicate, and 'replace' over letting two contradictory " +
  "facts both stand.\n" +
  "- Never invent detail that is not in the new fact.\n" +
  'Reply with ONLY a JSON object of the shape ' +
  '{"action": "insert" | "skip" | "replace", "content": string, "replaces": string[]}. ' +
  '"content" is ignored for "skip"; "replaces" is only read for "replace".';

/** An existing general fact offered to the reconcile pass as a candidate. */
export interface GeneralCandidate {
  id: string;
  content: string;
}

export interface GeneralReconcileInput {
  /** The newly saved note being reconciled. */
  note: string;
  /** Existing facts most similar to the note (may be empty for a fresh store). */
  candidates: GeneralCandidate[];
}

/** Build the general-fact reconcile request (the user turn). */
export function buildGeneralReconcileRequest(input: GeneralReconcileInput): string {
  const candidates =
    input.candidates.length > 0
      ? input.candidates.map((c) => `[${c.id}] ${c.content}`).join("\n")
      : "(the store is empty — there is nothing similar)";
  return [
    "Newly saved fact:",
    input.note,
    "",
    "Existing stored facts most similar to it:",
    candidates,
  ].join("\n");
}

/** What the reconcile pass decided for one note. */
export type GeneralDecision =
  | { action: "insert"; content: string }
  | { action: "skip" }
  | { action: "replace"; content: string; replaces: string[] };

/**
 * The reconcile decision, or null when the model returned something unusable.
 *
 * Defensive by design: a `replace` naming no *known* candidate id would delete
 * nothing and insert an unreviewed line, and an `insert`/`replace` with no
 * content would store an empty fact — both are rejected here rather than acted
 * on, so the run falls back to leaving the note pending for the next night.
 * `knownIds` is what the caller actually offered, so the model cannot reach
 * beyond its candidates and delete an unrelated fact.
 */
export function parseGeneralDecision(content: string, knownIds: string[]): GeneralDecision | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;

  const action = obj.action;
  if (action === "skip") return { action: "skip" };

  const text = typeof obj.content === "string" ? obj.content.trim() : "";
  if (text.length < MIN_FACT_LENGTH || text.length > MAX_FACT_LENGTH) return null;

  if (action === "insert") return { action: "insert", content: text };

  if (action === "replace") {
    const allowed = new Set(knownIds);
    const replaces = Array.isArray(obj.replaces)
      ? obj.replaces.filter((id): id is string => typeof id === "string" && allowed.has(id))
      : [];
    // A replacement that supersedes nothing we offered is just an insert.
    if (replaces.length === 0) return { action: "insert", content: text };
    return { action: "replace", content: text, replaces };
  }

  return null;
}
