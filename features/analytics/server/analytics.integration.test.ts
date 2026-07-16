import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { chatMessages, traceEvents, traces } from "@/db/schema";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";

import { getMetricTotals, getSeries, getSystemStats } from "./metrics";
import { regenerateAnalyticsInsights, runAnalyticsInsights } from "./insights";
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

async function seedLlmUsage(
  model: string,
  latencyMs: number,
  tokens: { p: number; c: number },
  trigger?: { actor?: string; correlationId?: string; feature?: string; action?: string },
) {
  const traceId = crypto.randomUUID();
  await ctx.db.insert(traces).values({
    id: traceId,
    feature: trigger?.feature ?? "bot-messaging",
    action: trigger?.action ?? "reply",
    status: "success",
    triggerKind: "telegram",
    triggerActor: trigger?.actor ?? null,
    correlationId: trigger?.correlationId ?? null,
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
        '{"moodScore":70,"moodLabel":"positive","moodSummary":"good chat","topTopic":"weekend","word":"weekend"}'
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

describe("getMetricTotals / getSeries (live SQL aggregation)", () => {
  it("aggregates message and token totals", async () => {
    const now = new Date();
    await seedMessage({ chatId: "c1", telegramMessageId: 1, role: "user", userId: "u1", content: "hello", sentAt: now });
    await seedMessage({ chatId: "c1", telegramMessageId: 2, role: "assistant", content: "hi there", sentAt: now });
    await seedMessage({ chatId: "c1", telegramMessageId: 3, role: "user", userId: "u2", content: "yo", sentAt: now });

    await seedLlmUsage("docker.io/ai/gemma3:12b", 1000, { p: 100, c: 50 });
    await seedLlmUsage("gemma3:12b", 3000, { p: 200, c: 150 });

    const m = await getMetricTotals({ granularity: "day" }, ctx.db);

    expect(m.totals.humanMessages).toBe(2);
    expect(m.totals.botMessages).toBe(1);
    expect(m.totals.activeUsers).toBe(2);
    expect(m.totals.tokensProcessed).toBe(300);
    expect(m.totals.tokensGenerated).toBe(200);
  });

  it("returns a dense series aligned to the bucket axis", async () => {
    const now = new Date();
    await seedMessage({ chatId: "c1", telegramMessageId: 1, role: "user", userId: "u1", content: "hello", sentAt: now });
    await seedMessage({ chatId: "c1", telegramMessageId: 2, role: "assistant", content: "hi", sentAt: now });

    const s = await getSeries({ granularity: "day", section: "volume" }, ctx.db);
    const human = s.series.find((x) => x.name === "From users");
    expect(human?.data.length).toBe(s.buckets.length);
    expect(human?.data.reduce((a: number, b) => a + (b ?? 0), 0)).toBe(1);
  });

  it("scopes tokens and messages to one chat via correlation id", async () => {
    const now = new Date();
    await seedMessage({ chatId: "c1", telegramMessageId: 1, role: "user", userId: "u1", content: "a", sentAt: now });
    await seedMessage({ chatId: "c2", telegramMessageId: 1, role: "user", userId: "u1", content: "bb", sentAt: now });
    await seedLlmUsage("m", 1000, { p: 40, c: 10 }, { actor: "u1", correlationId: "c1:1" });
    await seedLlmUsage("m", 1000, { p: 99, c: 99 }, { actor: "u1", correlationId: "c2:1" });

    const m = await getMetricTotals({ granularity: "day", chatId: "c1" }, ctx.db);
    expect(m.scope).toBe("chat");
    expect(m.totals.humanMessages).toBe(1);
    expect(m.totals.tokensProcessed).toBe(40);
    expect(m.totals.tokensGenerated).toBe(10);
  });

  it("supports the year granularity", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "hello",
      sentAt: new Date(),
    });
    const s = await getSeries({ granularity: "year", section: "volume" }, ctx.db);
    expect(s.granularity).toBe("year");
    // Year buckets are bare 4-digit years, matching the Postgres to_char format.
    expect(s.buckets.every((b) => /^\d{4}$/.test(b))).toBe(true);
    expect(s.buckets).toContain(String(new Date().getUTCFullYear()));
  });
});

