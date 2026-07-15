import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import {
  generalMemories,
  memoryEntries,
  userMemories,
  type GeneralMemoryRow,
  type MemoryEntryRow,
  type UserMemoryRow,
} from "@/db/schema";

import type { GeneralMemory, MemoryEntry, MemoryScope, UserMemory } from "../types";

/**
 * Typed persistence for memory. Pure data access: no LLM, no embedding, no
 * tracing, no policy — the service and the consolidation job own those.
 */

function mapEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    userId: row.userId,
    content: row.content,
    chatId: row.chatId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapUserMemory(row: UserMemoryRow): UserMemory {
  return {
    userId: row.userId,
    content: row.content,
    embedded: row.embedding != null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapGeneralMemory(row: GeneralMemoryRow): GeneralMemory {
  return {
    id: row.id,
    content: row.content,
    embedded: row.embedding != null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------ pending queue */

/** Append one raw note from the `memory_save` tool. */
export async function addMemoryEntry(
  db: DrizzleDb,
  input: { scope: MemoryScope; userId: string | null; content: string; chatId: string | null },
): Promise<MemoryEntry> {
  const [row] = await db
    .insert(memoryEntries)
    .values({
      id: randomUUID(),
      scope: input.scope,
      userId: input.scope === "user" ? input.userId : null,
      content: input.content,
      chatId: input.chatId,
    })
    .returning();
  return mapEntry(row);
}

/** Every pending note, newest first (dashboard). */
export async function listMemoryEntries(db: DrizzleDb): Promise<MemoryEntry[]> {
  const rows = await db.query.memoryEntries.findMany({
    orderBy: (e, { desc: d }) => [d(e.createdAt)],
  });
  return rows.map(mapEntry);
}

/** Pending notes for one person, oldest first (the order they were learned). */
export async function getPendingUserEntries(
  db: DrizzleDb,
  userId: string,
): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.scope, "user"), eq(memoryEntries.userId, userId)))
    .orderBy(asc(memoryEntries.createdAt));
  return rows.map(mapEntry);
}

/** Pending `general` notes, oldest first. */
export async function getPendingGeneralEntries(db: DrizzleDb): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(eq(memoryEntries.scope, "general"))
    .orderBy(asc(memoryEntries.createdAt));
  return rows.map(mapEntry);
}

/** The distinct people who have pending notes — the consolidation job's user backlog. */
export async function listUsersWithPendingEntries(db: DrizzleDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: memoryEntries.userId })
    .from(memoryEntries)
    .where(and(eq(memoryEntries.scope, "user"), isNotNull(memoryEntries.userId)));
  return rows.map((r) => r.userId).filter((id): id is string => id != null);
}

/** How many notes are waiting for the next consolidation run (dashboard backlog). */
export async function countPendingEntries(db: DrizzleDb): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(memoryEntries);
  return row?.count ?? 0;
}

/** Drop notes by id (consolidated, or discarded by the operator). */
export async function deleteMemoryEntries(db: DrizzleDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(memoryEntries)
    .where(inArray(memoryEntries.id, ids))
    .returning({ id: memoryEntries.id });
  return rows.length;
}

/* --------------------------------------------------------------- user docs */

/** One person's consolidated document, or null when they have none yet. */
export async function getUserMemory(db: DrizzleDb, userId: string): Promise<UserMemory | null> {
  const row = await db.query.userMemories.findFirst({ where: eq(userMemories.userId, userId) });
  return row ? mapUserMemory(row) : null;
}

/** Several people's documents at once (reply-context injection). */
export async function getUserMemoriesFor(
  db: DrizzleDb,
  userIds: string[],
): Promise<UserMemory[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select()
    .from(userMemories)
    .where(inArray(userMemories.userId, userIds));
  return rows.map(mapUserMemory);
}

/** Every person's document, most recently updated first (dashboard). */
export async function listUserMemories(db: DrizzleDb): Promise<UserMemory[]> {
  const rows = await db.select().from(userMemories).orderBy(desc(userMemories.updatedAt));
  return rows.map(mapUserMemory);
}

