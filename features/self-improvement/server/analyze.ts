import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getChatMessageByTelegramId } from "@/features/history/server/repository";
import { FEATURES } from "@/lib/features";
import { extractJsonObject } from "@/lib/json";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import type { JobProgress } from "@/server/jobs/progress";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { normalizeModelName } from "../model-name";
import type { UserFeedback } from "../types";
import {
  getLatestCorrection,
  getLatestPreference,
  insertCorrection,
  insertPreference,
  listUnincorporatedForCorrections,
  listUnincorporatedForPrefs,
  stampCorrectionsVersion,
  stampPrefsVersion,
} from "./repository";

/**
 * The daily incorporation job: distill completed-but-unincorporated feedbacks
 * into a new per-user communication-preferences version and a new global
 * self-corrections version.
 *
 * Context discipline (user requirement): each feedback is folded in its own LLM
 * call so a large backlog can never overflow the context, and shared data (the
 * bot persona) is stated once per call rather than repeated per exchange. Every
 * fold starts from the running draft (previous version seeded), so the result
 * is an iterative refinement.
 */

const FEATURE = FEATURES["self-improvement"];

/** Collaborators, injected so tests can drive the run deterministically. */
export interface SelfImprovementDeps {
  /** Generate one fold step (real: `chatCompletion` with the configured model). */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /** Active persona prompt, stated once per fold call as bot context. */
  personalityPrompt?: string | null;
  /** Configured model id — fallback for stamping when the provider reports none. */
  model?: string | null;
  /** Publish live per-fold progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  db?: DrizzleDb;
}

export interface SelfImprovementResult {
  /** Users whose preferences got a new version. */
  prefsUpdated: number;
  /** Whether a new self-corrections version was written. */
  correctionsUpdated: boolean;
  /** Feedbacks folded (across both passes, deduplicated). */
  incorporated: number;
  /** Fold calls that failed and were left for the next run. */
  failed: number;
  summary: string;
}

/** System prompt for the per-user preferences fold. */
const PREFS_FOLD_PROMPT =
  "You maintain a factual profile of what one specific user likes and dislikes about the replies " +
  "of a Telegram chat bot. You are given the current profile and ONE new piece of feedback from " +
  "that user (the exchange and what they said about it). Update the profile to incorporate the " +
  "feedback: keep each field to a few short, concrete phrases; deduplicate; keep still-valid " +
  "existing points; drop points the new feedback contradicts. " +
  'Reply with ONLY a JSON object of the shape {"likes": string, "dislikes": string} — no code ' +
  "fences, no commentary.";

/** System prompt for the global self-corrections fold. */
const CORRECTIONS_FOLD_PROMPT =
  "You maintain a short list of self-correction guidelines for a Telegram chat bot, distilled " +
  "from feedback across many users. You are given the current guidelines and ONE new piece of " +
  "feedback (the exchange and what the user said about it). Update the guidelines: fold in " +
  "generalizable complaints or praise; keep them actionable, deduplicated, and few (at most ~10 " +
  "bullet points). Leave out user-specific preferences — only improvements that apply to " +
  "everyone. Reply with ONLY the updated guidelines text, no commentary.";

/** The bot persona, stated once per fold call (never repeated per exchange). */
function personaContext(personalityPrompt: string | null | undefined): string | null {
  const persona = personalityPrompt?.trim();
  if (!persona) return null;
  return `For context, the bot's configured persona:\n${persona}`;
}

/**
 * Render one feedback as a compact exchange block: the user's message, the
 * bot's reply, and what the user said about it. Loaded from the history mirror
 * (the trace's full bodies stay linked for the operator, but the mirror carries
 * the same exchange text without the repeated per-trace boilerplate).
 */
