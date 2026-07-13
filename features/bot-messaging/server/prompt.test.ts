import { describe, expect, it } from "vitest";

import {
  BASE_SYSTEM_PROMPT,
  buildAddressingHint,
  buildSystemPrompt,
  hasPersonality,
} from "./prompt";

describe("buildSystemPrompt", () => {
  it("returns the base prompt alone when no personality is given", () => {
    expect(buildSystemPrompt()).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ personalityPrompt: null })).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ personalityPrompt: "" })).toBe(BASE_SYSTEM_PROMPT);
    // Whitespace-only is treated as unset.
    expect(buildSystemPrompt({ personalityPrompt: "   \n  " })).toBe(BASE_SYSTEM_PROMPT);
  });

  it("appends a trimmed personality as additional instructions", () => {
    const out = buildSystemPrompt({ personalityPrompt: "  Be terse.  " });
    expect(out).toBe(`${BASE_SYSTEM_PROMPT}\n\n---\nAdditional instructions:\nBe terse.`);
  });

  it("preserves internal formatting of the personality prompt", () => {
    const persona = "Line one.\nLine two.";
    expect(buildSystemPrompt({ personalityPrompt: persona })).toContain(persona);
  });
});

describe("buildAddressingHint", () => {
  it("names the sender and how they addressed the bot", () => {
    const hint = buildAddressingHint({ senderLabel: "Bob (@bob)", source: "mention" });
    expect(hint).toContain("from Bob (@bob), who mentioned you");
    expect(hint).toContain("group chat");
  });

  it("phrases each group address source", () => {
    expect(buildAddressingHint({ senderLabel: "A", source: "reply" })).toContain(
      "replied to one of your messages",
    );
    expect(buildAddressingHint({ senderLabel: "A", source: "command" })).toContain(
      "sent you a command",
    );
  });

  it("falls back to a generic sender when the label is unknown", () => {
    expect(buildAddressingHint({ senderLabel: null, source: "mention" })).toContain(
      "from a group participant",
    );
  });

  it("returns null for private chats and unknown sources", () => {
    expect(buildAddressingHint({ senderLabel: "A", source: "private" })).toBeNull();
    expect(buildAddressingHint({ senderLabel: "A", source: "" })).toBeNull();
  });
});

describe("hasPersonality", () => {
  it("is true only for non-blank prompts", () => {
    expect(hasPersonality("x")).toBe(true);
    expect(hasPersonality(null)).toBe(false);
    expect(hasPersonality(undefined)).toBe(false);
    expect(hasPersonality("   ")).toBe(false);
  });
});
