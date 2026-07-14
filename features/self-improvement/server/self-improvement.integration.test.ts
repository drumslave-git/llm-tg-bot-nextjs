import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactionTypeEmoji } from "@grammyjs/types";

import { closePool } from "@/db/pool";
import { chatMessages, knownUsers, selfCorrections, usersCommunicationPreferences, usersFeedbacks } from "@/db/schema";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { startTrace } from "@/server/trace";
import { listTraces } from "@/server/trace/repository";
import { processCallbackUpdate } from "@/server/telegram/process-callback";
import { processReactionUpdate } from "@/server/telegram/process-reaction";
import type { FeedbackTransport } from "@/server/telegram/transport";
import { simulateUpdate } from "@/test/simulate";
import { startTestDb, type TestDb } from "@/test/db";

import { encodeMenuCallback, MENU_AWAITING_TEXT, OTHER_OPTION } from "../menu";
import { LIKE_OPTIONS } from "../options";
import { runSelfImprovement } from "./analyze";
import {
  completeFeedback,
  getLatestCorrection,
  getLatestPreference,
  insertCorrection,
  insertPreference,
  upsertFeedback,
} from "./repository";

/**
 * Integration coverage for the self-improvement feature against a real
 * Postgres: the reaction → menu → answer collection flows (through the real
 * transport-agnostic processors with a capturing feedback transport), the
 * free-text capture through the real message pipeline, the daily incorporation
 * run with a deterministic LLM, and the resulting prompt injection on a reply.
 */

let ctx: TestDb;
let prevDatabaseUrl: string | undefined;

beforeAll(async () => {
  ctx = await startTestDb();
  prevDatabaseUrl = process.env.DATABASE_URL;
  // The flows run through the app's own pool (`getDb()`), so bind it here.
  process.env.DATABASE_URL = ctx.connectionUri;
});

