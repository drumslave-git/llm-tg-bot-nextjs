import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { FEATURES } from "@/lib/features";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import type { JobProgress } from "@/server/jobs/progress";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { splitMemoryFacts } from "../format";
import {
  buildGeneralReconcileRequest,
  buildUserMergeRequest,
  GENERAL_RECONCILE_PROMPT,
  parseGeneralDecision,
  parseMergedDocument,
  USER_MERGE_PROMPT,
} from "../prompt";
import {
  deleteGeneralMemories,
  deleteMemoryEntries,
  findSimilarGeneralMemories,
  getPendingGeneralEntries,
  getPendingUserEntries,
  getUserMemory,
  insertGeneralMemory,
  listUsersWithPendingEntries,
  upsertUserMemory,
} from "./repository";

/**
 * The nightly consolidation job: fold every pending `memory_save` note into
 * durable memory.
 *
 * Two passes, because the scopes are stored differently (recorded decision):
 *  - **user** — one LLM call per *person*, merging all of their pending notes into
 *    their single document at once. Merging per-person rather than per-note lets
 *    the model see the whole picture it is rewriting, which is what makes
 *    contradiction resolution ("moved to Lisbon" supersedes "lives in Porto")
 *    possible at all.
 *  - **general** — one LLM call per *note*, reconciled against the existing facts
 *    most similar to it. Per-note because each fact is an independently embedded
 *    row: the decision is local (insert / skip / replace), so there is no reason to
 *    put the whole store in the context, and a store that has grown for months
 *    could not fit there anyway.
 *
 * A pass that fails leaves its notes pending for the next run rather than losing
 * them; a note that succeeds is deleted, so it is never re-spent on the LLM.
 * Embeddings are optional: with no embedding model configured the job still runs
 * and memory is still stored and injected, it just is not semantically searchable.
 */

const FEATURE = FEATURES.memory;

/** Existing facts offered to the reconcile pass per note. A code constant. */
const SIMILAR_CANDIDATES = 8;

/**
 * Safety valve on one run, not a business rule — the backlog is normally a
 * handful of notes. Stops a runaway queue (or a loop bug) from spending
 * unbounded tokens in one night; the remainder is simply taken next run.
 */
const MAX_NOTES_PER_RUN = 500;

/** Collaborators, injected so tests can drive a run deterministically. */
export interface ConsolidateDeps {
  /** One LLM pass (real: `chatCompletion` with the configured model). */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /** Embed texts, or null when no embedding model is configured. */
  embed: ((texts: string[]) => Promise<number[][]>) | null;
  /** Publish live per-note progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  db?: DrizzleDb;
}

export interface ConsolidateResult {
  /** People whose document was rewritten. */
  usersUpdated: number;
  /** General facts inserted, replaced, and skipped as duplicates. */
  generalInserted: number;
  generalReplaced: number;
  generalSkipped: number;
  /** Notes folded in and deleted. */
  consumed: number;
  /** Notes whose pass failed; left pending for the next run. */
  failed: number;
  summary: string;
}

const EMPTY: Omit<ConsolidateResult, "summary"> = {
  usersUpdated: 0,
  generalInserted: 0,
  generalReplaced: 0,
  generalSkipped: 0,
  consumed: 0,
  failed: 0,
};

/**
 * Run one consolidation pass over the pending queue. Never throws for a per-note
 * failure. Records one trace when there is a backlog, and stays silent otherwise
 * so the nightly tick does not spam Debug with empty runs.
 */
