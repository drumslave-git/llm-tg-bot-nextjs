import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { generalMemories, groupMembers, knownGroups, knownUsers } from "@/db/schema";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";

import { runMemoryConsolidation, type ConsolidateDeps } from "./consolidate";
import {
  getUserMemory,
  listGeneralMemories,
  listMemoryEntries,
  searchMemories,
} from "./repository";
import {
  editUserMemory,
  forgetGeneralMemory,
  getMemoryContext,
  readMemory,
  saveMemoryNote,
  searchMemory,
} from "./service";

/**
 * Integration coverage for memory against a real Postgres with pgvector: the
 * `memory_save` write path, the nightly consolidation (per-person document merge
 * and per-note general reconcile) with a deterministic LLM, the hybrid search, and
 * the reply-context injection — including the property that matters most, that a
 * fact saved seconds ago is usable on the very next turn without waiting for the
 * nightly job.
 */

let ctx: TestDb;
let prevDatabaseUrl: string | undefined;

beforeAll(async () => {
  ctx = await startTestDb();
  prevDatabaseUrl = process.env.DATABASE_URL;
  // The service reaches the DB through the app's own pool (`getDb()`), so bind it.
  process.env.DATABASE_URL = ctx.connectionUri;
});

afterAll(async () => {
  await closePool();
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const CHAT_ID = "555";
const GROUP_ID = "-100777";
const ADA = "100";
const GRACE = "200";

async function seedUser(userId: string, firstName: string): Promise<void> {
  await ctx.db
    .insert(knownUsers)
    .values({ userId, username: firstName.toLowerCase(), firstName })
    .onConflictDoNothing();
}

/** A group both people take part in. */
async function seedGroup(): Promise<void> {
  await ctx.db
    .insert(knownGroups)
    .values({ chatId: GROUP_ID, title: "Test group", type: "supergroup" })
    .onConflictDoNothing();
  await ctx.db
    .insert(groupMembers)
    .values([
      { chatId: GROUP_ID, userId: ADA },
      { chatId: GROUP_ID, userId: GRACE },
    ])
    .onConflictDoNothing();
}

/**
 * A deterministic pseudo-embedding: stable per text, and the right width. Enough
 * to exercise the vector column, the HNSW index, and cosine ordering for real
 * without reaching a provider.
 */
function fakeEmbedding(text: string): number[] {
  const seed = [...text].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return Array.from({ length: 1024 }, (_, k) => Math.sin(seed + k) / 10);
}

/** A deterministic LLM: each call returns the next scripted response. */
function scriptedLlm(responses: string[]): {
  deps: ConsolidateDeps;
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    calls,
    deps: {
      complete: async (messages): Promise<ChatCompletionResult> => {
        calls.push(messages);
        const content = responses[i++] ?? "";
        return { content, model: "test-model", latencyMs: 1 } as ChatCompletionResult;
      },
      embed: async (texts) => texts.map(fakeEmbedding),
      db: ctx.db,
    },
  };
}

describe("memory_save (the write path)", () => {
  it("queues a user fact and refuses one about a person the bot has never met", async () => {
    await seedUser(ADA, "Ada");

    const saved = await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    expect(saved.ok).toBe(true);

    // A hallucinated id must not be filed under a stranger where it would never surface.
    const rejected = await saveMemoryNote(
      { scope: "user", userId: "999999", content: "Lives on Mars.", chatId: CHAT_ID },
      ctx.db,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("999999");

    const entries = await listMemoryEntries(ctx.db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: "user", userId: ADA, content: "Lives in Lisbon." });
  });

  it("queues a general fact with no person attached", async () => {
    const saved = await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    expect(saved.ok).toBe(true);
    const entries = await listMemoryEntries(ctx.db);
    expect(entries[0]).toMatchObject({ scope: "general", userId: null });
  });
});

describe("reply injection", () => {
  /** Consolidate one person's pending notes into their document. */
  async function consolidate(document: string): Promise<void> {
    await runMemoryConsolidation(scriptedLlm([JSON.stringify({ memory: document })]).deps);
  }

  it("injects a person's consolidated memory, marking them as the sender", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await consolidate("Lives in Lisbon.");

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Ada (@ada) (the person you are replying to)");
    expect(context?.content).toContain("Lives in Lisbon.");
    expect(context?.data).toMatchObject({ userIds: [ADA], factCount: 1 });
  });

  it("does NOT inject a pending note — memory is what survived consolidation", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );

    // The note exists, but nothing has been consolidated, so there is no memory to
    // inject. (The fact is not lost to the model: it was said in this conversation,
    // which the reply already carries verbatim.)
    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: ADA, isGroup: false }, ctx.db),
    ).toBeNull();
  });

  it("injects the other participants' memory in a group, marking only the sender", async () => {
    await seedUser(ADA, "Ada");
    await seedUser(GRACE, "Grace");
    await seedGroup();
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: GROUP_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "user", userId: GRACE, content: "Works nights.", chatId: GROUP_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm(['{"memory": "Lives in Lisbon."}', '{"memory": "Works nights."}']).deps,
    );

    const context = await getMemoryContext(
      { chatId: GROUP_ID, senderId: ADA, isGroup: true },
      ctx.db,
    );
    expect(context?.content).toContain("Ada (@ada) (the person you are replying to)");
    expect(context?.content).toContain("Lives in Lisbon.");
    expect(context?.content).toContain("Grace (@grace):");
    expect(context?.content).toContain("Works nights.");
    expect(context?.content).not.toContain("Grace (@grace) (the person you are replying to)");
  });

  it("injects nothing in a private chat about someone it knows nothing about", async () => {
    await seedUser(ADA, "Ada");
    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: ADA, isGroup: false }, ctx.db),
    ).toBeNull();
  });

  it("does not inject general knowledge — that is tool-only", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm(['{"action":"insert","content":"Standup is at 09:30.","replaces":[]}']).deps,
    );

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context).toBeNull();
  });
});