async function renderExchange(db: DrizzleDb, feedback: UserFeedback): Promise<string> {
  const reply = await getChatMessageByTelegramId(db, feedback.chatId, feedback.telegramMessageId);
  const asked =
    reply?.replyToMessageId != null
      ? await getChatMessageByTelegramId(db, feedback.chatId, reply.replyToMessageId)
      : null;
  const lines = [
    `User message: ${asked?.content?.trim() || "(not available)"}`,
    `Bot reply: ${reply?.content?.trim() || "(not available)"}`,
    `User reaction: ${feedback.reaction === "up" ? "👍 liked it" : "👎 disliked it"}`,
    `User feedback: ${feedback.feedback ?? "(none)"}`,
  ];
  return lines.join("\n");
}

/** The preferences profile the model is asked to emit, or null when it did not. */
export function parsePrefsJson(content: string): { likes: string; dislikes: string } | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  if (typeof obj.likes !== "string" || typeof obj.dislikes !== "string") return null;
  return { likes: obj.likes, dislikes: obj.dislikes };
}

/** Group feedbacks by user, preserving order. */
function groupByUser(feedbacks: UserFeedback[]): Map<string, UserFeedback[]> {
  const groups = new Map<string, UserFeedback[]>();
  for (const feedback of feedbacks) {
    const list = groups.get(feedback.userId);
    if (list) list.push(feedback);
    else groups.set(feedback.userId, [feedback]);
  }
  return groups;
}

/**
 * Run one incorporation pass. Never throws for per-fold failures — a failed
 * fold leaves its feedback unstamped for the next run. Returns a summary for
 * the job status; records one trace when there is a backlog (silent no-op
 * otherwise, so the daily tick doesn't spam Debug).
 */
