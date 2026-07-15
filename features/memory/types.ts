/**
 * Client-safe types for the memory feature: durable knowledge the bot keeps
 * across conversations.
 *
 * Two scopes, stored two different ways (recorded decision):
 *  - `user`    one merged document per person, injected into replies in the chats
 *              they take part in.
 *  - `general` individual, independently embedded fact rows of cross-chat shared
 *              knowledge, reachable only through the memory tools.
 *
 * Both are written the same way: the model calls `memory_save` mid-reply, the
 * note lands in the pending queue, and the nightly job folds it in. A note only
 * becomes memory once consolidated — the queue itself is neither injected into
 * replies nor readable by the tools.
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

/** One durable fact of cross-chat general knowledge. */
export interface GeneralMemory {
  id: string;
  content: string;
  /** Whether the row carries an embedding (i.e. is findable by semantic search). */
  embedded: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A memory search hit, tagged with the scope it came from. Always a
 * *consolidated* fact — the pending queue is neither injected nor searchable
 * (user decision), so there is no "pending" state to represent here.
 */
export interface MemoryMatch {
  scope: MemoryScope;
  /** The person, for a `user` hit; null for `general`. */
  userId: string | null;
  content: string;
}