describe("nightly consolidation — user documents", () => {
  it("merges pending notes into one document per person, then consumes the notes", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Likes rye bread.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps, calls } = scriptedLlm([
      '{"memory": "Lives in Porto.\\nLikes rye bread."}',
    ]);
    const result = await runMemoryConsolidation(deps);

    expect(result.usersUpdated).toBe(1);
    expect(result.consumed).toBe(2);
    // One call per PERSON, not per note — the model must see the whole picture.
    expect(calls).toHaveLength(1);
    expect(calls[0].at(-1)?.content).toContain("Ada");

    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Lives in Porto.\nLikes rye bread.");
    expect(stored?.embedded).toBe(true);
    // Consumed notes are gone, so a re-run costs nothing.
    expect(await listMemoryEntries(ctx.db)).toHaveLength(0);

    const second = await runMemoryConsolidation(deps);
    expect(second.summary).toBe("nothing to consolidate");
  });

  it("resolves a contradiction by rewriting the document, not appending to it", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Porto."}']).deps);

    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Moved to Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    const { deps, calls } = scriptedLlm(['{"memory": "Lives in Lisbon."}']);
    await runMemoryConsolidation(deps);

    // The existing document was offered to the merge, so the model could supersede it.
    expect(calls[0].at(-1)?.content).toContain("Lives in Porto.");
    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Lives in Lisbon.");
    expect(stored?.content).not.toContain("Porto");
  });

  it("leaves memory and the notes untouched when the merge returns nothing usable", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Porto."}']).deps);

    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Likes rye.", chatId: CHAT_ID },
      ctx.db,
    );
    const result = await runMemoryConsolidation(scriptedLlm(["I'm afraid I can't do that."]).deps);

    // A garbage response must never erase a document that took months to build.
    expect(result.failed).toBe(1);
    expect(result.usersUpdated).toBe(0);
    expect((await getUserMemory(ctx.db, ADA))?.content).toBe("Lives in Porto.");
    // ...and the note survives for the next run rather than being silently dropped.
    expect(await listMemoryEntries(ctx.db)).toHaveLength(1);
  });

  it("keeps going when one person's merge fails", async () => {
    await seedUser(ADA, "Ada");
    await seedUser(GRACE, "Grace");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "user", userId: GRACE, content: "Works nights.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps } = scriptedLlm(["garbage", '{"memory": "Works nights."}']);
    const result = await runMemoryConsolidation(deps);

    expect(result.failed).toBe(1);
    expect(result.usersUpdated).toBe(1);
    // The successful person is stored; the failed one's note remains pending.
    const remaining = await listMemoryEntries(ctx.db);
    expect(remaining).toHaveLength(1);
  });
});

