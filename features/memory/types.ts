/**
 * Client-safe types for the memory feature: durable knowledge the bot keeps
 * across conversations.
 *
 * Two scopes, both stored as **merged documents** (operator decision, 2026-07-16):
 *  - `user`    one document per person, injected into the replies of the chats
 *              they take part in.
 *  - `general` ONE document of cross-chat shared knowledge, injected into every
 *              reply. Knowledge that is about *nobody*: definitions, rules,
 *              conventions, how things work. Explicitly **not** a home for facts
 *              about people the bot cannot key on (operator decision,
 *              2026-07-17) — such a fact is dropped. Keeping it here by name was
 *              the biggest source of wrong memory: this document has no identity
 *              model, so name-keyed biography got merged across people and
 *              nicknames grew into people of their own.
 *
 * Both are written the same way: a note reaches the pending queue (from the
 * `memory_save` tool mid-reply, or from the nightly passive extraction over the
 * history mirror), and the nightly job merges it in. A note only becomes memory
 * once consolidated — the queue itself is neither injected nor readable by tools.
 */

/** Which memory a fact belongs to. */
export type MemoryScope = "user" | "general";

/** A raw note awaiting consolidation (the `memory_save` queue). */
export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** The person the fact is about — set for `user`, null for `general`. */
  userId: string | null;
  content: string;
  /** Chat the note was saved from (provenance), or null. */
  chatId: string | null;
  createdAt: string;
}

/** One person's consolidated memory document. */
export interface UserMemory {
  userId: string;
  content: string;
  /** Whether the row carries an embedding (i.e. is findable by semantic search). */
  embedded: boolean;
  updatedAt: string;
}

/**
 * The consolidated general-knowledge document. No embedding and no id: it is a
 * singleton row, and nothing ranks it — the whole document is in every prompt.
 */
export interface GeneralMemory {
  content: string;
  updatedAt: string;
}

/**
 * A memory search hit. Always a *consolidated* `user` fact: the pending queue is
 * neither injected nor searchable (user decision), and general knowledge is not
 * searched at all since it is already in the prompt. `scope` is kept so the
 * model-facing result stays explicit about what it is looking at.
 */
export interface MemoryMatch {
  scope: MemoryScope;
  /** The person, for a `user` hit; null for `general`. */
  userId: string | null;
  content: string;
}
