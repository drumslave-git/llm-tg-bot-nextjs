import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getChatMessagesInRange } from "@/features/history/server/repository";
import { recordAssistantMessage } from "@/features/history/server/service";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { MAX_ONE_SHOT_ATTEMPTS } from "../types";
import { getScheduledTasks } from "./service";
import { createScheduledTaskService, editScheduledTaskService } from "./service";
import { runDueScheduledTasks } from "./scheduler";

/**
 * End-to-end fire path with **no bot and no live LLM** — the whole scheduler tick
 * (due scan → fire → deliver → mirror → advance) driven against a real Postgres
 * with a capturing reply sink and a deterministic generator, the same simulation
 * approach as the message-flow tests. Proves delivery, history mirroring, wording
 * variation, trace recording, and schedule advancement without any credentials.
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

const trigger = { kind: "dashboard" } as const;

/** A deterministic generator returning fixed content. */
function generator(content: string): () => Promise<ChatCompletionResult> {
  return async () => ({
    content,
    model: "test-model",
    usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 },
    latencyMs: 2,
    requestBody: {},
    responseBody: { content },
  });
}

/** A capturing reply sink (the bot, simulated). */
function captureSink() {
  const sent: { chatId: string; text: string }[] = [];
  let id = 1000;
  return {
    sent,
    send: async (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { messageId: (id += 1) };
    },
  };
}

/** Mirror into the test DB (the real history writer, explicit db). */
const recordReply = (input: { chatId: string; telegramMessageId: number; content: string }) =>
  recordAssistantMessage({ ...input, replyToMessageId: null }, ctx.db).then(() => undefined);

