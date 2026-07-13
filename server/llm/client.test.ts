import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeMessagesForTrace, toOpenAiBaseUrl, type ChatMessage } from "./client";

describe("sanitizeMessagesForTrace", () => {
  it("leaves plain-text messages untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ];
    expect(sanitizeMessagesForTrace(messages)).toEqual(messages);
  });

  it("replaces inline image bytes with a compact byte-length marker", () => {
    const base64 = "A".repeat(2048);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ];
    const [sanitized] = sanitizeMessagesForTrace(messages);
    expect(sanitized.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,<2048 bytes>" } },
    ]);
  });

  it("does not mutate the input", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,ABCD" } }],
      },
    ];
    sanitizeMessagesForTrace(messages);
    expect((messages[0].content as { type: string }[])[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,ABCD" },
    });
  });
});

describe("toOpenAiBaseUrl", () => {
  it("appends /v1 when missing", () => {
    expect(toOpenAiBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
  });

  it("keeps an existing /v1 and strips trailing slashes", () => {
    expect(toOpenAiBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(toOpenAiBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434/v1");
  });

  it("rejects a blank URL", () => {
    expect(() => toOpenAiBaseUrl("   ")).toThrow();
  });
});

// Mock the OpenAI SDK so chatCompletion can be tested without a live endpoint.
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

describe("chatCompletion", () => {
  afterEach(() => createMock.mockReset());

  const conn = { baseUrl: "http://localhost:11434", apiKey: null };

  it("returns trimmed content, model, and normalized usage", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: "gemma:12b",
      choices: [{ message: { content: "  hello there  " } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    const result = await chatCompletion(conn, {
      model: "gemma:12b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("hello there");
    expect(result.model).toBe("gemma:12b");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws service_unavailable when the model returns empty content", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ model: "m", choices: [{ message: { content: "   " } }] });

    await expect(
      chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });
});