afterAll(async () => {
  stopVisionBackfill();
  await closePool();
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const CHAT_ID = "555";
const USER_ID = "100";
const USER_MSG_ID = 10;
const BOT_MSG_ID = 11;
const MENU_MSG_ID = 500;

/** Seed a known user plus one mirrored exchange (user #10 → bot reply #11). */
async function seedExchange(userId = USER_ID): Promise<void> {
  await ctx.db
    .insert(knownUsers)
    .values({ userId, username: `user${userId}`, firstName: `U${userId}` })
    .onConflictDoNothing();
  await ctx.db
    .insert(chatMessages)
    .values([
      {
        chatId: CHAT_ID,
        telegramMessageId: USER_MSG_ID,
        role: "user",
        userId,
        content: "what's the weather?",
        sentAt: new Date("2026-07-14T10:00:00Z"),
      },
      {
        chatId: CHAT_ID,
        telegramMessageId: BOT_MSG_ID,
        role: "assistant",
        content: "Sunny, 25°C.",
        replyToMessageId: USER_MSG_ID,
        sentAt: new Date("2026-07-14T10:00:05Z"),
      },
    ])
    .onConflictDoNothing();
}

/** A capturing FeedbackTransport (the simulator's sibling for menu flows). */
function fakeFeedbackTransport() {
  const sendMenu = vi.fn().mockResolvedValue({ messageId: MENU_MSG_ID });
  const editMenu = vi.fn().mockResolvedValue(undefined);
  const answerCallback = vi.fn().mockResolvedValue(undefined);
  const transport: FeedbackTransport = { sendMenu, editMenu, answerCallback };
  return { transport, sendMenu, editMenu, answerCallback };
}

/** A thumbs reaction update on the seeded bot reply. */
function reactionUpdate(emoji: ReactionTypeEmoji["emoji"], userId = Number(USER_ID)) {
  return {
    chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
    message_id: BOT_MSG_ID,
    user: { id: userId, is_bot: false, first_name: `U${userId}` },
    date: Math.floor(Date.now() / 1000),
    old_reaction: [],
    new_reaction: [{ type: "emoji" as const, emoji }],
  };
}

async function getFeedbackRow() {
  return ctx.db.query.usersFeedbacks.findFirst();
}

describe("feedback collection (reaction → menu → answer)", () => {
  it("opens a feedback row and sends the menu, resolving the clean model from the reply trace", async () => {
    await seedExchange();
    // The reply trace (keyed by the incoming message) carries the raw model id.
    const trace = await startTrace(
      {
        feature: "bot-messaging",
        action: "reply",
        trigger: { kind: "telegram", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
      },
      ctx.db,
    );
    await trace.event({
      type: "llm_response",
      message: "response",
      usage: { model: "docker.io/ai/gemma3:12b" },
    });
    await trace.succeed();

    const { transport, sendMenu } = fakeFeedbackTransport();
    const outcome = await processReactionUpdate(reactionUpdate("👍"), transport);

    expect(outcome.status).toBe("menu_sent");
    const row = await getFeedbackRow();
    expect(row).toMatchObject({
      chatId: CHAT_ID,
      telegramMessageId: BOT_MSG_ID,
      userId: USER_ID,
      reaction: "up",
      status: "pending",
      menuMessageId: MENU_MSG_ID,
      model: "gemma3:12b", // clean name — registry prefix stripped
      feedback: null,
    });
    // Menu posted as a reply to the reacted message: 5 options + Other.
    expect(sendMenu).toHaveBeenCalledOnce();
    const menu = sendMenu.mock.calls[0][0];
    expect(menu.replyToMessageId).toBe(BOT_MSG_ID);
    expect(menu.keyboard).toHaveLength(6);
    // Traced under user-feedback.
    const traces = await listTraces(ctx.db, { feature: "user-feedback" });
    expect(traces.total).toBe(1);
    expect(traces.traces[0]).toMatchObject({ status: "success", action: "menu" });
  });

  it("ignores reactions that are not a thumb, or not on a bot message", async () => {
    await seedExchange();
    const { transport, sendMenu } = fakeFeedbackTransport();

    // Not a thumb.
    expect((await processReactionUpdate(reactionUpdate("🔥"), transport)).status).toBe("ignored");
    // A thumb on the *user's* message.
    expect(
      (
        await processReactionUpdate(
          { ...reactionUpdate("👍"), message_id: USER_MSG_ID },
          transport,
        )
      ).status,
    ).toBe("ignored");
    // A thumb on a message that was never mirrored.
    expect(
      (await processReactionUpdate({ ...reactionUpdate("👍"), message_id: 999 }, transport))
        .status,
    ).toBe("ignored");

    expect(sendMenu).not.toHaveBeenCalled();
    expect(await getFeedbackRow()).toBeUndefined();
  });

  it("records a predefined option, edits the menu, and rejects presses from other users", async () => {
    await seedExchange();
    const { transport, sendMenu, editMenu, answerCallback } = fakeFeedbackTransport();
    await processReactionUpdate(reactionUpdate("👍"), transport);
    const feedbackId = (await getFeedbackRow())!.id;
    const menuMessage = {
      message_id: MENU_MSG_ID,
      date: 0,
      chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
    };

    // Someone else presses → toast only, nothing recorded.
    const foreign = await processCallbackUpdate(
      {
        id: "cb-1",
        from: { id: 200, is_bot: false, first_name: "Mallory" },
        data: encodeMenuCallback(feedbackId, 1),
        message: menuMessage,
      },
      transport,
    );
    expect(foreign.status).toBe("not_yours");
    expect(answerCallback).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("person who reacted") }),
    );
    expect((await getFeedbackRow())!.status).toBe("pending");
    expect(editMenu).not.toHaveBeenCalled();

    // The reactor picks option 1 → completed + confirmation edit.
    const pressed = await processCallbackUpdate(
      {
        id: "cb-2",
        from: { id: Number(USER_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedbackId, 1),
        message: menuMessage,
      },
      transport,
    );
    expect(pressed.status).toBe("recorded");
    expect(await getFeedbackRow()).toMatchObject({
      status: "completed",
      feedback: LIKE_OPTIONS[1],
    });
    expect(editMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: MENU_MSG_ID,
        text: `Thanks — noted: ${LIKE_OPTIONS[1]}`,
        keyboard: null,
      }),
    );
    expect(sendMenu).toHaveBeenCalledOnce(); // no second menu
  });

  it("captures the free-text answer via a reply to the menu, short-circuiting the bot reply", async () => {
    await seedExchange();
    const { transport, editMenu } = fakeFeedbackTransport();
    await processReactionUpdate(reactionUpdate("👎"), transport);
    const feedbackId = (await getFeedbackRow())!.id;

    // "Other" → awaiting a reply.
    const other = await processCallbackUpdate(
      {
        id: "cb-3",
        from: { id: Number(USER_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedbackId, OTHER_OPTION),
        message: {
          message_id: MENU_MSG_ID,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
        },
      },
      transport,
    );
    expect(other.status).toBe("awaiting_text");
    expect(editMenu).toHaveBeenCalledWith(expect.objectContaining({ text: MENU_AWAITING_TEXT }));
    expect((await getFeedbackRow())!.status).toBe("awaiting_text");

    // The reactor replies to the menu message → captured, not answered by the LLM.
    const generateReply = vi.fn();
    const res = await simulateUpdate(
      {
        text: "too sarcastic, keep it factual",
        chatId: Number(CHAT_ID),
        messageId: 12,
        from: { id: Number(USER_ID), username: "alice", firstName: "Alice" },
        replyTo: { messageId: MENU_MSG_ID },
      },
      { generateReply },
    );
    expect(res.outcome).toEqual({ status: "ignored", reason: "feedback_captured" });
    expect(generateReply).not.toHaveBeenCalled();
    // Without a menu editor the capture confirms via a plain reply.
    expect(res.replies).toEqual(["Thanks — noted: too sarcastic, keep it factual"]);
    expect(await getFeedbackRow()).toMatchObject({
      status: "completed",
      feedback: "too sarcastic, keep it factual",
    });
    // A second identical reply is NOT captured again (the row is completed).
    const res2 = await simulateUpdate(
      {
        text: "still bad",
        chatId: Number(CHAT_ID),
        messageId: 13,
        from: { id: Number(USER_ID), username: "alice", firstName: "Alice" },
        replyTo: { messageId: MENU_MSG_ID },
      },
      { generateReply: vi.fn().mockResolvedValue({ content: "ok", model: "m", latencyMs: 1 }) },
    );
    expect(res2.outcome.status).toBe("replied");
  });

  it("a repeat reaction reopens the answered row and asks again", async () => {
    await seedExchange();
    const { transport } = fakeFeedbackTransport();
    await processReactionUpdate(reactionUpdate("👍"), transport);
    const feedbackId = (await getFeedbackRow())!.id;
    await completeFeedback(ctx.db, feedbackId, "great");

    await processReactionUpdate(reactionUpdate("👎"), transport);
    const row = await getFeedbackRow();
    expect(row).toMatchObject({ id: feedbackId, reaction: "down", status: "pending", feedback: null });
  });
});