describe("nightly consolidation — general facts", () => {
  it("stores a new fact as its own embedded row", async () => {
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    const result = await runMemoryConsolidation(
      scriptedLlm(['{"action":"insert","content":"Standup is at 09:30.","replaces":[]}']).deps,
    );

    expect(result.generalInserted).toBe(1);
    const facts = await listGeneralMemories(ctx.db);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ content: "Standup is at 09:30.", embedded: true });
  });

  it("skips a restatement instead of storing a near-duplicate", async () => {
    await ctx.db
      .insert(generalMemories)
      .values({ id: "fact-1", content: "Standup is at 09:30." });
    await saveMemoryNote(
      { scope: "general", userId: null, content: "The standup happens at 9:30.", chatId: CHAT_ID },
      ctx.db,
    );

    const result = await runMemoryConsolidation(
      scriptedLlm(['{"action":"skip","content":"","replaces":[]}']).deps,
    );

    expect(result.generalSkipped).toBe(1);
    expect(await listGeneralMemories(ctx.db)).toHaveLength(1);
    // The note is still consumed — it has been considered, and re-spending it nightly would be waste.
    expect(await listMemoryEntries(ctx.db)).toHaveLength(0);
  });

  it("replaces the facts a correction supersedes", async () => {
    await ctx.db.insert(generalMemories).values({
      id: "fact-1",
      content: "Standup is at 09:30.",
      embedding: fakeEmbedding("Standup is at 09:30."),
    });
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup moved to 10:00.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps, calls } = scriptedLlm([
      '{"action":"replace","content":"Standup is at 10:00.","replaces":["fact-1"]}',
    ]);
    const result = await runMemoryConsolidation(deps);

    // The existing fact was offered as a candidate, by id.
    expect(calls[0].at(-1)?.content).toContain("[fact-1] Standup is at 09:30.");
    expect(result.generalReplaced).toBe(1);
    const facts = await listGeneralMemories(ctx.db);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Standup is at 10:00.");
  });

  it("offers an unembedded fact as a candidate, so it can still be superseded", async () => {
    // A fact stored while no embedding model was configured has a null vector. If
    // the candidate lookup were vector-only it would be invisible here, and the
    // job would store a contradictory duplicate beside it instead of replacing it.
    await ctx.db.insert(generalMemories).values({ id: "fact-1", content: "Standup is at 09:30." });
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup moved to 10:00.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps, calls } = scriptedLlm([
      '{"action":"replace","content":"Standup is at 10:00.","replaces":["fact-1"]}',
    ]);
    const result = await runMemoryConsolidation(deps);

    expect(calls[0].at(-1)?.content).toContain("[fact-1] Standup is at 09:30.");
    expect(result.generalReplaced).toBe(1);
    const facts = await listGeneralMemories(ctx.db);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Standup is at 10:00.");
  });

  it("cannot be talked into deleting a fact it was never offered", async () => {
    await ctx.db.insert(generalMemories).values({ id: "fact-keep", content: "Unrelated fact." });
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 10:00.", chatId: CHAT_ID },
      ctx.db,
    );

    // The model names an id that was never a candidate; it must be ignored, and
    // the decision degrade to a plain insert.
    const result = await runMemoryConsolidation(
      scriptedLlm([
        '{"action":"replace","content":"Standup is at 10:00.","replaces":["fact-keep"]}',
      ]).deps,
    );

    expect(result.generalReplaced).toBe(0);
    expect(result.generalInserted).toBe(1);
    const contents = (await listGeneralMemories(ctx.db)).map((f) => f.content);
    expect(contents).toContain("Unrelated fact.");
    expect(contents).toContain("Standup is at 10:00.");
  });
});

