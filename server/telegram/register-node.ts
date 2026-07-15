import "server-only";

import {
  startSummaryScheduler,
  stopSummaryScheduler,
} from "@/features/history/server/summary-scheduler";
import { startMemoryScheduler, stopMemoryScheduler } from "@/features/memory/server/scheduler";
import { startTaskScheduler, stopTaskScheduler } from "@/features/scheduled-tasks/server/scheduler";
import {
  startSelfImprovementScheduler,
  stopSelfImprovementScheduler,
} from "@/features/self-improvement/server/scheduler";
import { startVisionBackfill, stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";

import { startBot, stopBot } from "./bot-manager";

/**
 * Node-runtime bot bootstrap, split out of `instrumentation.ts` so the Node-only
 * `process` APIs (signal handlers, exit) never appear in the Edge-analyzed
 * instrumentation module. Imported dynamically only when the server runs in the
 * Node.js runtime.
 */
export function registerNode(): void {
  // Release the single getUpdates lock promptly on shutdown so a restart/redeploy
  // doesn't collide with the previous poller.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopVisionBackfill();
    stopTaskScheduler();
    stopSelfImprovementScheduler();
    stopSummaryScheduler();
    stopMemoryScheduler();
    await Promise.race([
      stopBot().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  // Start the in-process vision-backfill scheduler. It arms an initial run so any
  // media left `pending` from before boot is captioned during the first quiet
  // window; bot activity re-arms the idle wait thereafter. Independent of the bot
  // token — a run with no LLM configured settles as a no-op.
  startVisionBackfill();

  // Start the periodic scheduled-tasks poller. It fires due tasks at their
  // wall-clock time (independent of bot activity); a tick with no LLM configured,
  // no due tasks, or the bot stopped settles as a harmless no-op.
  startTaskScheduler();

  // Start the daily self-improvement poller. It checks once a minute whether the
  // configured local run time has been reached and incorporates the feedback
  // backlog; a tick with nothing due or no LLM configured is a harmless no-op.
  startSelfImprovementScheduler();

  // Start the daily history-summarization poller. At its configured local run
  // time it compresses each finished chat-day into searchable topic summaries
  // (including any days imported or edited since the last run); nothing due, or no
  // LLM configured, settles as a no-op.
  startSummaryScheduler();

  // Start the daily memory-consolidation poller. At its configured local run time
  // it folds the notes the bot saved during the day into durable memory (one merge
  // per person, one reconcile per general fact). Notes are already readable before
  // this runs — replies fold the pending queue in — so nothing due, or no LLM
  // configured, settles as a harmless no-op.
  startMemoryScheduler();

  // Fire-and-forget: do not block server startup on the Telegram handshake.
  void startBot().then((status) => {
    if (status.state === "running") {
      console.log(`Telegram bot @${status.username} started (long polling)`);
    } else {
      console.warn(
        `Telegram bot not autostarted: ${status.error ?? "no bot token configured — set one in Settings and Start it"}`,
      );
    }
  });
}
