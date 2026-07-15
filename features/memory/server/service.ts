import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getGroupMembers } from "@/features/known-groups/server/repository";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUser, getKnownUsersByIds } from "@/features/known-users/server/repository";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { embedOne } from "@/server/llm/embeddings";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { formatMemoryContext, splitMemoryFacts } from "../format";
import type { GeneralMemory, MemoryEntry, MemoryMatch, MemoryScope, UserMemory } from "../types";
import {
  addMemoryEntry,
  countPendingEntries,
  deleteGeneralMemories,
  deleteMemoryEntries,
  deleteUserMemory,
  getUserMemoriesFor,
  getUserMemory,
  insertGeneralMemory,
  listGeneralMemories,
  listMemoryEntries,
  listUserMemories,
  searchMemories,
  updateGeneralMemory,
  upsertUserMemory,
} from "./repository";
import type { CreateGeneralMemory, UpdateGeneralMemory, UpdateUserMemory } from "./schema";

/**
 * Memory domain service — the boundary the memory tools, the reply runtime, the
 * dashboard, and the Route Handlers call. Owns policy (who may be remembered,
 * what gets injected), embedding, and trace recording; persistence lives in the
 * repository and the nightly merge in `consolidate.ts`.
 */

const FEATURE = FEATURES.memory;

/* -------------------------------------------------------------- embedding */

/**
 * Embed one text for storage, or null when no embedding model is configured or
 * the provider call fails.
 *
 * Null is a first-class outcome, not swallowed breakage: memory is stored,
 * injected, and read back regardless — only *semantic search* over that row is
 * lost, and the dashboard shows it as unembedded. Making an operator edit fail
 * because an embedding endpoint is down would be the worse trade.
 */
async function embedForStorage(text: string): Promise<number[] | null> {
  const runtime = await getEmbeddingRuntime().catch(() => null);
  if (!runtime) return null;
  return embedOne(runtime, text).catch(() => null);
}

/** Embed a search query, or null when embeddings are unavailable (lexical-only search). */
async function embedQuery(text: string): Promise<number[] | null> {
  const runtime = await getEmbeddingRuntime().catch(() => null);
  if (!runtime) return null;
  return embedOne(runtime, text).catch(() => null);
}

/* --------------------------------------------------------- reply injection */

/** The long-term-memory block injected into a reply (parallel of UserContext). */
export interface MemoryContext {
  content: string;
  /** Trace payload for the "memory loaded" step. */
  data: { userIds: string[]; factCount: number };
}

/**
 * Server-only: what the bot durably knows about the people in this conversation,
 * formatted for injection as a system message on a reply. Null when it knows
 * nothing about anyone here.
 *
 * Who counts as "the people in this conversation" (recorded decision): the sender
 * always, plus — in a group — every known participant, so the bot can follow a
 * conversation *about* someone it knows without being asked to look them up. Only
 * people with a stored memory contribute anything, so the injected block is
 * bounded by how many people the bot actually remembers, not by the roster size.
 * General memory is deliberately NOT injected; it is reachable by tool.
 *
 * Only **consolidated** memory is injected (user decision). A note saved earlier
 * today is deliberately not folded in: it was said in this conversation, and the
 * conversation itself is already in the prompt verbatim (the 24-hour history
 * window), so injecting the raw note again would restate what the model can
 * already read. Memory is what *survived consolidation* — the merged, deduplicated,
 * contradiction-resolved picture — not a running log of everything ever saved.
 */
export async function getMemoryContext(
  params: { chatId: string; senderId: string | null; isGroup: boolean },
  db: DrizzleDb = getDb(),
): Promise<MemoryContext | null> {
  const ids: string[] = [];
  if (params.senderId) ids.push(params.senderId);

  if (params.isGroup) {
    const members = await getGroupMembers(db, params.chatId);
    for (const member of members) {
      if (!ids.includes(member.userId)) ids.push(member.userId);
    }
  }

  const userIds = ids;
  if (userIds.length === 0) return null;

  const [documents, users] = await Promise.all([
    getUserMemoriesFor(db, userIds),
    getKnownUsersByIds(db, userIds),
  ]);

  const documentBy = new Map(documents.map((d) => [d.userId, d]));
  const labelBy = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));

  let factCount = 0;
  const blocks = userIds.map((userId) => {
    const stored = documentBy.get(userId);
    const facts = stored ? splitMemoryFacts(stored.content) : [];
    factCount += facts.length;
    return {
      userId,
      label: labelBy.get(userId) ?? `User ${userId}`,
      isSender: userId === params.senderId,
      facts,
    };
  });

  const content = formatMemoryContext(blocks);
  if (!content) return null;

  return {
    content,
    data: {
      // Only the people actually represented in the block — a participant the bot
      // knows nothing about contributes nothing and is not claimed in the trace.
      userIds: blocks.filter((b) => b.facts.length > 0).map((b) => b.userId),
      factCount,
    },
  };
}

