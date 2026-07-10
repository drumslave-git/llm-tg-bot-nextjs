import { describe, expect, it } from "vitest";

import { toOpenAiBaseUrl } from "./client";

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