function tomorrowIso(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

describe("runDueScheduledTasks (simulated fire — no bot, no live LLM)", () => {
  it("fires a due daily task: delivers, mirrors to history, varies wording, traces, and advances", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "get everyone to stand up", scheduleKind: "daily", timeOfDay: "09:00", createdByUserId: "100" },
      trigger,
      ctx.db,
    );
    // Ask "from just after it's due" so the task is picked up and advanced correctly.
    const now = new Date(new Date(task.nextRunAt!).getTime() + 60_000);
    const sink = captureSink();

    const res = await runDueScheduledTasks({
      db: ctx.db,
      now,
      timezone: "UTC",
      personalityPrompt: null,
      complete: generator("Alright everyone, on your feet!"),
      send: sink.send,
      recordReply,
    });

    expect(res).toEqual({ fired: 1, failed: 0 });
    // Delivered to the task's chat with the generated text.
    expect(sink.sent).toEqual([{ chatId: "555", text: "Alright everyone, on your feet!" }]);

    // Mirrored into history as an assistant message.
    const mirror = await getChatMessagesInRange(ctx.db, "555", new Date(0), new Date(now.getTime() + 1000));
    expect(mirror).toHaveLength(1);
    expect(mirror[0]).toMatchObject({ role: "assistant", content: "Alright everyone, on your feet!" });

    // Advanced: still enabled, next run in the future, delivery recorded for variation.
    const [after] = await getScheduledTasks("555", ctx.db);
    expect(after.enabled).toBe(true);
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    expect(after.recentDeliveries).toEqual(["Alright everyone, on your feet!"]);

    // A fire trace was recorded.
    const traces = await listTraces({ feature: "scheduled-tasks" });
    expect(traces.traces.some((t) => t.action === "fire" && t.status === "success")).toBe(true);
  });

  it("feeds recent deliveries back so a second fire is told to vary", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "remind to hydrate", scheduleKind: "daily", timeOfDay: "09:00" },
      trigger,
      ctx.db,
    );
    const sink = captureSink();
    let captured: string | null = null;
    const complete = async (messages: ChatMessage[]) => {
      const user = messages.find((m) => m.role === "user");
      captured = typeof user?.content === "string" ? user.content : null;
      return generator("Drink some water!")();
    };

    // First fire.
    await runDueScheduledTasks({
      db: ctx.db,
      now: new Date(new Date(task.nextRunAt!).getTime() + 60_000),
      timezone: "UTC",
      personalityPrompt: null,
      complete: generator("Drink some water!"),
      send: sink.send,
      recordReply,
    });
    // Second fire — the directive message must now carry the first delivery.
    const [afterFirst] = await getScheduledTasks("555", ctx.db);
    await runDueScheduledTasks({
      db: ctx.db,
      now: new Date(new Date(afterFirst.nextRunAt!).getTime() + 60_000),
      timezone: "UTC",
      personalityPrompt: null,
      complete,
      send: sink.send,
      recordReply,
    });
    expect(captured).toContain("delivered this recurring task before");
    expect(captured).toContain("Drink some water!");
  });

  it("a due one-shot fires once, then deletes itself", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "one-time ping", scheduleKind: "once", timeOfDay: "09:00", runDate: tomorrowIso() },
      trigger,
      ctx.db,
    );
    const sink = captureSink();
    await runDueScheduledTasks({
      db: ctx.db,
      now: new Date(new Date(task.nextRunAt!).getTime() + 60_000),
      timezone: "UTC",
      personalityPrompt: null,
      complete: generator("Here's your one-time ping."),
      send: sink.send,
      recordReply,
    });
    expect(sink.sent).toHaveLength(1);
    // Spent: the row is gone, not left behind disabled.
    expect(await getScheduledTasks("555", ctx.db)).toEqual([]);
    // The delivery is still on the record, in the fire trace.
    const traces = await listTraces({ feature: "scheduled-tasks" });
    expect(traces.traces.some((t) => t.action === "fire" && t.status === "success")).toBe(true);
  });

  it("keeps a failed one-shot due with an attempt recorded, and a later tick delivers it", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "one-time ping", scheduleKind: "once", timeOfDay: "09:00", runDate: tomorrowIso() },
      trigger,
      ctx.db,
    );
    const now = new Date(new Date(task.nextRunAt!).getTime() + 60_000);
    const sink = captureSink();
    const failingRun = () =>
      runDueScheduledTasks({
        db: ctx.db,
        now,
        timezone: "UTC",
        personalityPrompt: null,
        complete: async () => {
          throw new Error("LLM unreachable");
        },
        send: sink.send,
        recordReply,
      });

    expect(await failingRun()).toEqual({ fired: 0, failed: 1 });
    // Not deleted (the old behavior silently ate the reminder): still enabled,
    // still due at the same instant, with the failed attempt on the record.
    const [after] = await getScheduledTasks("555", ctx.db);
    expect(after.enabled).toBe(true);
    expect(after.attempts).toBe(1);
    expect(after.nextRunAt).toBe(task.nextRunAt);

    // The outage ends; the next tick delivers, and the spent one-shot is deleted.
    const res = await runDueScheduledTasks({
      db: ctx.db,
      now,
      timezone: "UTC",
      personalityPrompt: null,
      complete: generator("Here's your one-time ping."),
      send: sink.send,
      recordReply,
    });
    expect(res).toEqual({ fired: 1, failed: 0 });
    expect(sink.sent).toHaveLength(1);
    expect(await getScheduledTasks("555", ctx.db)).toEqual([]);
  });

  it("disables a one-shot after the attempts cap — kept and badged, never deleted", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "doomed ping", scheduleKind: "once", timeOfDay: "09:00", runDate: tomorrowIso() },
      trigger,
      ctx.db,
    );
    const now = new Date(new Date(task.nextRunAt!).getTime() + 60_000);
    const sink = captureSink();
    const failingRun = () =>
      runDueScheduledTasks({
        db: ctx.db,
        now,
        timezone: "UTC",
        personalityPrompt: null,
        complete: async () => {
          throw new Error("LLM unreachable");
        },
        send: sink.send,
        recordReply,
      });

    for (let i = 1; i < MAX_ONE_SHOT_ATTEMPTS; i += 1) {
      expect(await failingRun()).toEqual({ fired: 0, failed: 1 });
    }
    // Still in the game one tick before the cap.
    let [row] = await getScheduledTasks("555", ctx.db);
    expect(row.enabled).toBe(true);
    expect(row.attempts).toBe(MAX_ONE_SHOT_ATTEMPTS - 1);

    // The capping failure disables — the row survives to explain itself.
    expect(await failingRun()).toEqual({ fired: 0, failed: 1 });
    [row] = await getScheduledTasks("555", ctx.db);
    expect(row.enabled).toBe(false);
    expect(row.attempts).toBe(MAX_ONE_SHOT_ATTEMPTS);

    // Disabled means no longer scanned: a further tick fires nothing.
    expect(await failingRun()).toEqual({ fired: 0, failed: 0 });
    expect(sink.sent).toEqual([]);
    const traces = await listTraces({ feature: "scheduled-tasks" });
    expect(traces.traces.some((t) => t.action === "fire" && t.status !== "success")).toBe(true);
  });

  it("an operator edit restores a failed one-shot's full retry budget", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "flaky ping", scheduleKind: "once", timeOfDay: "09:00", runDate: tomorrowIso() },
      trigger,
      ctx.db,
    );
    await runDueScheduledTasks({
      db: ctx.db,
      now: new Date(new Date(task.nextRunAt!).getTime() + 60_000),
      timezone: "UTC",
      personalityPrompt: null,
      complete: async () => {
        throw new Error("LLM unreachable");
      },
      send: captureSink().send,
      recordReply,
    });
    expect((await getScheduledTasks("555", ctx.db))[0].attempts).toBe(1);

    await editScheduledTaskService(task.id, { enabled: true }, trigger, ctx.db);
    expect((await getScheduledTasks("555", ctx.db))[0].attempts).toBe(0);
  });

  it("does not deliver empty model output but still advances the schedule", async () => {
    const task = await createScheduledTaskService(
      { chatId: "555", instruction: "maybe nothing", scheduleKind: "daily", timeOfDay: "09:00" },
      trigger,
      ctx.db,
    );
    const now = new Date(new Date(task.nextRunAt!).getTime() + 60_000);
    const sink = captureSink();
    const res = await runDueScheduledTasks({
      db: ctx.db,
      now,
      timezone: "UTC",
      personalityPrompt: null,
      complete: generator("   …   "), // strips to nothing
      send: sink.send,
      recordReply,
    });
    expect(res).toEqual({ fired: 0, failed: 1 });
    expect(sink.sent).toHaveLength(0);
    const [after] = await getScheduledTasks("555", ctx.db);
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    expect(after.recentDeliveries).toEqual([]); // nothing delivered → no variation sample
  });

  it("fires nothing when no task is due", async () => {
    await createScheduledTaskService(
      { chatId: "555", instruction: "future only", scheduleKind: "daily", timeOfDay: "09:00" },
      trigger,
      ctx.db,
    );
    const sink = captureSink();
    // "now" is well before the next run, so nothing is due.
    const res = await runDueScheduledTasks({
      db: ctx.db,
      now: new Date("2020-01-01T00:00:00Z"),
      timezone: "UTC",
      personalityPrompt: null,
      complete: generator("should not be called"),
      send: sink.send,
      recordReply,
    });
    expect(res).toEqual({ fired: 0, failed: 0 });
    expect(sink.sent).toHaveLength(0);
  });
});