/* --------------------------------------------------------------- tool reads */

/**
 * Everything stored in one scope (`memory_get`). For `user`, the person's
 * consolidated document; for `general`, every stored fact.
 *
 * Consolidated memory only (user decision) — the pending queue is not readable
 * through the tools. What a tool returns is therefore exactly what the operator
 * sees stored on the dashboard, with no second, shadow set of facts that exist
 * only until the next nightly run.
 */
export async function readMemory(
  params: { scope: MemoryScope; userId?: string | null },
  db: DrizzleDb = getDb(),
): Promise<MemoryMatch[]> {
  if (params.scope === "user") {
    const userId = params.userId?.trim();
    if (!userId) return [];
    const stored = await getUserMemory(db, userId);
    if (!stored) return [];
    return splitMemoryFacts(stored.content).map((content) => ({
      scope: "user" as const,
      userId,
      content,
    }));
  }

  const facts = await listGeneralMemories(db);
  return facts.map((f) => ({
    scope: "general" as const,
    userId: null,
    content: f.content,
  }));
}

/**
 * Hybrid search across consolidated memory of both scopes (`memory_search`):
 * semantic and lexical, fused by reciprocal rank.
 *
 * Consolidated memory only (user decision) — the pending queue is not searched.
 * A fact saved earlier in this conversation is not lost to the model: the
 * conversation itself is in the prompt, and the history tools reach the rest of
 * it. Memory answers "what do I durably know", not "what did I just hear".
 */
export async function searchMemory(
  params: { queries: string[]; limit: number },
  db: DrizzleDb = getDb(),
): Promise<MemoryMatch[]> {
  const collected = new Map<string, MemoryMatch>();

  for (const query of params.queries) {
    const vector = await embedQuery(query);
    const hits = await searchMemories(db, {
      queryText: query,
      queryVector: vector,
      limit: params.limit,
    });
    for (const hit of hits) {
      const key = `${hit.scope}|${hit.userId ?? ""}|${hit.content}`;
      if (!collected.has(key)) collected.set(key, hit);
    }
  }

  return [...collected.values()];
}

/* -------------------------------------------------------------- tool writes */

/**
 * Queue one durable fact from the `memory_save` tool.
 *
 * A `user` fact must name a person the bot has actually met (the id comes from
 * the injected context, so a hallucinated one is a real possibility) — otherwise
 * it would be filed under a stranger and never surface. The rejection is returned
 * to the model as a tool error, not thrown at the reply.
 */
export async function saveMemoryNote(
  params: { scope: MemoryScope; userId: string | null; content: string; chatId: string | null },
  db: DrizzleDb = getDb(),
): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: string }> {
  if (params.scope === "user") {
    const userId = params.userId?.trim();
    if (!userId) {
      return { ok: false, error: "A 'user' memory needs the id of the person it is about." };
    }
    const known = await getKnownUser(db, userId);
    if (!known) {
      return {
        ok: false,
        error: `No known person has id ${userId}. Use an id from the conversation context.`,
      };
    }
  }

  const entry = await addMemoryEntry(db, {
    scope: params.scope,
    userId: params.scope === "user" ? params.userId : null,
    content: params.content,
    chatId: params.chatId,
  });
  publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
  return { ok: true, entry };
}

/* ---------------------------------------------------------------- dashboard */

/** One person's memory, resolved with their label (dashboard). */
export interface UserMemoryView extends UserMemory {
  userLabel: string;
  /** Notes about this person still waiting for the nightly job. */
  pendingNotes: number;
}

/** A pending note resolved with its subject's label (dashboard). */
export interface MemoryEntryView extends MemoryEntry {
  /** Label of the person the note is about; null for a `general` note. */
  userLabel: string | null;
}

/** Everything the dashboard page shows. */
export interface MemoryView {
  entries: MemoryEntryView[];
  users: UserMemoryView[];
  general: GeneralMemory[];
}

export async function getMemoryView(db: DrizzleDb = getDb()): Promise<MemoryView> {
  const [entries, users, general] = await Promise.all([
    listMemoryEntries(db),
    listUserMemories(db),
    listGeneralMemories(db),
  ]);

  const userIds = [
    ...users.map((u) => u.userId),
    ...entries.map((e) => e.userId).filter((id): id is string => id != null),
  ];
  const known = await getKnownUsersByIds(db, userIds);
  const labels = new Map(known.map((u) => [u.userId, formatKnownUserLabel(u)]));
  const labelFor = (userId: string) => labels.get(userId) ?? `User ${userId}`;

  const pendingCount = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.userId) continue;
    pendingCount.set(entry.userId, (pendingCount.get(entry.userId) ?? 0) + 1);
  }

  return {
    entries: entries.map((e) => ({
      ...e,
      userLabel: e.userId ? labelFor(e.userId) : null,
    })),
    users: users.map((u) => ({
      ...u,
      userLabel: labelFor(u.userId),
      pendingNotes: pendingCount.get(u.userId) ?? 0,
    })),
    general,
  };
}

