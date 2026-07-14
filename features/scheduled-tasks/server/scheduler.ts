import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { recordAssistantMessage } from "@/features/history/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { getBotPolicy, getLlmRuntime, getTimezone } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { chatCompletion, type ChatCompletionResult, type ChatMessage } from "@/server/llm/client";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
  type IntervalScheduler,
} from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { publishEvent } from "@/server/realtime/hub";
import { sendChatMessage } from "@/server/telegram/bot-manager";

import { computeNextRun } from "../schedule";
import { fireScheduledTask } from "./fire";
import {
  listDueScheduledTasks,
  markScheduledTaskRun,
  nextRecentDeliveries,
} from "./repository";

/**
 * In-process periodic scheduler for scheduled tasks, owned by a single
 * `globalThis` singleton (like the bot manager, MCP registry, and vision-backfill
 * scheduler) so there is exactly one per process and it survives HMR.
 *
 * Unlike the idle-debounced vision backfill, this is a fixed-interval poller
 * ({@link import("@/server/jobs/interval-scheduler")}): a task must fire at its
 * wall-clock instant regardless of whether the bot is busy. Each tick, under a
 * cross-process advisory lock, it scans for due tasks, fires each, then advances
 * `next_run_at` (a spent one-shot gets `null`, which disables the row). Firing is
 * paused while maintenance mode is on. The LLM connection is read fresh per tick.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 30_000;

const FEATURE = FEATURES["scheduled-tasks"];
const STORE_KEY = Symbol.for("llm-tg-bot.scheduled-tasks.scheduler");

/**
 * Collaborators the due-run loop needs. Injected so the whole tick can be driven
 * against a real database with a capturing reply sink + deterministic generator —
 * no live bot or LLM (the same simulation approach as the message-flow tests).
 */
export interface DueRunDeps {
  /** IANA timezone the schedules are interpreted in when advancing. */
  timezone: string;
  /** Active persona prompt for the fire's system prompt, or null. */
  personalityPrompt: string | null;
  /** Generate the task message (real: `chatCompletion`). */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /** Deliver to a chat (real: the bot's `sendChatMessage`); resolves the message id. */
  send: (chatId: string, text: string, opts: { threadId?: number | null }) => Promise<{ messageId: number }>;
  /** Mirror a delivered message into history (real: `recordAssistantMessage`). */
  recordReply?: (input: { chatId: string; telegramMessageId: number; content: string }) => Promise<void>;
  /** Now, for the due scan + schedule advance. Defaults to the wall clock. */
  now?: Date;
  db?: DrizzleDb;
}

/**
 * Fire every currently-due task and advance its schedule. Pure of scheduling
 * mechanics (the caller owns the lock/interval): scans due rows, fires each via
 * the injected collaborators, then stamps `last_run_at`/`next_run_at` (a spent
 * one-shot → null → disabled) and the capped `recent_deliveries`. Never throws
 * per task — a failing fire still advances so it doesn't busy-loop.
 */
export async function runDueScheduledTasks(deps: DueRunDeps): Promise<{ fired: number; failed: number }> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const due = await listDueScheduledTasks(db, now);
  if (due.length === 0) return { fired: 0, failed: 0 };

  let fired = 0;
  let failed = 0;
  for (const task of due) {
    const result = await fireScheduledTask(task, {
      personalityPrompt: deps.personalityPrompt,
      complete: deps.complete,
      send: (text) => deps.send(task.chatId, text, { threadId: task.threadId }),
      recordReply: deps.recordReply,
      db,
    }).catch(() => ({ ok: false as const }));
    if (result.ok) fired += 1;
    else failed += 1;
    // Advance regardless of fire success so a failing task doesn't busy-loop.
    await markScheduledTaskRun(db, task.id, {
      lastRunAt: now,
      nextRunAt: computeNextRun(task, now, deps.timezone),
      recentDeliveries: result.ok ? nextRecentDeliveries(task.recentDeliveries ?? [], result.text!) : undefined,
    }).catch(() => undefined);
    publishEvent(FEATURE.realtimeTopic);
  }
  return { fired, failed };
}

/** One poll tick: wire the real LLM + bot collaborators and fire due tasks under the lock. */
async function runTick(): Promise<{ summary: string }> {
  // Pause firing during maintenance — the bot is owner-only then, so it should
  // not push proactive task messages into arbitrary chats.
  const policy = await getBotPolicy().catch(() => null);
  if (policy?.maintenanceModeEnabled) return { summary: "paused (maintenance)" };

  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return { summary: "LLM not configured" };
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };

  const outcome = await withAdvisoryLock("scheduled-tasks", async () => {
    const [timezone, personalityPrompt] = await Promise.all([
      getTimezone().catch(() => "UTC"),
      getActivePersonalityPrompt().catch(() => null),
    ]);
    return runDueScheduledTasks({
      timezone,
      personalityPrompt,
      complete: (messages) => chatCompletion(conn, { model: runtime.model, messages }),
      send: (chatId, text, opts) => sendChatMessage(chatId, text, opts),
      recordReply: (input) =>
        recordAssistantMessage({
          chatId: input.chatId,
          telegramMessageId: input.telegramMessageId,
          content: input.content,
          replyToMessageId: null,
        }).then(() => undefined),
    });
  });

  if (!outcome.ran) return { summary: "skipped (locked elsewhere)" };
  const { fired, failed } = outcome.result;
  return { summary: `${fired} fired${failed ? `, ${failed} failed` : ""}` };
}

function scheduler(): IntervalScheduler {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: IntervalScheduler };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createIntervalScheduler({
      name: "scheduled-tasks",
      tickMs: TICK_MS,
      onStatusChange: () => publishEvent(FEATURE.realtimeTopic),
      run: runTick,
    });
  }
  return g[STORE_KEY];
}

/** Start the periodic task poller (boot). Idempotent. */
export function startTaskScheduler(): void {
  scheduler().start();
}

/** Stop the poller (shutdown). */
export function stopTaskScheduler(): void {
  scheduler().stop();
}

/** Trigger one poll tick as soon as possible (dashboard "Run due now"). */
export function runTaskSchedulerNow(): Promise<void> {
  return scheduler().runNow();
}

/** Current scheduler status — cheap and synchronous, safe for status probes. */
export function getTaskSchedulerStatus(): IntervalJobStatus {
  return scheduler().getStatus();
}
