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
import { BASE_SYSTEM_PROMPT } from "./prompt";
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

const stopTyping = vi.fn();

const OPEN_POLICY = { ownerUserId: null, maintenanceModeEnabled: false } as const;

function deps(over: Partial<BotMessagingDeps> = {}): BotMessagingDeps {
  return {
    bot: BOT,
    policy: OPEN_POLICY,
    generateReply: vi.fn().mockResolvedValue({ content: "hi back", model: "m", latencyMs: 5 }),
    sendReply: vi.fn().mockResolvedValue({ messageId: 99 }),
    loadHistory: vi.fn().mockResolvedValue({ messages: [], count: 0 }),
    recordReply: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockReturnValue(stopTyping),
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
    expect(d.startTyping).not.toHaveBeenCalled();
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
    expect(d.startTyping).not.toHaveBeenCalled();
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
    // The delivered reply is mirrored into history, threaded to the triggering msg.
    expect(d.recordReply).toHaveBeenCalledWith({
      content: "hi back",
      telegramMessageId: 99,
      replyToMessageId: 7,
    });
    // Typing shown while generating, then stopped once the turn settles.
    expect(d.startTyping).toHaveBeenCalledOnce();
    expect(stopTyping).toHaveBeenCalledOnce();
  });

  it("injects the loaded history window as prior turns between system and current", async () => {
    const priorTurns = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const d = deps({
      loadHistory: vi.fn().mockResolvedValue({ messages: priorTurns, count: 2 }),
    });
    await handleIncomingMessage(incoming({ text: "follow up" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1]).toEqual(priorTurns[0]);
    expect(messages[2]).toEqual(priorTurns[1]);
    expect(messages[3]).toEqual({ role: "user", content: "follow up" });
    // The window size is recorded as a step.
    const loaded = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "history window loaded");
    expect(loaded.data).toEqual({ messageCount: 2 });
  });

  it("injects group context as a system message after the base prompt (groups only)", async () => {
    const priorTurns = [{ role: "user", content: "Ann: earlier" }];
    const d = deps({
      loadGroupContext: vi
        .fn()
        .mockResolvedValue({ content: "Known participants:\n- Ann", memberCount: 1 }),
      loadHistory: vi.fn().mockResolvedValue({ messages: priorTurns, count: 1 }),
    });
    await handleIncomingMessage(incoming({ text: "who is ann?" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, group-context system message, prior turn, current message.
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "system",
      "user",
      "user",
    ]);
    expect(messages[1]).toEqual({ role: "system", content: "Known participants:\n- Ann" });
    expect(messages[2]).toEqual(priorTurns[0]);
    expect(messages[3]).toEqual({ role: "user", content: "who is ann?" });

    // The roster size is recorded as a step, between system prompt and history.
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "group context loaded",
      "history window loaded",
      "request",
      "response",
      "send message",
    ]);
    const loaded = events.find((e) => e.message === "group context loaded");
    expect(loaded.data).toEqual({ memberCount: 1 });
  });

  it("omits the group-context step when the loader resolves null", async () => {
    const d = deps({ loadGroupContext: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // No extra system message when there is nothing to inject.
    expect(messages).toHaveLength(2);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "group context loaded")).toBe(false);
  });

  it("uses the base system prompt when no personality is configured", async () => {
    const d = deps();
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0]).toEqual({ role: "system", content: BASE_SYSTEM_PROMPT });
    const composed = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(composed.data.personalityApplied).toBe(false);
    expect(composed.data.systemPrompt).toBe(BASE_SYSTEM_PROMPT);
  });

  it("appends the configured personality prompt to the system prompt", async () => {
    const persona = "You are a laconic pirate.";
    const d = deps({ personalityPrompt: persona });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(BASE_SYSTEM_PROMPT);
    expect(messages[0].content).toContain("Additional instructions:");
    expect(messages[0].content).toContain(persona);
    const composed = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(composed.data.personalityApplied).toBe(true);
    expect(composed.data.systemPrompt).toBe(messages[0].content);
  });

  it("records the full untrimmed message, request, and raw response bodies", async () => {
    const longText = "x".repeat(500);
    const reply = "y".repeat(300);
    const responseBody = { id: "cmpl-1", choices: [{ message: { content: reply } }] };
    const d = deps({
      generateReply: vi
        .fn()
        .mockResolvedValue({ content: reply, model: "m", latencyMs: 5, responseBody }),
    });
    await handleIncomingMessage(incoming({ text: longText }), d);

    // The trace input is the whole message, never trimmed.
    const startInput = (startTrace as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(startInput.inputSummary).toBe(longText);

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const byMessage = (message: string) => events.find((e) => e.message === message);

    // Fixed flow: addressing → system prompt → history → request → response → send.
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "history window loaded",
      "request",
      "response",
      "send message",
    ]);
    // Addressing check is a passed check (green).
    expect(byMessage("addressing check").level).toBe("success");
    expect(byMessage("addressing check").data).toEqual({ addressed: true, reason: "private" });
    // Request body carries the full messages payload.
    expect(byMessage("request").data.messages[1]).toEqual({ role: "user", content: longText });
    // Response step records the raw provider body verbatim.
    expect(byMessage("response").data).toEqual(responseBody);
    // Delivered message carries the full content.
    expect(byMessage("send message").data.content).toBe(reply);
  });

  it("records tool calls reported by the generator as external_call events on the reply trace", async () => {
    // A generator that runs one tool before answering, via the onToolCall sink.
    const d = deps({
      generateReply: vi.fn().mockImplementation(async (_messages, onToolCall) => {
        await onToolCall?.({
          name: "history_search",
          args: { query: "pizza" },
          result: { text: "found 2 messages" },
          ok: true,
        });
        return { content: "here you go", model: "m", latencyMs: 5 };
      }),
    });
    const out = await handleIncomingMessage(incoming({ text: "what did we say about pizza?" }), d);
    expect(out).toEqual({ status: "replied", text: "here you go" });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    // The tool call lands between the request and the response.
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "history window loaded",
      "request",
      "tool: history_search",
      "response",
      "send message",
    ]);
    const toolEvent = events.find((e) => e.message === "tool: history_search");
    expect(toolEvent.type).toBe("external_call");
    expect(toolEvent.data).toEqual({
      args: { query: "pizza" },
      result: { text: "found 2 messages" },
    });
  });

  it("blocks a non-owner in maintenance mode: sends a static notice, traces (skipped), no LLM", async () => {
    const d = deps({ policy: { ownerUserId: "1", maintenanceModeEnabled: true } });
    const out = await handleIncomingMessage(incoming({ text: "hello", fromId: 100 }), d);
    expect(out).toEqual({ status: "ignored", reason: "maintenance_mode", source: "private" });
    // Addressed-but-blocked is still traced for operator visibility, then skipped.
    expect(startTrace).toHaveBeenCalledOnce();
    expect(recorder.skip).toHaveBeenCalledOnce();
    expect(recorder.succeed).not.toHaveBeenCalled();
    // No LLM call, but a static maintenance notice is sent to the user.
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledOnce();
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/maintenance mode/i);
    expect(d.startTyping).not.toHaveBeenCalled();
    const blocked = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "maintenance mode — blocked");
    expect(blocked.data).toEqual({ reason: "not_owner" });
  });

  it("lets the owner through in maintenance mode (matched by id)", async () => {
    const d = deps({ policy: { ownerUserId: "7", maintenanceModeEnabled: true } });
    const out = await handleIncomingMessage(incoming({ text: "hi", fromId: 7 }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    expect(recorder.succeed).toHaveBeenCalledOnce();
  });

  it("keeps the owner fully functional in a group during maintenance (reply-to-bot)", async () => {
    // Reply-to-bot addressing (not a direct mention) still gets a normal reply —
    // maintenance mode imposes no extra restriction on the owner.
    const m = {
      message_id: 7,
      date: 0,
      chat: { id: 5, type: "group" },
      text: "thanks",
      reply_to_message: { message_id: 1, from: { id: BOT.id, is_bot: true } },
    } as unknown as Message;
    const d = deps({ policy: { ownerUserId: "7", maintenanceModeEnabled: true } });
    const out = await handleIncomingMessage(
      incoming({ message: m, chatType: "group", text: "thanks", fromId: 7 }),
      d,
    );
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    expect(recorder.succeed).toHaveBeenCalledOnce();
  });

  it("fails the trace and sends a fallback reply when generation throws", async () => {
    const d = deps({ generateReply: vi.fn().mockRejectedValue(new Error("provider down")) });
    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out).toEqual({ status: "error", message: "provider down" });
    expect(recorder.fail).toHaveBeenCalledOnce();
    expect(d.sendReply).toHaveBeenCalledOnce();
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/couldn't generate/i);
    // Typing is always stopped, even on the error path.
    expect(stopTyping).toHaveBeenCalledOnce();
  });
});