/** Insert or rewrite one person's document (the nightly merge, or an operator edit). */
export async function upsertUserMemory(
  db: DrizzleDb,
  input: { userId: string; content: string; embedding: number[] | null },
): Promise<UserMemory> {
  const now = new Date();
  const [row] = await db
    .insert(userMemories)
    .values({
      userId: input.userId,
      content: input.content,
      embedding: input.embedding,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userMemories.userId,
      set: { content: input.content, embedding: input.embedding, updatedAt: now },
    })
    .returning();
  return mapUserMemory(row);
}

/** Forget one person entirely. Their pending notes cascade away with the row. */
export async function deleteUserMemory(db: DrizzleDb, userId: string): Promise<boolean> {
  const rows = await db
    .delete(userMemories)
    .where(eq(userMemories.userId, userId))
    .returning({ userId: userMemories.userId });
  return rows.length > 0;
}

/* ------------------------------------------------------------ general facts */

/** Every general fact, newest first (dashboard). */
export async function listGeneralMemories(db: DrizzleDb): Promise<GeneralMemory[]> {
  const rows = await db.select().from(generalMemories).orderBy(desc(generalMemories.createdAt));
  return rows.map(mapGeneralMemory);
}

/** Store one new general fact. */
export async function insertGeneralMemory(
  db: DrizzleDb,
  input: { content: string; embedding: number[] | null },
): Promise<GeneralMemory> {
  const [row] = await db
    .insert(generalMemories)
    .values({ id: randomUUID(), content: input.content, embedding: input.embedding })
    .returning();
  return mapGeneralMemory(row);
}

/** Rewrite one general fact (operator edit). */
export async function updateGeneralMemory(
  db: DrizzleDb,
  id: string,
  input: { content: string; embedding: number[] | null },
): Promise<GeneralMemory | null> {
  const [row] = await db
    .update(generalMemories)
    .set({ content: input.content, embedding: input.embedding, updatedAt: new Date() })
    .where(eq(generalMemories.id, id))
    .returning();
  return row ? mapGeneralMemory(row) : null;
}

/** Forget general facts by id (an operator delete, or superseded by a reconcile). */
export async function deleteGeneralMemories(db: DrizzleDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(generalMemories)
    .where(inArray(generalMemories.id, ids))
    .returning({ id: generalMemories.id });
  return rows.length;
}

/**
 * The general facts most similar to a note — the candidate set the nightly
 * reconcile pass decides against.
 *
 * BOTH halves always run, and the results are unioned. The vector half alone is
 * not enough: it can only see rows that carry an embedding, so a fact stored
 * while no embedding model was configured (or whose embed call failed) would
 * never be offered as a candidate — and an invisible candidate is one the job
 * cannot deduplicate against or supersede, quietly producing a contradictory
 * store. The lexical half catches those rows by their words.
 */
export async function findSimilarGeneralMemories(
  db: DrizzleDb,
  params: { content: string; embedding: number[] | null; limit: number },
): Promise<GeneralMemory[]> {
  const text = params.content.trim();

  // The lexical half must OR the note's words, not AND them. A correction shares
  // only *some* words with the fact it corrects ("Standup moved to 10:00" vs
  // "Standup is at 09:30"), so an AND query — what `websearch_to_tsquery` builds —
  // would demand the word "moved" appear in the stored fact and match nothing.
  // Rank by overlap so the most-related facts come first.
  const orQuery = sql`(select string_agg(lexeme, ' | ') from unnest(to_tsvector('simple', ${text})))::tsquery`;

  const [vectorRows, textRows] = await Promise.all([
    params.embedding
      ? db
          .select()
          .from(generalMemories)
          .where(isNotNull(generalMemories.embedding))
          .orderBy(
            sql`${generalMemories.embedding} <=> ${JSON.stringify(params.embedding)}::vector`,
          )
          .limit(params.limit)
      : Promise.resolve([]),
    text
      ? db
          .select()
          .from(generalMemories)
          .where(sql`to_tsvector('simple', ${generalMemories.content}) @@ ${orQuery}`)
          .orderBy(
            sql`ts_rank(to_tsvector('simple', ${generalMemories.content}), ${orQuery}) desc`,
          )
          .limit(params.limit)
      : Promise.resolve([]),
  ]);

  const byId = new Map<string, GeneralMemory>();
  for (const row of [...vectorRows, ...textRows]) {
    if (!byId.has(row.id)) byId.set(row.id, mapGeneralMemory(row));
  }
  return [...byId.values()].slice(0, params.limit);
}

