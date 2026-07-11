import type { Message } from "@grammyjs/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the policy from persistence: a no-op trace recorder and a stub db.
// `vi.hoisted` runs before the hoisted vi.mock factory below.
const recorder = vi.hoisted(() => ({
  id: "t1",
  event: vi.fn().mockResolvedValue(undefined),
  succeed: vi.fn().mockResolvedValue(undefined),
  skip: vi.fn().mockResolvedValue(undefined),
  fail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/trace", () => ({ startTrace: vi.fn().mockResolvedValue(recorder) }));
vi.mock("@/db/drizzle", () => ({ getDb: () => ({}) }));

import { startTrace } from "@/server/trace";
import { handleIncomingMessage, type BotMessagingDeps, type IncomingMessage } from "./service";

const BOT = { id: 42, username: "MyBot" };

function incoming(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    message: { message_id: 7, date: 0, chat: { id: 5, type: "private" } } as Message,
    chatId: 5,
    chatType: "private",
    messageId: 7,
    fromId: 100,
    fromIsBot: false,
    text: "hello",
    ...partial,
  };
}

function deps(over: Partial<BotMessagingDeps> = {}): BotMessagingDeps {
  return {
    bot: BOT,
    generateReply: vi.fn().mockResolvedValue({ content: "hi back", model: "m", latencyMs: 5 }),
    sendReply: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("handleIncomingMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores messages from other bots without tracing or generating", async () => {
    const d = deps();
    const out = await handleIncomingMessage(incoming({ fromIsBot: true }), d);
    expect(out).toEqual({ status: "ignored", reason: "from_bot" });
    expect(startTrace).not.toHaveBeenCalled();
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("ignores empty messages", async () => {
    const d = deps();
    const out = await handleIncomingMessage(incoming({ text: "   " }), d);
    expect(out).toEqual({ status: "ignored", reason: "no_content" });
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("ignores un-addressed group chatter without tracing", async () => {
    const d = deps();
    const m = { message_id: 7, date: 0, chat: { id: 5, type: "group" }, text: "chatter" } as Message;
    const out = await handleIncomingMessage(
      incoming({ message: m, chatType: "group", text: "chatter" }),
      d,
    );
    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(startTrace).not.toHaveBeenCalled();
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("generates and delivers a reply for an addressed message, and traces it", async () => {
    const d = deps();
    const out = await handleIncomingMessage(incoming({ text: "hello there" }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    // system + user turns
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "hello there" });
    expect(d.sendReply).toHaveBeenCalledWith("hi back");
    expect(recorder.succeed).toHaveBeenCalledOnce();
  });

  it("fails the trace and sends a fallback reply when generation throws", async () => {
    const d = deps({ generateReply: vi.fn().mockRejectedValue(new Error("provider down")) });
    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out).toEqual({ status: "error", message: "provider down" });
    expect(recorder.fail).toHaveBeenCalledOnce();
    expect(d.sendReply).toHaveBeenCalledOnce();
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/couldn't generate/i);
  });
});
