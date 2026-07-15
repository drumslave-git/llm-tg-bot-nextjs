import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { chatMessages, traceEvents, traces } from "@/db/schema";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";

import { getMetrics } from "./metrics";
import { runAnalyticsInsights } from "./insights";
import { getPeriodInsight } from "./repository";

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

async function seedMessage(input: {
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId?: string | null;
  content: string;
  sentAt: Date;
}) {
  await ctx.db.insert(chatMessages).values({
    chatId: input.chatId,
    telegramMessageId: input.telegramMessageId,
    role: input.role,
    userId: input.userId ?? null,
    content: input.content,
    sentAt: input.sentAt,
  });
}

async function seedLlmUsage(model: string, latencyMs: number, tokens: { p: number; c: number }) {
  const traceId = crypto.randomUUID();
  await ctx.db.insert(traces).values({
    id: traceId,
    feature: "bot-messaging",
    action: "reply",
    status: "success",
    triggerKind: "telegram",
    startedAt: new Date(),
  });
  await ctx.db.insert(traceEvents).values({
    id: crypto.randomUUID(),
    traceId,
    seq: 0,
    ts: new Date(),
    type: "llm_response",
    level: "info",
    message: "response",
    usage: {
      model,
      promptTokens: tokens.p,
      completionTokens: tokens.c,
      totalTokens: tokens.p + tokens.c,
      latencyMs,
    },
  });
}

/** A stub that answers the day and period prompts with valid JSON. */
function stubComplete(overrides?: { day?: string; period?: string }) {
  return async (messages: ChatMessage[]): Promise<ChatCompletionResult> => {
    const user = String(messages[1]?.content ?? "");
    const isDay = user.includes("Conversation (one day)");
    const content = isDay
      ? overrides?.day ??
        '{"moodScore":70,"moodLabel":"positive","moodSummary":"good chat","topTopic":"weekend"}'
      : overrides?.period ?? '{"wordOfPeriod":"weekend","topTopic":"weekend plans"}';
    return {
      content,
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      latencyMs: 15,
      requestBody: {},
      responseBody: {},
    };
  };
}

describe("getMetrics (live SQL aggregation)", () => {
  it("aggregates message, character, and model metrics", async () => {
    const now = new Date();
    await seedMessage({ chatId: "c1", telegramMessageId: 1, role: "user", userId: "u1", content: "hello", sentAt: now });
    await seedMessage({ chatId: "c1", telegramMessageId: 2, role: "assistant", content: "hi there", sentAt: now });
    await seedMessage({ chatId: "c1", telegramMessageId: 3, role: "user", userId: "u2", content: "yo", sentAt: now });

    // Two usage events under different registry-prefixed names for the same model.
    await seedLlmUsage("docker.io/ai/gemma3:12b", 1000, { p: 100, c: 50 });
    await seedLlmUsage("gemma3:12b", 3000, { p: 200, c: 150 });

    const m = await getMetrics({ granularity: "day" }, ctx.db);

    expect(m.totals.humanMessages).toBe(2);
    expect(m.totals.botMessages).toBe(1);
    expect(m.totals.charsProcessed).toBe("hello".length + "yo".length);
    expect(m.totals.charsGenerated).toBe("hi there".length);
    expect(m.totals.activeUsers).toBe(2);

    // The dense series aligns to the bucket axis and sums to the totals.
    expect(m.volume.human.length).toBe(m.buckets.length);
    expect(m.volume.human.reduce((a, b) => a + b, 0)).toBe(2);

    // Registry-prefixed variants merge into one clean model name.
    expect(m.models).toHaveLength(1);
    expect(m.models[0].model).toBe("gemma3:12b");
    expect(m.models[0].calls).toBe(2);
    expect(m.models[0].totalTokens).toBe(150 + 350);
    expect(m.models[0].avgLatencyMs).toBe(2000);
  });

  it("scopes to one chat when filtered", async () => {
    const now = new Date();
    await seedMessage({ chatId: "c1", telegramMessageId: 1, role: "user", userId: "u1", content: "a", sentAt: now });
    await seedMessage({ chatId: "c2", telegramMessageId: 1, role: "user", userId: "u1", content: "bb", sentAt: now });

    const m = await getMetrics({ granularity: "day", chatId: "c1" }, ctx.db);
    expect(m.scope).toBe("chat");
    expect(m.totals.humanMessages).toBe(1);
    expect(m.totals.charsProcessed).toBe(1);
  });
});

describe("runAnalyticsInsights", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");

  async function seedFinishedDay(chatId = "c1", telegramMessageId = 1) {
    await seedMessage({
      chatId,
      telegramMessageId,
      role: "user",
      userId: "u1",
      content: "planning the weekend trip",
      sentAt: new Date("2026-07-14T09:00:00Z"),
    });
    await seedMessage({
      chatId,
      telegramMessageId: telegramMessageId + 1,
      role: "assistant",
      content: "sounds fun!",
      sentAt: new Date("2026-07-14T09:01:00Z"),
    });
  }

  it("scores a finished day and rolls up its periods, and traces the run", async () => {
    await seedFinishedDay();

    const result = await runAnalyticsInsights({
      complete: stubComplete(),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });

    expect(result.daysComputed).toBe(1);
    // month + year + all, each for global + chat scope = 6 roll-ups.
    expect(result.periodsComputed).toBe(6);

    const globalAll = await getPeriodInsight(ctx.db, {
      granularity: "all",
      bucket: "all",
      scope: "global",
      chatId: "",
    });
    expect(globalAll?.wordOfPeriod).toBe("weekend");
    expect(globalAll?.moodScore).toBe(70);

    const runTraces = await listTraces(ctx.db, { feature: "analytics-insights" });
    expect(runTraces.traces).toHaveLength(1);
    expect(runTraces.traces[0].status).toBe("success");
  });

  it("is idempotent — an unchanged day is not recomputed", async () => {
    await seedFinishedDay();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const again = await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });
    expect(again.daysComputed).toBe(0);
    expect(again.summary).toContain("nothing to compute");
  });

  it("self-heals when a day's message count changes", async () => {
    await seedFinishedDay();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    // A late message lands on the same day → the count changes → recompute.
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 99,
      role: "user",
      userId: "u1",
      content: "one more thing",
      sentAt: new Date("2026-07-14T20:00:00Z"),
    });
    const healed = await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });
    expect(healed.daysComputed).toBe(1);
  });

  it("fails closed — a garbled model response leaves the day unstored", async () => {
    await seedFinishedDay();

    const result = await runAnalyticsInsights({
      complete: stubComplete({ day: "not valid json" }),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });
    expect(result.daysComputed).toBe(0);
    expect(result.daysFailed).toBe(1);

    const globalAll = await getPeriodInsight(ctx.db, {
      granularity: "all",
      bucket: "all",
      scope: "global",
      chatId: "",
    });
    expect(globalAll).toBeNull();
  });
});