/** Deterministic fold LLM: JSON for preference folds, text for correction folds. */
function fakeFoldLlm(outputs?: { likes?: string; dislikes?: string; correction?: string }) {
  const calls: ChatMessage[][] = [];
  const complete = async (messages: ChatMessage[]): Promise<ChatCompletionResult> => {
    calls.push(messages);
    const system = String(messages[0].content);
    const content = system.includes("factual profile")
      ? JSON.stringify({
          likes: outputs?.likes ?? "short answers",
          dislikes: outputs?.dislikes ?? "rambling",
        })
      : (outputs?.correction ?? "Be more concise.");
    return {
      content,
      model: "docker.io/ai/gemma3:12b",
      latencyMs: 1,
      requestBody: { messages },
      responseBody: { content },
    };
  };
  return { complete, calls };
}

/** Seed one completed feedback for a user on the shared exchange. */
async function seedCompletedFeedback(userId: string, feedback: string) {
  await seedExchange(userId);
  const row = await upsertFeedback(ctx.db, {
    id: crypto.randomUUID(),
    chatId: CHAT_ID,
    telegramMessageId: BOT_MSG_ID,
    userId,
    reaction: "down",
    model: "gemma3:12b",
  });
  await completeFeedback(ctx.db, row.id, feedback);
  return row.id;
}

