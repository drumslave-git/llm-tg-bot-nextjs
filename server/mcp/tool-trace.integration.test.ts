import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";
import type { McpToolCallResult } from "./tool-result";
import { tracedToolCall } from "./tool-trace";

/**
 * `tracedToolCall` wraps every MCP tool call in its own `mcp-tools-<owner>` trace.
 * Run against a real Postgres so the recorded trace/events are asserted end to end.
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

const ok: McpToolCallResult = { text: "echo: hi", isError: false };

describe("tracedToolCall", () => {
  it("records a success trace scoped to mcp-tools-<owner> with the tool name as action", async () => {
    const result = await tracedToolCall(
      "history",
      "history_search",
      { query: "hi" },
      async () => ok,
      ctx.db,
    );
    expect(result).toEqual(ok);

    const { traces } = await listTraces(ctx.db, { feature: "mcp-tools-history" });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "history_search", status: "success" });
  });

  it("settles success but flags an error result (isError) rather than failing the trace", async () => {
    await tracedToolCall(
      "web-search",
      "search_web",
      { q: "x" },
      async () => ({ text: "nope", isError: true }),
      ctx.db,
    );
    const { traces } = await listTraces(ctx.db, { feature: "mcp-tools-web-search" });
    expect(traces[0]).toMatchObject({ action: "search_web", status: "success" });
    expect(traces[0].outputSummary).toBe("error result");
  });

  it("fails the trace and rethrows when the tool throws", async () => {
    await expect(
      tracedToolCall(
        "history",
        "history_search",
        {},
        async () => {
          throw new Error("boom");
        },
        ctx.db,
      ),
    ).rejects.toThrow(/boom/);

    const { traces } = await listTraces(ctx.db, { feature: "mcp-tools-history" });
    expect(traces[0].status).toBe("error");
  });
});
