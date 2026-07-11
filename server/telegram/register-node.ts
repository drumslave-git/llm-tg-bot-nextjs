import "server-only";

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
    await Promise.race([
      stopBot().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

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
