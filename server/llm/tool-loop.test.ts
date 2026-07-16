import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { runToolLoop, type ToolCallRecord, type ToolLoopRound } from "./tool-loop";

/** A function tool call as the provider would return it. */
function toolCall(id: string, name: string, args: Record<string, unknown>): ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A round that answers with content and no tool calls. */
function answer(content: string, latencyMs = 5): ToolLoopRound {
  return {
    assistantMessage: { role: "assistant", content },
    toolCalls: [],
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs,
    raw: { round: "answer" },
  };
}

/** A round that emits tool calls. */
function calls(toolCalls: ChatCompletionMessageToolCall[], latencyMs = 5): ToolLoopRound {
  return {
    assistantMessage: { role: "assistant", content: null, tool_calls: toolCalls },
    toolCalls,
    content: "",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs,
    raw: { round: "calls" },
  };
}

const okResult = (text: string): McpToolCallResult => ({ text });

describe("runToolLoop", () => {
  it("returns the answer immediately when the first round has no tool calls", async () => {
    const complete = vi.fn().mockResolvedValue(answer("done"));
    const callTool = vi.fn();
    const result = await runToolLoop({ seed: [], complete, callTool });
    expect(result).toMatchObject({ content: "done", rounds: 1, loopDetected: false });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("runs a tool then answers, recording the call and summing usage/latency", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "echo", { x: 1 })], 10))
      .mockResolvedValueOnce(answer("final", 20));
    const callTool = vi.fn().mockResolvedValue(okResult("tool said hi"));
    const recorded: ToolCallRecord[] = [];

    const result = await runToolLoop({
      seed: [{ role: "user", content: "hi" }],
      complete,
      callTool,
      onToolCall: (rec) => void recorded.push(rec),
    });

    expect(callTool).toHaveBeenCalledWith("echo", { x: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ name: "echo", args: { x: 1 }, ok: true });
    expect(result.content).toBe("final");
    expect(result.rounds).toBe(2);
    expect(result.latencyMs).toBe(30);
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 });
    // The tool result was appended to the conversation for the next round.
    const secondConversation = complete.mock.calls[1][0];
    expect(secondConversation.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "tool said hi",
    });
  });

  it("flags a tool error but keeps going", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "boom", {})]))
      .mockResolvedValueOnce(answer("recovered"));
    const callTool = vi.fn().mockRejectedValue(new Error("tool exploded"));
    const recorded: ToolCallRecord[] = [];

    const result = await runToolLoop({
      seed: [],
      complete,
      callTool,
      onToolCall: (rec) => void recorded.push(rec),
    });

    expect(recorded[0].ok).toBe(false);
    expect(recorded[0].result.text).toBe("tool exploded");
    expect(result.content).toBe("recovered");
  });

  it("treats an isError tool result as not-ok", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "t", {})]))
      .mockResolvedValueOnce(answer("ok"));
    const callTool = vi.fn().mockResolvedValue({ text: "bad range", isError: true });
    const recorded: ToolCallRecord[] = [];
    await runToolLoop({ seed: [], complete, callTool, onToolCall: (r) => void recorded.push(r) });
    expect(recorded[0].ok).toBe(false);
  });

  it("stops and flags a loop when the model repeats the same call with no progress", async () => {
    // Always the same call signature → no new action → stall guard trips.
    const complete = vi.fn().mockResolvedValue(calls([toolCall("c1", "spin", { n: 1 })]));
    const callTool = vi.fn().mockResolvedValue(okResult("again"));
    const result = await runToolLoop({ seed: [], complete, callTool });
    expect(result.loopDetected).toBe(true);
    expect(result.content).toBe("");
  });

  it("honors maxRounds as a hard cap", async () => {
    let n = 0;
    // Each round is a NEW call (progress), so only maxRounds stops it.
    const complete = vi.fn().mockImplementation(async () => calls([toolCall(`c${n}`, "t", { n: n++ })]));
    const callTool = vi.fn().mockResolvedValue(okResult("x"));
    const result = await runToolLoop({ seed: [], complete, callTool, maxRounds: 2 });
    expect(result.loopDetected).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

// Mock the OpenAI SDK so chatCompletionWithTools can be exercised end-to-end
// against a scripted provider response, the same way client.test.ts does.
const createMock = vi.fn();
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    models = { list: vi.fn() };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends Error {}
  return { default: OpenAI, APIError, APIConnectionError, APIConnectionTimeoutError };
});

/**
 * The invariant that actually broke: both completion paths return the same
 * `ChatCompletionResult`, so they must agree on what its fields mean. They did not —
 * the plain path recorded the provider's answer as `model` while this one
 * substituted the requested id, so merely enabling tools changed the recorded model
 * name and split one model's stats in two.
 */
describe("chatCompletionWithTools — result identity", () => {
  const conn = { baseUrl: "http://localhost:11434", apiKey: null };
  const bundlePath =
    "/models/bundles/sha256/95c8f7ac704f39390021259feb3d4849e85b42dca6b63014479fa4c3d48b4d86/model/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";

  afterEach(() => createMock.mockReset());

  it("reports the requested id and the served one, exactly like the plain path", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: bundlePath,
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });

    const withTools = await chatCompletionWithTools(conn, {
      model: "docker.io/ai/gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      callTool: async () => okResult(""),
    });
    const plain = await chatCompletion(conn, {
      model: "docker.io/ai/gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(withTools.model).toBe("docker.io/ai/gemma4:26B");
    expect(withTools.servedModel).toBe(bundlePath);
    // The whole point: turning tools on must not change how a call is identified.
    expect(withTools.model).toBe(plain.model);
    expect(withTools.servedModel).toBe(plain.servedModel);
  });

  it("leaves servedModel unset when the provider reports no model", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    createMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hello" } }],
    });

    const result = await chatCompletionWithTools(conn, {
      model: "gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      callTool: async () => okResult(""),
    });

    expect(result.model).toBe("gemma4:26B");
    expect(result.servedModel).toBeUndefined();
  });
});
