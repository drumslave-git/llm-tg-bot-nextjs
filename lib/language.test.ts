import { describe, expect, it } from "vitest";

import {
  buildLanguageInstruction,
  DEFAULT_CHAT_LANGUAGE,
  languageField,
  normalizeChatLanguage,
  resolveRequiredLanguage,
} from "./language";

describe("normalizeChatLanguage", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeChatLanguage("  Brazilian   Portuguese ")).toBe("Brazilian Portuguese");
    expect(normalizeChatLanguage("English")).toBe("English");
  });
});

describe("resolveRequiredLanguage", () => {
  it("returns the default when unset, null, or blank", () => {
    expect(resolveRequiredLanguage(null)).toBe(DEFAULT_CHAT_LANGUAGE);
    expect(resolveRequiredLanguage(undefined)).toBe(DEFAULT_CHAT_LANGUAGE);
    expect(resolveRequiredLanguage("   ")).toBe(DEFAULT_CHAT_LANGUAGE);
  });

  it("returns the normalized stored language when set", () => {
    expect(resolveRequiredLanguage("  Ukrainian ")).toBe("Ukrainian");
  });
});

describe("buildLanguageInstruction", () => {
  it("names the language and states the strict override", () => {
    const text = buildLanguageInstruction("Ukrainian");
    expect(text).toContain("Ukrainian");
    // The directive must assert priority over the incoming message and personality.
    expect(text.toLowerCase()).toContain("overrides");
    expect(text).toContain("even when the");
  });

  it("falls back to the default for a blank language", () => {
    expect(buildLanguageInstruction("  ")).toContain(DEFAULT_CHAT_LANGUAGE);
  });
});

describe("languageField", () => {
  it("normalizes a language name", () => {
    expect(languageField.parse("  Ukrainian ")).toBe("Ukrainian");
  });

  it("maps blank/whitespace input to null (clears the config)", () => {
    expect(languageField.parse("")).toBeNull();
    expect(languageField.parse("   ")).toBeNull();
  });

  it("rejects an over-long value", () => {
    expect(languageField.safeParse("x".repeat(101)).success).toBe(false);
  });
});