export async function runSelfImprovement(deps: SelfImprovementDeps): Promise<SelfImprovementResult> {
  const db = deps.db ?? getDb();

  const [prefsBacklog, correctionsBacklog] = await Promise.all([
    listUnincorporatedForPrefs(db),
    listUnincorporatedForCorrections(db),
  ]);
  if (prefsBacklog.length === 0 && correctionsBacklog.length === 0) {
    return {
      prefsUpdated: 0,
      correctionsUpdated: false,
      incorporated: 0,
      failed: 0,
      summary: "nothing to incorporate",
    };
  }

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "incorporate",
      trigger: { kind: "system", actor: "self-improvement" },
      inputSummary: `${prefsBacklog.length} feedback(s) for preferences, ${correctionsBacklog.length} for corrections`,
    },
    db,
  );

  const persona = personaContext(deps.personalityPrompt);
  const fallbackModel = normalizeModelName(deps.model);
  const incorporatedIds = new Set<string>();
  let failed = 0;
  // Every feedback across both passes is one fold call — the live bar's denominator.
  const total = prefsBacklog.length + correctionsBacklog.length;
  let processed = 0;

  /** One fold call, fully traced (request + response with usage). */
  async function fold(system: string, userContent: string): Promise<ChatCompletionResult | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...(persona ? [{ role: "system" as const, content: persona }] : []),
      { role: "user", content: userContent },
    ];
    await trace.event({ type: "llm_request", message: "request", data: { messages } });
    try {
      const result = await deps.complete(messages);
      await trace.event({
        type: "llm_response",
        message: "response",
        data: result.responseBody ?? { content: result.content },
        usage: {
          model: result.model,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          totalTokens: result.usage?.totalTokens,
          latencyMs: result.latencyMs,
        },
      });
      return result;
    } catch (err) {
      failed += 1;
      await trace.event({
        type: "error",
        level: "warn",
        message: "fold call failed — feedback left for the next run",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  try {
    // Pass 1 — per-user communication preferences.
    let prefsUpdated = 0;
    for (const [userId, feedbacks] of groupByUser(prefsBacklog)) {
      const previous = await getLatestPreference(db, userId);
      let draft = { likes: previous?.likes ?? "", dislikes: previous?.dislikes ?? "" };
      let draftModel = fallbackModel;
      const folded: string[] = [];

      await trace.event({
        type: "step",
        message: `preferences fold for user ${userId}`,
        data: { userId, feedbackCount: feedbacks.length, previousVersion: previous?.version ?? null },
      });

      for (const feedback of feedbacks) {
        deps.onProgress?.({
          step: `Learning preferences for user ${userId}`,
          current: ++processed,
          total,
        });
        const exchange = await renderExchange(db, feedback);
        const result = await fold(
          PREFS_FOLD_PROMPT,
          `Current profile:\nLikes: ${draft.likes || "(empty)"}\nDislikes: ${draft.dislikes || "(empty)"}\n\nNew feedback:\n${exchange}`,
        );
        if (!result) continue;
        const parsed = parsePrefsJson(result.content);
        if (!parsed) {
          failed += 1;
          await trace.event({
            type: "step",
            level: "warn",
            message: "unparseable profile JSON — feedback left for the next run",
            data: { feedbackId: feedback.id, content: result.content },
          });
          continue;
        }
        draft = parsed;
        draftModel = normalizeModelName(result.model ?? deps.model);
        folded.push(feedback.id);
      }

      if (folded.length === 0) continue;
      const version = (previous?.version ?? 0) + 1;
      await insertPreference(db, {
        id: randomUUID(),
        userId,
        model: draftModel,
        likes: draft.likes,
        dislikes: draft.dislikes,
        version,
      });
      await stampPrefsVersion(db, folded, version);
      for (const id of folded) incorporatedIds.add(id);
      prefsUpdated += 1;
      await trace.event({
        type: "db",
        level: "success",
        message: `preferences v${version} written`,
        data: { userId, version, likes: draft.likes, dislikes: draft.dislikes, incorporated: folded },
      });
    }

    // Pass 2 — global self-corrections, folded across all users' feedbacks.
    let correctionsUpdated = false;
    if (correctionsBacklog.length > 0) {
      const previous = await getLatestCorrection(db);
      let draft = previous?.correction ?? "";
      let draftModel = fallbackModel;
      const folded: string[] = [];

      await trace.event({
        type: "step",
        message: "self-corrections fold",
        data: { feedbackCount: correctionsBacklog.length, previousVersion: previous?.version ?? null },
      });

      for (const feedback of correctionsBacklog) {
        deps.onProgress?.({ step: "Folding self-corrections", current: ++processed, total });
        const exchange = await renderExchange(db, feedback);
        const result = await fold(
          CORRECTIONS_FOLD_PROMPT,
          `Current guidelines:\n${draft || "(none yet)"}\n\nNew feedback:\n${exchange}`,
        );
        if (!result) continue;
        const next = result.content.trim();
        if (!next) {
          failed += 1;
          await trace.event({
            type: "step",
            level: "warn",
            message: "empty guidelines output — feedback left for the next run",
            data: { feedbackId: feedback.id },
          });
          continue;
        }
        draft = next;
        draftModel = normalizeModelName(result.model ?? deps.model);
        folded.push(feedback.id);
      }

      if (folded.length > 0) {
        const version = (previous?.version ?? 0) + 1;
        await insertCorrection(db, {
          id: randomUUID(),
          model: draftModel,
          correction: draft,
          version,
        });
        await stampCorrectionsVersion(db, folded, version);
        for (const id of folded) incorporatedIds.add(id);
        correctionsUpdated = true;
        await trace.event({
          type: "db",
          level: "success",
          message: `self-corrections v${version} written`,
          data: { version, correction: draft, incorporated: folded },
        });
      }
    }

    const summary =
      `${prefsUpdated} user profile(s) updated, ` +
      `corrections ${correctionsUpdated ? "updated" : "unchanged"}, ` +
      `${incorporatedIds.size} feedback(s) incorporated` +
      (failed ? `, ${failed} fold(s) failed` : "");
    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({ outputSummary: summary });
    return {
      prefsUpdated,
      correctionsUpdated,
      incorporated: incorporatedIds.size,
      failed,
      summary,
    };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