/** Notes waiting for the next consolidation run — the job card's backlog. */
export function countPendingNotes(db: DrizzleDb = getDb()): Promise<number> {
  return countPendingEntries(db);
}

/* -------------------------------------------------------- operator mutations */

/** Trigger for an operator action taken on the dashboard. */
const operatorTrigger: TraceTrigger = { kind: "dashboard", actor: "operator" };

/** Run one operator mutation inside a trace, publishing the live update on success. */
async function traced<T>(
  action: string,
  inputSummary: string,
  run: (trace: Awaited<ReturnType<typeof startTrace>>) => Promise<T>,
  db: DrizzleDb,
): Promise<T> {
  const trace = await startTrace(
    { feature: FEATURE.id, action, trigger: operatorTrigger, inputSummary },
    db,
  );
  try {
    const result = await run(trace);
    await trace.succeed({ outputSummary: "ok" });
    publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
    return result;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** Rewrite one person's memory document by hand. Re-embeds so search stays honest. */
export async function editUserMemory(
  userId: string,
  input: UpdateUserMemory,
  db: DrizzleDb = getDb(),
): Promise<UserMemory> {
  return traced(
    "edit-user-memory",
    `user ${userId}`,
    async (trace) => {
      const known = await getKnownUser(db, userId);
      if (!known) throw ApiError.notFound(`No known user with id ${userId}`);

      const before = await getUserMemory(db, userId);
      // Re-embed the new text rather than keeping the old vector: a stale vector
      // would keep matching searches for text the document no longer contains.
      const stored = await upsertUserMemory(db, {
        userId,
        content: input.content,
        embedding: await embedForStorage(input.content),
      });
      await trace.event({
        type: "step",
        message: "memory document rewritten",
        data: { userId, before: before?.content ?? null, after: stored.content, embedded: stored.embedded },
      });
      return stored;
    },
    db,
  );
}

/** Forget one person: their document and (by cascade) their pending notes. */
export async function forgetUser(userId: string, db: DrizzleDb = getDb()): Promise<void> {
  return traced(
    "delete-user-memory",
    `user ${userId}`,
    async (trace) => {
      const before = await getUserMemory(db, userId);
      const deleted = await deleteUserMemory(db, userId);
      if (!deleted) throw ApiError.notFound(`No memory stored for user ${userId}`);
      await trace.event({
        type: "step",
        message: "memory document deleted",
        data: { userId, deleted: before?.content ?? null },
      });
    },
    db,
  );
}

/** Store a general fact by hand. */
export async function addGeneralMemory(
  input: CreateGeneralMemory,
  db: DrizzleDb = getDb(),
): Promise<GeneralMemory> {
  return traced(
    "create-general-memory",
    input.content.slice(0, 80),
    async (trace) => {
      const stored = await insertGeneralMemory(db, {
        content: input.content,
        embedding: await embedForStorage(input.content),
      });
      await trace.event({
        type: "step",
        message: "general fact stored",
        data: { memoryId: stored.id, content: stored.content, embedded: stored.embedded },
      });
      return stored;
    },
    db,
  );
}

/** Rewrite one general fact. Re-embeds so search stays honest. */
export async function editGeneralMemory(
  id: string,
  input: UpdateGeneralMemory,
  db: DrizzleDb = getDb(),
): Promise<GeneralMemory> {
  return traced(
    "edit-general-memory",
    id,
    async (trace) => {
      const stored = await updateGeneralMemory(db, id, {
        content: input.content,
        embedding: await embedForStorage(input.content),
      });
      if (!stored) throw ApiError.notFound(`No general memory with id ${id}`);
      await trace.event({
        type: "step",
        message: "general fact rewritten",
        data: { memoryId: id, content: stored.content, embedded: stored.embedded },
      });
      return stored;
    },
    db,
  );
}

/** Forget one general fact. */
export async function forgetGeneralMemory(id: string, db: DrizzleDb = getDb()): Promise<void> {
  return traced(
    "delete-general-memory",
    id,
    async (trace) => {
      const deleted = await deleteGeneralMemories(db, [id]);
      if (deleted === 0) throw ApiError.notFound(`No general memory with id ${id}`);
      await trace.event({ type: "step", message: "general fact deleted", data: { memoryId: id } });
    },
    db,
  );
}

/** Discard a pending note before the nightly job folds it in. */
export async function discardMemoryEntry(id: string, db: DrizzleDb = getDb()): Promise<void> {
  return traced(
    "discard-note",
    id,
    async (trace) => {
      const deleted = await deleteMemoryEntries(db, [id]);
      if (deleted === 0) throw ApiError.notFound(`No pending memory note with id ${id}`);
      await trace.event({ type: "step", message: "pending note discarded", data: { entryId: id } });
    },
    db,
  );
}