describe("daily incorporation (runSelfImprovement)", () => {
  it("folds the backlog into new preference versions per user + one correction version, stamping every feedback", async () => {
    await seedCompletedFeedback("100", "too long");
    await seedCompletedFeedback("200", "wrong tone");
    const llm = fakeFoldLlm();

    const result = await runSelfImprovement({
      complete: llm.complete,
      personalityPrompt: "You are a pirate.",
      model: "docker.io/ai/gemma3:12b",
      db: ctx.db,
    });

    expect(result).toMatchObject({
      prefsUpdated: 2,
      correctionsUpdated: true,
      incorporated: 2,
      failed: 0,
    });
    // 2 preference folds + 2 correction folds — one LLM call per feedback per pass.
    expect(llm.calls).toHaveLength(4);
    // The persona is stated once per call, never repeated per exchange.
    for (const call of llm.calls) {
      const personaMentions = call.filter((m) => String(m.content).includes("You are a pirate."));
      expect(personaMentions).toHaveLength(1);
    }
    // The exchange context reaches the fold from the history mirror.
    expect(String(llm.calls[0].at(-1)!.content)).toContain("what's the weather?");
    expect(String(llm.calls[0].at(-1)!.content)).toContain("Sunny, 25°C.");

    for (const userId of ["100", "200"]) {
      expect(await getLatestPreference(ctx.db, userId)).toMatchObject({
        version: 1,
        likes: "short answers",
        dislikes: "rambling",
        model: "gemma3:12b",
      });
    }
    expect(await getLatestCorrection(ctx.db)).toMatchObject({
      version: 1,
      correction: "Be more concise.",
      model: "gemma3:12b",
    });
    const rows = await ctx.db.select().from(usersFeedbacks);
    for (const row of rows) {
      expect(row.prefsVersion).toBe(1);
      expect(row.correctionsVersion).toBe(1);
    }
    // Traced under self-improvement with the full fold bodies.
    const traces = await listTraces(ctx.db, { feature: "self-improvement" });
    expect(traces.total).toBe(1);
    expect(traces.traces[0]).toMatchObject({ status: "success", action: "incorporate" });

    // A second run with nothing new is a silent no-op (no extra trace).
    const again = await runSelfImprovement({ complete: llm.complete, db: ctx.db });
    expect(again.summary).toBe("nothing to incorporate");
    expect((await listTraces(ctx.db, { feature: "self-improvement" })).total).toBe(1);
  });

  it("seeds the next version from the previous one", async () => {
    await seedCompletedFeedback("100", "too long");
    await runSelfImprovement({ complete: fakeFoldLlm().complete, db: ctx.db });

    // A fresh feedback arrives later (a new bot message id to satisfy uniqueness).
    await ctx.db.insert(chatMessages).values({
      chatId: CHAT_ID,
      telegramMessageId: 21,
      role: "assistant",
      content: "Another reply.",
      replyToMessageId: USER_MSG_ID,
      sentAt: new Date("2026-07-14T11:00:00Z"),
    });
    const row = await upsertFeedback(ctx.db, {
      id: crypto.randomUUID(),
      chatId: CHAT_ID,
      telegramMessageId: 21,
      userId: "100",
      reaction: "up",
      model: "gemma3:12b",
    });
    await completeFeedback(ctx.db, row.id, "loved the brevity");

    const llm = fakeFoldLlm({ likes: "brevity", dislikes: "rambling", correction: "Keep it short." });
    await runSelfImprovement({ complete: llm.complete, db: ctx.db });

    // The preference fold started from version 1's profile.
    const prefsCall = llm.calls.find((c) => String(c[0].content).includes("factual profile"))!;
    expect(String(prefsCall.at(-1)!.content)).toContain("short answers");
    expect(await getLatestPreference(ctx.db, "100")).toMatchObject({ version: 2, likes: "brevity" });
    expect(await getLatestCorrection(ctx.db)).toMatchObject({ version: 2, correction: "Keep it short." });
  });

  it("leaves a feedback unstamped for the next run when its fold call fails", async () => {
    await seedCompletedFeedback("100", "too long");
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));

    const result = await runSelfImprovement({ complete, db: ctx.db });
    expect(result.incorporated).toBe(0);
    expect(result.failed).toBeGreaterThan(0);

    const row = (await ctx.db.select().from(usersFeedbacks))[0];
    expect(row.prefsVersion).toBeNull();
    expect(row.correctionsVersion).toBeNull();
    expect(await ctx.db.select().from(usersCommunicationPreferences)).toHaveLength(0);
    expect(await ctx.db.select().from(selfCorrections)).toHaveLength(0);
    // The run trace still settles (success with failure counts in the summary).
    const traces = await listTraces(ctx.db, { feature: "self-improvement" });
    expect(traces.total).toBe(1);
  });
});

describe("prompt injection on the next reply", () => {
  it("injects the sender's latest preferences and the latest correction", async () => {
    await seedExchange();
    await insertPreference(ctx.db, {
      id: crypto.randomUUID(),
      userId: USER_ID,
      model: "gemma3:12b",
      likes: "short answers",
      dislikes: "emoji walls",
      version: 1,
    });
    await insertCorrection(ctx.db, {
      id: crypto.randomUUID(),
      model: "gemma3:12b",
      correction: "Answer in fewer words.",
      version: 1,
    });

    const seen: ChatMessage[][] = [];
    const res = await simulateUpdate(
      {
        text: "hi bot",
        chatId: Number(CHAT_ID),
        messageId: 30,
        from: { id: Number(USER_ID), username: "alice", firstName: "Alice" },
      },
      {
        generateReply: async (messages) => {
          seen.push(messages);
          return { content: "hey", model: "m", latencyMs: 1 };
        },
      },
    );

    expect(res.outcome.status).toBe("replied");
    const messages = seen[0];
    // The system prompt carries the correction block.
    expect(String(messages[0].content)).toContain("Self-correction guidelines");
    expect(String(messages[0].content)).toContain("Answer in fewer words.");
    // A system message carries the sender's preferences.
    const prefsMessage = messages.find(
      (m) => m.role === "system" && String(m.content).includes("Communication preferences"),
    );
    expect(prefsMessage).toBeDefined();
    expect(String(prefsMessage!.content)).toContain("short answers");
    expect(String(prefsMessage!.content)).toContain("emoji walls");
  });
});
