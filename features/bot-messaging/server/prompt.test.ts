import { describe, expect, it } from "vitest";

import { BASE_SYSTEM_PROMPT, buildSystemPrompt, hasPersonality } from "./prompt";

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

describe("hasPersonality", () => {
  it("is true only for non-blank prompts", () => {
    expect(hasPersonality("x")).toBe(true);
    expect(hasPersonality(null)).toBe(false);
    expect(hasPersonality(undefined)).toBe(false);
    expect(hasPersonality("   ")).toBe(false);
  });
});
