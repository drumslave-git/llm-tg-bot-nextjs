import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-error";
import { getTrace, listTraces } from "@/server/trace/repository";
import { startTrace, type StartTraceInput } from "@/server/trace/recorder";
import { startTestDb, type TestDb } from "@/test/db";

const baseInput: StartTraceInput = {
  feature: "bot",
  action: "reply",
  trigger: { kind: "telegram", actor: "chat:1", correlationId: "update:9" },
  inputSummary: "hello",
};

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

describe("startTrace (recorder → Drizzle)", () => {
  it("records a running trace with events and settles as success", async () => {
    const trace = await startTrace(baseInput, ctx.db);

    await trace.event({ type: "input", message: "received message" });
    await trace.event({
      type: "llm_response",
      message: "model replied",
      usage: { model: "m", promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await trace.succeed({ outputSummary: "hi there", relatedIds: { messages: ["m1"] } });

    const stored = await getTrace(ctx.db, trace.id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("success");
    expect(stored!.finishedAt).not.toBeNull();
    expect(stored!.outputSummary).toBe("hi there");
    expect(stored!.relatedIds).toEqual({ messages: ["m1"] });
    expect(stored!.trigger).toEqual({
      kind: "telegram",
      actor: "chat:1",
      correlationId: "update:9",
    });

    expect(stored!.events).toHaveLength(2);
    expect(stored!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(stored!.events[0].type).toBe("input");
    expect(stored!.events[1].usage?.totalTokens).toBe(15);
  });

  it("records failures with an error event and error status", async () => {
    const trace = await startTrace(baseInput, ctx.db);
    await trace.fail(ApiError.serviceUnavailable("LLM down"));

    const stored = await getTrace(ctx.db, trace.id);
    expect(stored!.status).toBe("error");
    expect(stored!.error).toEqual({ code: "service_unavailable", message: "LLM down" });
    const errorEvents = stored!.events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].level).toBe("error");
  });

  it("records skips with a reason", async () => {
    const trace = await startTrace(baseInput, ctx.db);
    await trace.skip("not addressed to bot");

    const stored = await getTrace(ctx.db, trace.id);
    expect(stored!.status).toBe("skipped");
    expect(stored!.outputSummary).toBe("not addressed to bot");
  });

  it("refuses to append or re-settle after settling", async () => {
    const trace = await startTrace(baseInput, ctx.db);
    await trace.succeed();

    await expect(trace.event({ message: "late" })).rejects.toThrow(/already settled/);
    await expect(trace.succeed()).rejects.toThrow(/already settled/);
  });

  it("cascades event deletion when a trace is removed", async () => {
    const trace = await startTrace(baseInput, ctx.db);
    await trace.event({ message: "step" });
    await trace.succeed();

    await ctx.db.execute("DELETE FROM traces");
    const events = await ctx.db.execute("SELECT COUNT(*)::int AS count FROM trace_events");
    // FK ON DELETE CASCADE removes the orphaned events.
    expect(Number((events.rows[0] as { count: number }).count)).toBe(0);
  });
});

describe("listTraces", () => {
  it("filters by feature and status, newest first, with total", async () => {
    const a = await startTrace({ ...baseInput, feature: "bot" }, ctx.db);
    await a.succeed();
    const b = await startTrace({ ...baseInput, feature: "memory" }, ctx.db);
    await b.fail(new Error("boom"));
    const c = await startTrace({ ...baseInput, feature: "bot" }, ctx.db);
    await c.succeed();

    const all = await listTraces(ctx.db, {});
    expect(all.total).toBe(3);
    expect(all.traces).toHaveLength(3);
    // Headers omit events for list performance.
    expect(all.traces[0].events).toEqual([]);

    const botOnly = await listTraces(ctx.db, { feature: "bot" });
    expect(botOnly.total).toBe(2);
    expect(botOnly.traces.every((t) => t.feature === "bot")).toBe(true);

    const errors = await listTraces(ctx.db, { status: "error" });
    expect(errors.total).toBe(1);
    expect(errors.traces[0].feature).toBe("memory");
  });

  it("applies limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      const t = await startTrace(baseInput, ctx.db);
      await t.succeed();
    }
    const page = await listTraces(ctx.db, { limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.traces).toHaveLength(2);
  });
});