export async function runMemoryConsolidation(deps: ConsolidateDeps): Promise<ConsolidateResult> {
  const db = deps.db ?? getDb();

  const [userIds, generalEntries] = await Promise.all([
    listUsersWithPendingEntries(db),
    getPendingGeneralEntries(db),
  ]);
  if (userIds.length === 0 && generalEntries.length === 0) {
    return { ...EMPTY, summary: "nothing to consolidate" };
  }

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "consolidate",
      trigger: { kind: "system", actor: "memory" },
      inputSummary: `${userIds.length} user(s), ${generalEntries.length} general note(s) pending`,
    },
    db,
  );

  const result = { ...EMPTY };

  /** One LLM pass, fully traced (request + response with usage). Null on failure. */
  async function complete(system: string, userContent: string): Promise<string | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];
    await trace.event({ type: "llm_request", message: "request", data: { messages } });
    try {
      const completion = await deps.complete(messages);
      await trace.event({
        type: "llm_response",
        message: "response",
        data: completion.responseBody ?? { content: completion.content },
        usage: {
          model: completion.model,
          promptTokens: completion.usage?.promptTokens,
          completionTokens: completion.usage?.completionTokens,
          totalTokens: completion.usage?.totalTokens,
          latencyMs: completion.latencyMs,
        },
      });
      return completion.content;
    } catch (err) {
      result.failed += 1;
      await trace.event({
        type: "error",
        level: "warn",
        message: "LLM pass failed — notes left pending for the next run",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  /**
   * Embed one text, or null when embeddings are unconfigured or the call failed.
   * A failure is degradation, not an error: the row is stored unembedded (and
   * shown as such on the dashboard) rather than the whole note being lost.
   */
  async function embedOne(text: string): Promise<number[] | null> {
    if (!deps.embed) return null;
    try {
      const [vector] = await deps.embed([text]);
      return vector ?? null;
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: "embedding failed — memory stored without semantic search",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  try {
    let budget = MAX_NOTES_PER_RUN;
    // Combined denominator across both passes; a running index for the live bar.
    const total = userIds.length + generalEntries.length;
    let processed = 0;

    /* Pass 1 — one document merge per person. */
    for (const userId of userIds) {
      if (budget <= 0) break;
      const entries = (await getPendingUserEntries(db, userId)).slice(0, budget);
      if (entries.length === 0) continue;

      const [user] = await getKnownUsersByIds(db, [userId]);
      const label = user ? formatKnownUserLabel(user) : `User ${userId}`;
      deps.onProgress?.({ step: `Consolidating memory of ${label}`, current: ++processed, total });
      const existing = await getUserMemory(db, userId);
      const existingFacts = existing ? splitMemoryFacts(existing.content) : [];

      await trace.event({
        type: "step",
        message: `merge memory of ${label}`,
        data: {
          userId,
          label,
          existingFacts: existingFacts.length,
          incomingNotes: entries.length,
        },
      });

      const content = await complete(
        USER_MERGE_PROMPT,
        buildUserMergeRequest({
          label,
          existing: existingFacts,
          incoming: entries.map((e) => e.content),
        }),
      );
      if (!content) continue;

      const merged = parseMergedDocument(content);
      if (merged.length === 0) {
        // An empty merge means the model returned nothing usable. Treat it as a
        // failed pass, NOT as "this person has no memory" — acting on it would
        // erase a document that took months to accumulate. The notes stay pending.
        result.failed += 1;
        await trace.event({
          type: "step",
          level: "warn",
          message: "merge produced no document — memory left untouched, notes left pending",
          data: { userId, content },
        });
        continue;
      }

      const document = merged.join("\n");
      const stored = await upsertUserMemory(db, {
        userId,
        content: document,
        embedding: await embedOne(document),
      });

      await deleteMemoryEntries(
        db,
        entries.map((e) => e.id),
      );
      budget -= entries.length;
      result.consumed += entries.length;
      result.usersUpdated += 1;

      await trace.event({
        type: "step",
        level: "success",
        message: `memory of ${label} updated`,
        data: {
          userId,
          factsBefore: existingFacts.length,
          factsAfter: merged.length,
          notesFolded: entries.length,
          embedded: stored.embedded,
          document,
        },
      });
    }

    /* Pass 2 — one reconcile per general note. */
    for (const entry of generalEntries) {
      if (budget <= 0) break;
      deps.onProgress?.({ step: "Reconciling general fact", current: ++processed, total });

      const embedding = await embedOne(entry.content);
      const candidates = await findSimilarGeneralMemories(db, {
        content: entry.content,
        embedding,
        limit: SIMILAR_CANDIDATES,
      });

      await trace.event({
        type: "step",
        message: "reconcile general fact",
        data: { entryId: entry.id, note: entry.content, candidates: candidates.length },
      });

      const content = await complete(
        GENERAL_RECONCILE_PROMPT,
        buildGeneralReconcileRequest({
          note: entry.content,
          candidates: candidates.map((c) => ({ id: c.id, content: c.content })),
        }),
      );
      if (!content) continue;

      const decision = parseGeneralDecision(
        content,
        candidates.map((c) => c.id),
      );
      if (!decision) {
        result.failed += 1;
        await trace.event({
          type: "step",
          level: "warn",
          message: "unusable reconcile decision — note left pending for the next run",
          data: { entryId: entry.id, content },
        });
        continue;
      }

      if (decision.action === "skip") {
        result.generalSkipped += 1;
        await trace.event({
          type: "step",
          message: "already known — general fact not stored again",
          data: { entryId: entry.id, note: entry.content },
        });
      } else {
        // The stored line is the model's cleaned-up rewrite, so embed *that* —
        // embedding the raw note would leave the vector describing text the row
        // does not contain.
        const stored = await insertGeneralMemory(db, {
          content: decision.content,
          embedding: await embedOne(decision.content),
        });
        const replaced =
          decision.action === "replace"
            ? await deleteGeneralMemories(db, decision.replaces)
            : 0;

        if (decision.action === "replace") result.generalReplaced += 1;
        else result.generalInserted += 1;

        await trace.event({
          type: "step",
          level: "success",
          message: decision.action === "replace" ? "general fact replaced" : "general fact stored",
          data: {
            entryId: entry.id,
            memoryId: stored.id,
            content: decision.content,
            supersededIds: decision.action === "replace" ? decision.replaces : [],
            superseded: replaced,
            embedded: stored.embedded,
          },
        });
      }

      await deleteMemoryEntries(db, [entry.id]);
      budget -= 1;
      result.consumed += 1;
    }

    const summary =
      `${result.usersUpdated} user memor${result.usersUpdated === 1 ? "y" : "ies"} updated, ` +
      `${result.generalInserted} general fact(s) stored, ${result.generalReplaced} replaced, ` +
      `${result.generalSkipped} already known` +
      (result.failed > 0 ? `, ${result.failed} left pending` : "");

    await trace.succeed({ outputSummary: summary });
    publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
    return { ...result, summary };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
