import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envPresence, getEnv, requireEnv, resetEnvCache } from "@/server/env";

const MANAGED = [
  "BOT_TOKEN",
  "BOT_TOKEN_FILE",
  "LLM_BASE_URL",
  "DATABASE_URL",
  "TAVILY_API_KEY",
  "LOGGING_LEVEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of MANAGED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetEnvCache();
});

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetEnvCache();
});

describe("getEnv", () => {
  it("reads direct env values", () => {
    process.env.LLM_BASE_URL = "https://host/v1";
    expect(getEnv().LLM_BASE_URL).toBe("https://host/v1");
  });

  it("resolves the <NAME>_FILE Docker-secret variant", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-test-"));
    const file = join(dir, "token");
    writeFileSync(file, "  secret-token\n");
    process.env.BOT_TOKEN_FILE = file;

    expect(getEnv().BOT_TOKEN).toBe("secret-token");
  });

  it("rejects invalid enum values", () => {
    process.env.LOGGING_LEVEL = "LOUD";
    expect(() => getEnv()).toThrow(/environment configuration/i);
  });
});

describe("requireEnv", () => {
  it("returns the value when present", () => {
    process.env.DATABASE_URL = "postgres://x";
    expect(requireEnv("DATABASE_URL")).toBe("postgres://x");
  });

  it("throws service_unavailable when missing", () => {
    expect(() => requireEnv("DATABASE_URL")).toThrowError(
      expect.objectContaining({ code: "service_unavailable" }),
    );
  });
});

describe("envPresence", () => {
  it("reports booleans without exposing values", () => {
    process.env.BOT_TOKEN = "abc";
    const presence = envPresence();
    expect(presence.BOT_TOKEN).toBe(true);
    expect(presence.DATABASE_URL).toBe(false);
    expect(Object.values(presence)).not.toContain("abc");
  });
});
