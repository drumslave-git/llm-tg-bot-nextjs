import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertKnownUser } from "@/features/known-users/server/repository";
import { startTrace } from "@/server/trace";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";
import {
  applyMessageEdit,
  getChatHistory,
  getConversationWindow,
  getHistoryOverview,
  recordAssistantMessage,
  recordIncomingMessage,
} from "./service";

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

const trigger = { kind: "telegram" } as const;

const TODAY = new Date("2026-07-12T12:00:00.000Z");
const EARLIER_TODAY = new Date("2026-07-12T09:00:00.000Z");
const YESTERDAY = new Date("2026-07-11T23:00:00.000Z");

describe("recordIncomingMessage", () => {
  it("stores a message and is idempotent on (chatId, telegramMessageId)", async () => {
    const first = await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "hello", sentAt: TODAY },
      ctx.db,
    );
    expect(first).toMatchObject({ chatId: "5", telegramMessageId: 1, role: "user", content: "hello" });

    // Re-delivery of the same message does not duplicate the row.
    const dup = await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "hello", sentAt: TODAY },
      ctx.db,
    );
    expect(dup).toBeNull();
    expect(await getChatHistory("5", ctx.db)).toHaveLength(1);
  });

  it("ignores an empty message rather than storing a blank row", async () => {
    const out = await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "   ", sentAt: TODAY },
      ctx.db,
    );
    expect(out).toBeNull();
    expect(await getChatHistory("5", ctx.db)).toHaveLength(0);
  });
});

describe("getChatHistory", () => {
  it("returns the chat's messages newest first (detail view order)", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "first", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 2, content: "second", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 3, userId: "100", content: "third", sentAt: TODAY },
      ctx.db,
    );

    const messages = await getChatHistory("5", ctx.db);
    expect(messages.map((m) => m.content)).toEqual(["third", "second", "first"]);
  });
});

describe("getChatHistory trace links", () => {
  it("links a user message and its reply to the trace that handled the turn", async () => {
    // A reply trace correlates to the incoming message: `${chatId}:${messageId}`.
    const trace = await startTrace(
      {
        feature: "bot-messaging",
        action: "reply",
        trigger: { kind: "telegram", correlationId: "5:1" },
        inputSummary: "hi",
      },
      ctx.db,
    );
    await trace.succeed({ outputSummary: "hello" });

    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "hi", sentAt: TODAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 2, content: "hello", replyToMessageId: 1, sentAt: TODAY },
      ctx.db,
    );
    // A later, un-addressed message with no trace.
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 3, userId: "100", content: "no trace", sentAt: TODAY },
      ctx.db,
    );

    const messages = await getChatHistory("5", ctx.db);
    const byMsg = (id: number) => messages.find((m) => m.telegramMessageId === id)!;
    // Both the user turn and its reply resolve to the same handling trace.
    expect(byMsg(1).traceId).toBe(trace.id);
    expect(byMsg(2).traceId).toBe(trace.id);
    // The un-addressed message has no trace.
    expect(byMsg(3).traceId).toBeNull();
  });
});

describe("getConversationWindow", () => {
  it("returns only the current day's messages, oldest first, excluding the current turn", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "yesterday", sentAt: YESTERDAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "earlier today", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 3, content: "a reply", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 4, userId: "100", content: "current", sentAt: TODAY },
      ctx.db,
    );

    const window = await getConversationWindow(
      { chatId: "5", isGroup: false, excludeTelegramMessageId: 4, now: TODAY },
      ctx.db,
    );
    expect(window.count).toBe(2);
    expect(window.messages).toEqual([
      { role: "user", content: "earlier today" },
      { role: "assistant", content: "a reply" },
    ]);
  });

  it("prefixes group user turns with the known-user label", async () => {
    await upsertKnownUser(ctx.db, {
      userId: "100",
      username: "alice",
      firstName: "Alice",
      lastName: null,
    });
    await recordIncomingMessage(
      { chatId: "-100", telegramMessageId: 1, userId: "100", content: "hi all", sentAt: EARLIER_TODAY },
      ctx.db,
    );

    const window = await getConversationWindow(
      { chatId: "-100", isGroup: true, now: TODAY },
      ctx.db,
    );
    expect(window.messages).toEqual([{ role: "user", content: "Alice (@alice): hi all" }]);
  });
});

describe("applyMessageEdit", () => {
  it("rewrites a stored message and records a success trace", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "typo", sentAt: TODAY },
      ctx.db,
    );
    const updated = await applyMessageEdit(
      { chatId: "5", telegramMessageId: 1, content: "fixed", editedAt: TODAY },
      trigger,
      ctx.db,
    );
    expect(updated).toMatchObject({ content: "fixed" });
    expect(updated?.editedAt).not.toBeNull();

    const stored = await getChatHistory("5", ctx.db);
    expect(stored[0].content).toBe("fixed");

    const { traces } = await listTraces(ctx.db, { feature: "history" });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "edit", status: "success" });
  });

  it("skips (not fails) when the edited message was never stored", async () => {
    const out = await applyMessageEdit(
      { chatId: "5", telegramMessageId: 999, content: "ghost", editedAt: TODAY },
      trigger,
      ctx.db,
    );
    expect(out).toBeNull();
    const { traces } = await listTraces(ctx.db, { feature: "history" });
    expect(traces[0]).toMatchObject({ action: "edit", status: "skipped" });
  });
});

describe("getHistoryOverview", () => {
  it("summarizes each chat with a count and last activity, most-recent first", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "one", sentAt: YESTERDAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "two", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "9", telegramMessageId: 1, userId: "200", content: "solo", sentAt: TODAY },
      ctx.db,
    );

    const overview = await getHistoryOverview(ctx.db);
    expect(overview).toHaveLength(2);
    // Chat 9's last activity (TODAY) is more recent than chat 5's (EARLIER_TODAY).
    expect(overview[0]).toMatchObject({ chatId: "9", messageCount: 1 });
    expect(overview[1]).toMatchObject({ chatId: "5", messageCount: 2 });
  });
});
