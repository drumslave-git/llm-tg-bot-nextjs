import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isApiError } from "@/lib/api-error";
import {
  buildTraceBundle,
  buildTraceListBundle,
  getTraceDetail,
  getTraceList,
} from "@/server/trace/service";
import { startTrace, type StartTraceInput } from "@/server/trace/recorder";
import { startTestDb, type TestDb } from "@/test/db";

const baseInput: StartTraceInput = {
  feature: "bot-messaging",
  action: "reply",
  trigger: { kind: "telegram", actor: "chat:1" },
  inputSummary: "hello",
};

/** Seed one settled trace and return its id. */
async function seed(overrides: Partial<StartTraceInput> = {}, fail = false): Promise<string> {
  const trace = await startTrace({ ...baseInput, ...overrides }, ctx.db);
  await trace.event({ type: "input", message: "received" });
  if (fail) await trace.fail(new Error("boom"));
  else await trace.succeed({ outputSummary: "hi" });
  return trace.id;
}

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

describe("getTraceList", () => {
  it("returns paged headers, total, and the distinct feature list", async () => {
    await seed({ feature: "settings", action: "update" });
    await seed({ feature: "bot-messaging" });
    await seed({ feature: "bot-messaging" }, true);

    const all = await getTraceList({}, ctx.db);
    expect(all.total).toBe(3);
    expect(all.traces).toHaveLength(3);
    // Newest first; headers carry no events.
    expect(all.traces[0].events).toEqual([]);
    expect(all.features).toEqual(["bot-messaging", "settings"]);
    expect(all.limit).toBe(50);
    expect(all.offset).toBe(0);
  });

  it("filters by feature and status", async () => {
    await seed({ feature: "settings" });
    await seed({ feature: "bot-messaging" }, true);

    const errors = await getTraceList({ status: "error" }, ctx.db);
    expect(errors.total).toBe(1);
    expect(errors.traces[0].feature).toBe("bot-messaging");

    const settings = await getTraceList({ feature: "settings" }, ctx.db);
    expect(settings.total).toBe(1);
    // The feature list reflects everything recorded, not just the filtered slice.
    expect(settings.features).toEqual(["bot-messaging", "settings"]);
  });

  it("echoes the requested paging window", async () => {
    await seed();
    const page = await getTraceList({ limit: 10, offset: 5 }, ctx.db);
    expect(page.limit).toBe(10);
    expect(page.offset).toBe(5);
  });
});

describe("getTraceDetail", () => {
  it("returns the full trace with ordered events", async () => {
    const id = await seed();
    const trace = await getTraceDetail(id, ctx.db);
    expect(trace.id).toBe(id);
    expect(trace.events.length).toBeGreaterThan(0);
    expect(trace.events[0].type).toBe("input");
  });

  it("throws a not_found ApiError for an unknown id", async () => {
    const err = await getTraceDetail("missing", ctx.db).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("not_found");
  });
});

describe("buildTraceBundle", () => {
  it("wraps a single trace (with events) in the shared bundle envelope", async () => {
    const id = await seed();
    const bundle = await buildTraceBundle(id, ctx.db);
    expect(bundle.schema).toBe("llm-tg-bot/trace-bundle@1");
    expect(bundle.exportedAt).toBeDefined();
    expect(bundle.traces).toHaveLength(1);
    expect(bundle.traces[0].id).toBe(id);
    expect(bundle.traces[0].events.length).toBeGreaterThan(0);
  });
});

describe("buildTraceListBundle", () => {
  it("bundles the filtered traces, each with its events attached", async () => {
    await seed({ feature: "settings" });
    await seed({ feature: "bot-messaging" });

    const bundle = await buildTraceListBundle({ feature: "bot-messaging" }, ctx.db);
    expect(bundle.traces).toHaveLength(1);
    expect(bundle.traces[0].feature).toBe("bot-messaging");
    expect(bundle.traces[0].events.length).toBeGreaterThan(0);
  });
});
