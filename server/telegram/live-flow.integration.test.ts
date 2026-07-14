import { loadEnvConfig } from "@next/env";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/drizzle";
import { closePool } from "@/db/pool";
import { chatMessages, knownUsers, messageMedia, traceEvents, traces } from "@/db/schema";
import { getLlmRuntime } from "@/features/settings/server/service";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import { simulateUpdate } from "@/test/simulate";

/**
 * Opt-in end-to-end test against the REAL configured LLM. Skipped unless
 * `LLM_LIVE=1`, so CI never spends tokens or needs a live backend.
 *
 * It uses the real `DATABASE_URL` and the LLM connection stored in DB settings
 * (baseUrl / key / model), driving a simulated message through the whole real
 * pipeline with no injected generator — so this exercises the actual provider.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- live-flow`
 * (requires DATABASE_URL configured and an LLM endpoint + model saved on /settings).
 *
 * A dedicated synthetic chat/user id keeps this isolated from real conversations,
 * and every row it writes (messages, media, traces, the test user) is removed
 * afterward.
 */

const LIVE = process.env.LLM_LIVE === "1";

const CHAT_ID = -987_654_321;
const USER_ID = "987654321";

async function cleanup(): Promise<void> {
  const db = getDb();
  const chatId = String(CHAT_ID);
  // Traces are keyed by correlationId = `${chatId}:${messageId}`; delete their
  // events first (no cascade assumption), then the traces themselves.
  const traceRows = await db
    .select({ id: traces.id })
    .from(traces)
    .where(like(traces.correlationId, `${chatId}:%`));
  const traceIds = traceRows.map((r) => r.id);
  if (traceIds.length > 0) {
    await db.delete(traceEvents).where(inArray(traceEvents.traceId, traceIds));
    await db.delete(traces).where(inArray(traces.id, traceIds));
  }
  await db.delete(messageMedia).where(eq(messageMedia.chatId, chatId));
  await db.delete(chatMessages).where(eq(chatMessages.chatId, chatId));
  await db.delete(knownUsers).where(eq(knownUsers.userId, USER_ID));
}

describe.skipIf(!LIVE)("processUpdate against the real configured LLM", () => {
  beforeAll(() => {
    // Load .env (DATABASE_URL etc.) exactly as the app does; LLM config comes
    // from DB settings once the pool is bound to the real database.
    loadEnvConfig(process.cwd());
  });

  afterAll(async () => {
    stopVisionBackfill();
    await cleanup().catch(() => undefined);
    await closePool();
  });

  it(
    "generates a real reply for a simulated private message",
    async () => {
      const runtime = await getLlmRuntime();
      if (!runtime) {
        throw new Error(
          "LLM is not configured in DB settings — set an endpoint + model on /settings first.",
        );
      }

      const res = await simulateUpdate({
        text: "Reply with a short, one-sentence greeting.",
        chatId: CHAT_ID,
        from: { id: Number(USER_ID), username: "livetest", firstName: "Live" },
      });

      expect(res.outcome.status).toBe("replied");
      expect(res.replies).toHaveLength(1);
      expect(res.replies[0].trim().length).toBeGreaterThan(0);

      // The reply was mirrored + traced against the real database.
      const traceRows = await getDb()
        .select({ status: traces.status, feature: traces.feature })
        .from(traces)
        .where(like(traces.correlationId, `${CHAT_ID}:%`));
      expect(traceRows.some((t) => t.feature === "bot-messaging" && t.status === "success")).toBe(
        true,
      );
    },
    180_000,
  );
});