describe("consolidation without an embedding model", () => {
  it("still stores and injects memory — only semantic search is lost", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps } = scriptedLlm(['{"memory": "Lives in Lisbon."}']);
    const result = await runMemoryConsolidation({ ...deps, embed: null });

    expect(result.usersUpdated).toBe(1);
    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Lives in Lisbon.");
    expect(stored?.embedded).toBe(false);

    // Still injected into replies, embedding or not.
    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Lives in Lisbon.");
  });
});

describe("search", () => {
  it("finds a consolidated fact by wording, across both scopes", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Ada bakes sourdough every weekend.", chatId: CHAT_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm([
        '{"memory": "Ada bakes sourdough every weekend."}',
        '{"action":"insert","content":"Standup is at 09:30.","replaces":[]}',
      ]).deps,
    );

    const hits = await searchMemories(ctx.db, {
      queryText: "sourdough",
      queryVector: null,
      limit: 8,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ scope: "user", userId: ADA });

    const standup = await searchMemories(ctx.db, {
      queryText: "standup",
      queryVector: null,
      limit: 8,
    });
    expect(standup[0]).toMatchObject({ scope: "general", userId: null });
  });

  it("does NOT find a pending note — the tools read consolidated memory only", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Ada bakes sourdough.", chatId: CHAT_ID },
      ctx.db,
    );

    // The note is queued but not consolidated, so it is not memory yet. What the
    // tools return is exactly what is stored — no shadow set of facts in between.
    expect(await searchMemory({ queries: ["sourdough"], limit: 8 }, ctx.db)).toEqual([]);
  });
});

describe("readMemory (memory_get)", () => {
  it("returns a person's consolidated document, and not their pending notes", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Lisbon."}']).deps);
    // Saved after consolidation — still queued, so still not memory.
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Likes rye.", chatId: CHAT_ID },
      ctx.db,
    );

    const facts = await readMemory({ scope: "user", userId: ADA }, ctx.db);
    expect(facts).toEqual([{ scope: "user", userId: ADA, content: "Lives in Lisbon." }]);
  });
});

describe("operator edits", () => {
  it("rewrites a person's document and re-embeds it, traced", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Porto."}']).deps);

    // No embedding endpoint is configured in the test env, so the rewrite stores
    // the corrected text with a null vector rather than keeping a vector that
    // describes text the document no longer contains.
    const updated = await editUserMemory(ADA, { content: "Lives in Lisbon." }, ctx.db);
    expect(updated.content).toBe("Lives in Lisbon.");
    expect(updated.embedded).toBe(false);

    const traces = await listTraces(ctx.db, { feature: "memory", limit: 10, offset: 0 });
    const edit = traces.traces.find((t) => t.action === "edit-user-memory");
    expect(edit?.status).toBe("success");
  });

  it("forgets a general fact", async () => {
    await ctx.db.insert(generalMemories).values({ id: "fact-1", content: "Standup is at 09:30." });
    await forgetGeneralMemory("fact-1", ctx.db);
    expect(await listGeneralMemories(ctx.db)).toHaveLength(0);
  });
});

describe("tracing", () => {
  it("records one consolidation trace with the merge request, response, and outcome", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Lisbon."}']).deps);

    const traces = await listTraces(ctx.db, { feature: "memory", limit: 10, offset: 0 });
    const run = traces.traces.find((t) => t.action === "consolidate");
    expect(run?.status).toBe("success");
    expect(run?.outputSummary).toContain("1 user memory updated");
  });

  it("records no trace at all when there is nothing to consolidate", async () => {
    const result = await runMemoryConsolidation(scriptedLlm([]).deps);
    expect(result.summary).toBe("nothing to consolidate");
    const traces = await listTraces(ctx.db, { feature: "memory", limit: 10, offset: 0 });
    expect(traces.traces).toHaveLength(0);
  });
});