/* ---------------------------------------------------------------- searching */

/** Reciprocal-rank-fusion damping constant — the standard k=60 from the RRF paper. */
const RRF_K = 60;

/** A scored row from one half of the hybrid search. */
interface Ranked<T> {
  key: string;
  value: T;
  score: number;
}

/** Fuse ranked lists by reciprocal rank (see `searchChatSummaries` for the rationale). */
function fuseByRank<T>(lists: Array<Array<{ key: string; value: T }>>, limit: number): T[] {
  const fused = new Map<string, Ranked<T>>();
  for (const list of lists) {
    list.forEach((row, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(row.key);
      if (existing) existing.score += contribution;
      else fused.set(row.key, { key: row.key, value: row.value, score: contribution });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.value);
}

/**
 * Hybrid search across consolidated memory of BOTH scopes: semantic (cosine over
 * the embedding) fused with lexical (Postgres full text) by reciprocal rank, the
 * same shape as the history-summary search.
 *
 * Spanning both scopes is deliberate: the model asking "what do I know about
 * sourdough" should not first have to guess whether that landed in general
 * knowledge or in a fact about a person. Each hit is tagged with the scope it
 * came from.
 *
 * With no embedding configured this degrades to pure full text rather than
 * returning nothing.
 */
export async function searchMemories(
  db: DrizzleDb,
  params: { queryText: string; queryVector: number[] | null; limit: number },
): Promise<Array<{ scope: MemoryScope; userId: string | null; content: string }>> {
  // Pull a deeper pool from each half than we return, so a row ranked middling by
  // both halves can still win overall.
  const poolSize = Math.max(params.limit * 4, 20);
  const text = params.queryText.trim();

  const vectorHits = params.queryVector
    ? await Promise.all([
        db
          .select({ userId: userMemories.userId, content: userMemories.content })
          .from(userMemories)
          .where(isNotNull(userMemories.embedding))
          .orderBy(sql`${userMemories.embedding} <=> ${JSON.stringify(params.queryVector)}::vector`)
          .limit(poolSize),
        db
          .select({ id: generalMemories.id, content: generalMemories.content })
          .from(generalMemories)
          .where(isNotNull(generalMemories.embedding))
          .orderBy(
            sql`${generalMemories.embedding} <=> ${JSON.stringify(params.queryVector)}::vector`,
          )
          .limit(poolSize),
      ])
    : [[], []];

  const textHits = text
    ? await Promise.all([
        db
          .select({ userId: userMemories.userId, content: userMemories.content })
          .from(userMemories)
          .where(
            sql`to_tsvector('simple', ${userMemories.content}) @@ websearch_to_tsquery('simple', ${text})`,
          )
          .orderBy(
            sql`ts_rank(to_tsvector('simple', ${userMemories.content}), websearch_to_tsquery('simple', ${text})) desc`,
          )
          .limit(poolSize),
        db
          .select({ id: generalMemories.id, content: generalMemories.content })
          .from(generalMemories)
          .where(
            sql`to_tsvector('simple', ${generalMemories.content}) @@ websearch_to_tsquery('simple', ${text})`,
          )
          .orderBy(
            sql`ts_rank(to_tsvector('simple', ${generalMemories.content}), websearch_to_tsquery('simple', ${text})) desc`,
          )
          .limit(poolSize),
      ])
    : [[], []];

  type Hit = { scope: MemoryScope; userId: string | null; content: string };
  const asUserHits = (rows: Array<{ userId: string; content: string }>) =>
    rows.map((r) => ({
      key: `user:${r.userId}`,
      value: { scope: "user" as const, userId: r.userId, content: r.content } satisfies Hit,
    }));
  const asGeneralHits = (rows: Array<{ id: string; content: string }>) =>
    rows.map((r) => ({
      key: `general:${r.id}`,
      value: { scope: "general" as const, userId: null, content: r.content } satisfies Hit,
    }));

  return fuseByRank<Hit>(
    [
      asUserHits(vectorHits[0]),
      asGeneralHits(vectorHits[1]),
      asUserHits(textHits[0]),
      asGeneralHits(textHits[1]),
    ],
    params.limit,
  );
}

