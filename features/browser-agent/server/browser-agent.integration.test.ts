import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestDb, type TestDb } from "@/test/db";

import { enqueueBrowserRun, getBrowserAgentRunView, getBrowserAgentRuns } from "./service";
import {
  claimBrowserAgentRun,
  failStaleRunningRuns,
  getBrowserAgentRun,
  getBrowserRunScreenshot,
  insertBrowserRunScreenshot,
  listQueuedBrowserAgentRuns,
  settleBrowserAgentRun,
} from "./repository";

/**
 * The queue lifecycle against a real Postgres: enqueue → claim-once → settle,
 * plus the crash-safety sweep and screenshot storage. The claim atomicity is the
 * load-bearing invariant — it is what stops two overlapping processes (a
 * redeploy) from double-running a run — so it gets a direct concurrent test.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

describe("browser-agent queue", () => {
  it("enqueues a queued run visible to the queue and the dashboard list", async () => {
    const run = await enqueueBrowserRun(
      { goal: "find the pricing page", chatId: "123", isOwner: true },
      ctx.db,
    );
    expect(run.status).toBe("queued");
    expect(run.isOwner).toBe(true);

    const queued = await listQueuedBrowserAgentRuns(ctx.db);
    expect(queued.map((r) => r.id)).toContain(run.id);

    const all = await getBrowserAgentRuns(undefined, ctx.db);
    expect(all).toHaveLength(1);
  });

  it("claims a run exactly once — a second claim returns null", async () => {
    const run = await enqueueBrowserRun({ goal: "browse", chatId: "1", isOwner: false }, ctx.db);

    const [first, second] = await Promise.all([
      claimBrowserAgentRun(ctx.db, run.id),
      claimBrowserAgentRun(ctx.db, run.id),
    ]);

    const claims = [first, second].filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.status).toBe("running");
    expect(claims[0]!.startedAt).not.toBeNull();
    // Once running it is no longer in the queue.
    expect(await listQueuedBrowserAgentRuns(ctx.db)).toHaveLength(0);
  });

  it("settles a claimed run as done with its report, steps, and downloads", async () => {
    const run = await enqueueBrowserRun({ goal: "g", chatId: "1", isOwner: true }, ctx.db);
    await claimBrowserAgentRun(ctx.db, run.id);
    await settleBrowserAgentRun(ctx.db, run.id, {
      status: "done",
      report: "Found it.",
      steps: 4,
      downloads: [{ sourceUrl: "https://x/a", filename: "a.pdf", sizeBytes: 2048, inline: true }],
    });

    const settled = await getBrowserAgentRun(ctx.db, run.id);
    expect(settled).toMatchObject({ status: "done", report: "Found it.", steps: 4 });
    expect(settled!.downloads).toHaveLength(1);
    expect(settled!.finishedAt).not.toBeNull();
  });

  it("fails runs left running by a previous process", async () => {
    const run = await enqueueBrowserRun({ goal: "g", chatId: "1", isOwner: false }, ctx.db);
    await claimBrowserAgentRun(ctx.db, run.id);

    const reset = await failStaleRunningRuns(ctx.db);
    expect(reset).toBe(1);

    const swept = await getBrowserAgentRun(ctx.db, run.id);
    expect(swept!.status).toBe("failed");
    expect(swept!.error).toMatch(/restart/i);
  });

  it("stores and serves run screenshots by sequence, exposed on the detail view", async () => {
    const run = await enqueueBrowserRun({ goal: "g", chatId: "1", isOwner: true }, ctx.db);
    const bytes = Buffer.from([1, 2, 3, 4]);
    await insertBrowserRunScreenshot(ctx.db, {
      runId: run.id,
      seq: 0,
      url: "https://x/",
      title: "X",
      data: bytes,
    });

    const stored = await getBrowserRunScreenshot(ctx.db, run.id, 0);
    expect(stored).not.toBeNull();
    expect(Buffer.compare(stored!, bytes)).toBe(0);

    const detail = await getBrowserAgentRunView(run.id, ctx.db);
    expect(detail!.screenshotSeqs).toEqual([0]);
  });
});