describe("getSystemStats", () => {
  it("groups model usage by request type, with percentiles", async () => {
    // One model doing two different jobs: a fast reply and a slow image description.
    await seedLlmUsage("docker.io/ai/gemma3:12b", 1000, { p: 100, c: 50 });
    await seedLlmUsage("gemma3:12b", 3000, { p: 200, c: 150 });
    await seedLlmUsage("gemma3:12b", 20_000, { p: 10, c: 5 }, { feature: "vision", action: "describe" });

    const stats = await getSystemStats(ctx.db);

    // Registry-prefixed variants merge into one clean model name.
    expect(stats.models).toHaveLength(1);
    const model = stats.models[0];
    expect(model.model).toBe("gemma3:12b");
    expect(model.calls).toBe(3);
    expect(model.totalTokens).toBe(150 + 350 + 15);

    // The request types are separated, so the 20s vision call never drags the
    // reply average up with it.
    const byType = Object.fromEntries(model.requestTypes.map((r) => [`${r.feature}:${r.action}`, r]));
    expect(byType["bot-messaging:reply"].calls).toBe(2);
    expect(byType["bot-messaging:reply"].avgLatencyMs).toBe(2000);
    expect(byType["bot-messaging:reply"].latencyP50).toBe(2000);
    expect(byType["vision:describe"].calls).toBe(1);
    expect(byType["vision:describe"].avgLatencyMs).toBe(20_000);
  });

  it("measures avg reply latency from reply calls only", async () => {
    await seedLlmUsage("m", 1000, { p: 1, c: 1 });
    await seedLlmUsage("m", 60_000, { p: 1, c: 1 }, { feature: "vision", action: "describe" });

    const stats = await getSystemStats(ctx.db);
    // The minute-long image description is not a reply anyone waited on.
    expect(stats.health.avgReplyLatencyMs).toBe(1000);
  });

  it("reports no health score — the signals stand on their own", async () => {
    const stats = await getSystemStats(ctx.db);
    expect(stats.health).not.toHaveProperty("score");
    expect(stats.health.satisfaction).toBeNull();
    expect(stats.health.errorRate).toBeNull();
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
    // day + week + month + year + all, each for global + chat scope = 10 roll-ups.
    expect(result.periodsComputed).toBe(10);

    const globalAll = await getPeriodInsight(ctx.db, {
      granularity: "all",
      bucket: "all",
      scope: "global",
      chatId: "",
    });
    expect(globalAll?.wordOfPeriod).toBe("weekend");
    expect(globalAll?.moodScore).toBe(70);

    // The year roll-up exists alongside the others.
    const globalYear = await getPeriodInsight(ctx.db, {
      granularity: "year",
      bucket: "2026",
      scope: "global",
      chatId: "",
    });
    expect(globalYear?.moodScore).toBe(70);

    // The "word of the day" exists too (a single-day roll-up copies the scored word).
    const globalDay = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-07-14",
      scope: "global",
      chatId: "",
    });
    expect(globalDay?.wordOfPeriod).toBe("weekend");

    const runTraces = await listTraces(ctx.db, { feature: "analytics-insights" });
    expect(runTraces.traces).toHaveLength(1);
    expect(runTraces.traces[0].status).toBe("success");
  });

  it("counts source days as calendar days, not chat-day rows", async () => {
    // Two chats active on the same day. The global day roll-up reads one row per
    // chat, but that is still one day — counting rows reported "2 days".
    await seedFinishedDay("c1", 1);
    await seedFinishedDay("c2", 10);

    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const globalDay = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-07-14",
      scope: "global",
      chatId: "",
    });
    expect(globalDay?.sourceDays).toBe(1);
    // Both chats' messages are still counted.
    expect(globalDay?.messageCount).toBe(4);
  });

  it("is idempotent — an unchanged day is not recomputed", async () => {
    await seedFinishedDay();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const again = await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });
    expect(again.daysComputed).toBe(0);
    expect(again.summary).toContain("nothing to compute");
  });

  it("does not re-score a scored day when its message count changes", async () => {
    await seedFinishedDay();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    // A late message lands on an already-scored day. The old job noticed the count
    // drift and silently re-read the day; a scored day is now final until an
    // operator asks for it again.
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 99,
      role: "user",
      userId: "u1",
      content: "one more thing",
      sentAt: new Date("2026-07-14T20:00:00Z"),
    });
    const again = await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });
    expect(again.daysComputed).toBe(0);
    expect(again.summary).toContain("nothing to compute");
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

