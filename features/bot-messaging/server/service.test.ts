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

import { openPolicy } from "@/test/__mocks__/policy";
import { BOT, BOT_USER, makeMessage } from "@/test/__mocks__/telegram";
import { imagePart } from "@/test/__mocks__/vision";
import { startTrace } from "@/server/trace";
import { BASE_SYSTEM_PROMPT } from "./prompt";
import { handleIncomingMessage, type BotMessagingDeps, type IncomingMessage } from "./service";

function incoming(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    message: makeMessage({ message_id: 7, chat: { id: 5, type: "private" } }),
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

const OPEN_POLICY = openPolicy;

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

  it("processes a caption-less media message (empty text but hasVision) like any other", async () => {
    const imageParts = [imagePart("ABC")];
    const d = deps({ loadVision: vi.fn().mockResolvedValue({ imageParts }) });
    const out = await handleIncomingMessage(incoming({ text: "", hasVision: true }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-1).content).toEqual([{ type: "text", text: "" }, ...imageParts]);
  });

  it("folds the recognition into the turn text when no images are attached (media-only)", async () => {
    const d = deps({
      loadVision: vi.fn().mockResolvedValue({
        imageParts: [],
        note: "The user sent a photo (no caption). Its content: a red car.",
      }),
    });
    await handleIncomingMessage(incoming({ text: "", hasVision: true }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userTurn = messages.at(-1);
    // No image parts → the turn is plain text carrying the recognition.
    expect(typeof userTurn.content).toBe("string");
    expect(userTurn.content).toContain("a red car");
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "vision media attached");
    expect(step.data).toEqual({ imageCount: 0, hasNote: true });
  });

  it("ignores un-addressed group chatter without tracing", async () => {
    const d = deps();
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text: "chatter" });
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

  it("injects the time context as a system message right before the current turn", async () => {
    const timeContext = "Current date and time: 2026-07-14 16:34 (Tuesday), timezone Europe/Kyiv.";
    const d = deps({ timeContext });
    await handleIncomingMessage(incoming({ text: "remind me in 5m" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // [system prompt, time context, user] — the time line sits immediately before
    // the message being answered so relative times resolve against it.
    expect(messages.at(-2)).toEqual({ role: "system", content: timeContext });
    expect(messages.at(-1)).toEqual({ role: "user", content: "remind me in 5m" });
    // Recorded for debug.
    const step = recorder.event.mock.calls.map((c) => c[0]).find((e) => e.message === "time context");
    expect(step.data).toEqual({ timeContext });
  });

  it("omits the time line (and its trace step) when no time context is provided", async () => {
    const d = deps();
    await handleIncomingMessage(incoming({ text: "hello there" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Just [system prompt, user] — no injected time line.
    expect(messages).toHaveLength(2);
    const step = recorder.event.mock.calls.map((c) => c[0]).find((e) => e.message === "time context");
    expect(step).toBeUndefined();
  });

  it("attaches vision image parts to the current user turn and traces the step", async () => {
    const imageParts = [imagePart("ABC")];
    const d = deps({
      loadVision: vi.fn().mockResolvedValue({ imageParts }),
    });
    await handleIncomingMessage(incoming({ text: "what is this?" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "what is this?" }, ...imageParts],
    });
    // The traced request redacts the image bytes.
    const request = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "llm_request");
    const tracedUser = request.data.messages.at(-1);
    expect(tracedUser.content[1].image_url.url).toBe("data:image/jpeg;base64,<3 bytes>");
    // A vision step records the image count.
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "vision media attached");
    expect(step.data).toEqual({ imageCount: 1, hasNote: false });
  });

  it("appends the reply note to the text part when media comes from a replied-to image", async () => {
    const d = deps({
      loadVision: vi.fn().mockResolvedValue({
        imageParts: [imagePart("AB")],
        note: "The user is asking about the photo they replied to (shown here).",
      }),
    });
    await handleIncomingMessage(incoming({ text: "explain" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userTurn = messages.at(-1);
    expect(userTurn.content[0].text).toContain("explain");
    expect(userTurn.content[0].text).toContain("replied to");
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

  it("uses the composed current turn as the final user message and traces it", async () => {
    const d = deps({
      loadCurrentTurn: vi.fn().mockResolvedValue({
        content: "[#7] Bob (@bob): hello there",
        senderLabel: "Bob (@bob)",
        data: { line: "[#7] Bob (@bob): hello there", replyTo: null },
      }),
    });
    await handleIncomingMessage(incoming({ text: "hello there" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-1)).toEqual({ role: "user", content: "[#7] Bob (@bob): hello there" });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const composed = events.find((e) => e.message === "current turn composed");
    expect(composed.data).toEqual({
      line: "[#7] Bob (@bob): hello there",
      replyTo: null,
      // Private chat → no group addressing hint.
      addressingHint: null,
    });
  });

  it("falls back to the raw text when the current-turn loader resolves null", async () => {
    const d = deps({ loadCurrentTurn: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "plain" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-1)).toEqual({ role: "user", content: "plain" });
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "current turn composed")).toBe(false);
  });

  it("injects a group addressing hint naming the sender and address source", async () => {
    // A group message that mentions the bot by @username entity.
    const m = makeMessage({
      message_id: 7,
      chat: { id: 5, type: "group" },
      text: "@MyBot explain",
      entities: [{ type: "mention", offset: 0, length: 6 }],
    });
    const d = deps({
      loadChatContext: vi.fn().mockResolvedValue({ content: "roster", data: {} }),
      loadCurrentTurn: vi.fn().mockResolvedValue({
        content: "[#7] Bob (@bob): @MyBot explain",
        senderLabel: "Bob (@bob)",
        data: {},
      }),
      loadHistory: vi.fn().mockResolvedValue({ messages: [{ role: "user", content: "t" }], count: 1 }),
    });
    await handleIncomingMessage(incoming({ message: m, chatType: "group", text: "@MyBot explain" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, chat context, addressing hint, transcript, current message.
    expect(messages.map((msg: { role: string }) => msg.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "user",
    ]);
    expect(messages[2].content).toContain("from Bob (@bob), who mentioned you");
    expect(messages.at(-1)).toEqual({ role: "user", content: "[#7] Bob (@bob): @MyBot explain" });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const composed = events.find((e) => e.message === "current turn composed");
    expect(composed.data.addressingHint).toContain("from Bob (@bob), who mentioned you");
  });

  it("injects chat context as a system message after the base prompt", async () => {
    const priorTurns = [{ role: "user", content: "Ann: earlier" }];
    const d = deps({
      loadChatContext: vi
        .fn()
        .mockResolvedValue({ content: "Known participants:\n- Ann", data: { memberCount: 1 } }),
      loadHistory: vi.fn().mockResolvedValue({ messages: priorTurns, count: 1 }),
    });
    await handleIncomingMessage(incoming({ text: "who is ann?" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, chat-context system message, prior turn, current message.
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "system",
      "user",
      "user",
    ]);
    expect(messages[1]).toEqual({ role: "system", content: "Known participants:\n- Ann" });
    expect(messages[2]).toEqual(priorTurns[0]);
    expect(messages[3]).toEqual({ role: "user", content: "who is ann?" });

    // The context is recorded as a step, between system prompt and history.
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "chat context loaded",
      "history window loaded",
      "request",
      "response",
      "send message",
    ]);
    const loaded = events.find((e) => e.message === "chat context loaded");
    expect(loaded.data).toEqual({ memberCount: 1 });
  });

  it("omits the chat-context step when the loader resolves null", async () => {
    const d = deps({ loadChatContext: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // No extra system message when there is nothing to inject.
    expect(messages).toHaveLength(2);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "chat context loaded")).toBe(false);
  });

  it("injects the sender's communication preferences after the chat context and traces the step", async () => {
    const prefs = "Communication preferences of Bob (@bob):\n- They like: short answers";
    const d = deps({
      loadChatContext: vi.fn().mockResolvedValue({ content: "You are chatting with Bob." }),
      loadSenderPreferences: vi
        .fn()
        .mockResolvedValue({ content: prefs, data: { userId: "100", version: 2 } }),
    });
    await handleIncomingMessage(incoming({ text: "hi" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, chat context, preferences, current message.
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(messages[2]).toEqual({ role: "system", content: prefs });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const loaded = events.find((e) => e.message === "communication preferences loaded");
    expect(loaded.data).toEqual({ userId: "100", version: 2 });
  });

  it("omits the preferences step when the loader resolves null", async () => {
    const d = deps({ loadSenderPreferences: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages).toHaveLength(2);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "communication preferences loaded")).toBe(false);
  });

  it("composes the latest self-correction into the system prompt and flags it on the trace", async () => {
    const correction = "Answer in fewer words; do not open with a summary.";
    const d = deps({ selfCorrection: correction });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0].content).toContain(BASE_SYSTEM_PROMPT);
    expect(messages[0].content).toContain("Self-correction guidelines");
    expect(messages[0].content).toContain(correction);
    const composed = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(composed.data.selfCorrectionApplied).toBe(true);
    expect(composed.data.systemPrompt).toBe(messages[0].content);
  });

  it("records an empty data object for the chat-context step when the loader omits data", async () => {
    const d = deps({
      loadChatContext: vi.fn().mockResolvedValue({ content: "You are chatting with Bob." }),
    });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    const loaded = events.find((e) => e.message === "chat context loaded");
    expect(loaded.data).toEqual({});
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
    const m = makeMessage({
      message_id: 7,
      chat: { id: 5, type: "group" },
      text: "thanks",
      reply_to_message: { message_id: 1, from: BOT_USER },
    });
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
