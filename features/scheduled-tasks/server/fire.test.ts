import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the fire path from persistence: a no-op trace recorder and a stub db.
const recorder = vi.hoisted(() => ({
  id: "t1",
  event: vi.fn().mockResolvedValue(undefined),
  succeed: vi.fn().mockResolvedValue(undefined),
  skip: vi.fn().mockResolvedValue(undefined),
  fail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/trace", () => ({ startTrace: vi.fn().mockResolvedValue(recorder) }));
vi.mock("@/db/drizzle", () => ({ getDb: () => ({}) }));

import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";

import type { ScheduledTask } from "../types";
import { buildTaskDirectiveMessage, fireScheduledTask, type FireDeps } from "./fire";

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    chatId: "555",
    threadId: null,
    createdByUserId: "100",
    instruction: "remind me to call mom",
    scheduleKind: "daily",
    timeOfDay: "09:00",
    weekdays: null,
    runDate: null,
    enabled: true,
    recentDeliveries: [],
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

function completion(content: string): ChatCompletionResult {
  return {
    content,
    model: "m",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 12,
    requestBody: {},
    responseBody: { content },
  };
}

function deps(over: Partial<FireDeps> = {}): FireDeps {
  return {
    personalityPrompt: null,
    complete: vi.fn(async () => completion("Hey, don't forget to call your mom!")),
    send: vi.fn(async () => ({ messageId: 42 })),
    recordReply: vi.fn(async () => undefined),
    db: {} as never,
    ...over,
  };
}

describe("buildTaskDirectiveMessage", () => {
  it("includes the directive and no variation block when there are no prior deliveries", () => {
    const msg = buildTaskDirectiveMessage("water the plants", []);
    expect(msg).toContain("Directive: water the plants");
    expect(msg).not.toContain("delivered this recurring task before");
  });

  it("adds a variation block listing recent deliveries newest-first", () => {
    const msg = buildTaskDirectiveMessage("call mom", ["yesterday's line", "older line"]);
    expect(msg).toContain("delivered this recurring task before");
    expect(msg).toContain("1. yesterday's line");
    expect(msg).toContain("2. older line");
    expect(msg).toContain("DIFFERENT way");
  });
});

describe("fireScheduledTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates, delivers, mirrors, and succeeds", async () => {
    const d = deps();
    const result = await fireScheduledTask(task(), d);
    expect(result).toEqual({
      ok: true,
      text: "Hey, don't forget to call your mom!",
      messageId: 42,
    });
    // The composed messages carry a system prompt + the directive user turn.
    const messages = (d.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChatMessage[];
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("remind me to call mom");
    expect(d.send).toHaveBeenCalledWith("Hey, don't forget to call your mom!");
    expect(d.recordReply).toHaveBeenCalledWith({
      chatId: "555",
      telegramMessageId: 42,
      content: "Hey, don't forget to call your mom!",
    });
    expect(recorder.succeed).toHaveBeenCalled();
  });

  it("returns ok:false without delivering when generation throws", async () => {
    const d = deps({
      complete: vi.fn(async () => {
        throw new Error("provider down");
      }),
    });
    const result = await fireScheduledTask(task(), d);
    expect(result).toEqual({ ok: false });
    expect(d.send).not.toHaveBeenCalled();
    expect(recorder.skip).toHaveBeenCalled();
  });

  it("skips delivery when the model returns no visible content", async () => {
    const d = deps({ complete: vi.fn(async () => completion("   …  ")) });
    const result = await fireScheduledTask(task(), d);
    expect(result.ok).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("still succeeds (ok:true) when the best-effort history mirror fails", async () => {
    const d = deps({
      recordReply: vi.fn(async () => {
        throw new Error("db hiccup");
      }),
    });
    const result = await fireScheduledTask(task(), d);
    expect(result.ok).toBe(true);
    expect(recorder.succeed).toHaveBeenCalled();
  });
});
