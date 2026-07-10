import { describe, expect, it } from "vitest";

import { testConnectionSchema, updateSettingsSchema } from "./schema";

describe("updateSettingsSchema", () => {
  it("accepts a partial update", () => {
    expect(updateSettingsSchema.parse({ model: "gpt-4o-mini" })).toEqual({
      model: "gpt-4o-mini",
    });
  });

  it("rejects an empty update", () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(false);
  });

  it("validates the base URL as a URL but allows null to clear it", () => {
    expect(updateSettingsSchema.safeParse({ llmBaseUrl: "not a url" }).success).toBe(false);
    expect(updateSettingsSchema.parse({ llmBaseUrl: null })).toEqual({ llmBaseUrl: null });
    expect(updateSettingsSchema.parse({ llmBaseUrl: "https://api.openai.com/v1" })).toEqual({
      llmBaseUrl: "https://api.openai.com/v1",
    });
  });

  it("allows an empty api key string (clears) and null", () => {
    expect(updateSettingsSchema.parse({ apiKey: "" })).toEqual({ apiKey: "" });
    expect(updateSettingsSchema.parse({ apiKey: null })).toEqual({ apiKey: null });
  });
});

describe("testConnectionSchema", () => {
  it("requires a valid base URL and allows an optional key", () => {
    expect(testConnectionSchema.safeParse({}).success).toBe(false);
    expect(testConnectionSchema.safeParse({ llmBaseUrl: "nope" }).success).toBe(false);
    expect(testConnectionSchema.parse({ llmBaseUrl: "http://localhost:11434/v1" })).toEqual({
      llmBaseUrl: "http://localhost:11434/v1",
    });
  });
});