describe("regenerateAnalyticsInsights", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");

  async function seedDay(date: string, chatId = "c1", id = 1) {
    await seedMessage({
      chatId,
      telegramMessageId: id,
      role: "user",
      userId: "u1",
      content: "planning the weekend trip",
      sentAt: new Date(`${date}T09:00:00Z`),
    });
  }

  it("drops a day's insights and computes them again", async () => {
    await seedDay("2026-07-14");
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    // The day is re-scored with a different mood, proving it was really re-read
    // rather than left alone as an already-scored day.
    const result = await regenerateAnalyticsInsights(
      {
        complete: stubComplete({
          day: '{"moodScore":20,"moodLabel":"negative","moodSummary":"bad","topTopic":"delays","word":"delays"}',
        }),
        timeZone: "UTC",
        now: NOW,
        db: ctx.db,
      },
      { granularity: "day", bucket: "2026-07-14" },
    );

    expect(result.daysComputed).toBe(1);
    const day = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-07-14",
      scope: "global",
      chatId: "",
    });
    expect(day?.moodScore).toBe(20);
    expect(day?.wordOfPeriod).toBe("delays");
  });

  it("rebuilds the wider roll-ups that contained the dropped day", async () => {
    await seedDay("2026-07-14");
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    await regenerateAnalyticsInsights(
      {
        complete: stubComplete({
          day: '{"moodScore":20,"moodLabel":"negative","moodSummary":"bad","topTopic":"delays","word":"delays"}',
        }),
        timeZone: "UTC",
        now: NOW,
        db: ctx.db,
      },
      { granularity: "day", bucket: "2026-07-14" },
    );

    // The month and all-time roll-ups covered that day, so they cannot keep the old
    // score — they are dropped and rebuilt from the new one.
    for (const [granularity, bucket] of [
      ["month", "2026-07"],
      ["year", "2026"],
      ["all", "all"],
    ] as const) {
      const row = await getPeriodInsight(ctx.db, { granularity, bucket, scope: "global", chatId: "" });
      expect(row?.moodScore, `${granularity} ${bucket}`).toBe(20);
    }
  });

  it("leaves days outside the dropped period untouched", async () => {
    await seedDay("2026-06-10", "c1", 1);
    await seedDay("2026-07-14", "c1", 2);
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const result = await regenerateAnalyticsInsights(
      {
        complete: stubComplete({
          day: '{"moodScore":20,"moodLabel":"negative","moodSummary":"bad","topTopic":"delays","word":"delays"}',
        }),
        timeZone: "UTC",
        now: NOW,
        db: ctx.db,
      },
      { granularity: "month", bucket: "2026-07" },
    );

    // Only July's day was dropped, so only it was re-scored.
    expect(result.daysComputed).toBe(1);
    const june = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-06-10",
      scope: "global",
      chatId: "",
    });
    expect(june?.moodScore).toBe(70);
  });

  it("all/all re-scores the whole history", async () => {
    await seedDay("2026-06-10", "c1", 1);
    await seedDay("2026-07-14", "c1", 2);
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const result = await regenerateAnalyticsInsights(
      { complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db },
      { granularity: "all", bucket: "all" },
    );
    expect(result.daysComputed).toBe(2);
  });
});
