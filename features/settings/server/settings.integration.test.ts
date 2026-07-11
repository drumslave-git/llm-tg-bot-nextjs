import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";
import { getSettingsRecord } from "./repository";
import { getSettings, getTelegramBotToken, updateSettings } from "./service";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "dashboard" } as const;

describe("getSettings", () => {
  it("returns empty defaults when never configured", async () => {
    expect(await getSettings(ctx.db)).toEqual({
      llmBaseUrl: null,
      model: null,
      apiKeyConfigured: false,
      telegramBotTokenConfigured: false,
      updatedAt: null,
    });
  });
});

describe("updateSettings", () => {
  it("persists a partial update and merges across writes", async () => {
    const first = await updateSettings(
      { llmBaseUrl: "https://api.openai.com/v1" },
      trigger,
      ctx.db,
    );
    expect(first.llmBaseUrl).toBe("https://api.openai.com/v1");
    expect(first.model).toBeNull();
    expect(first.updatedAt).not.toBeNull();

    const second = await updateSettings({ model: "gpt-4o-mini" }, trigger, ctx.db);
    // Untouched fields survive partial updates.
    expect(second.llmBaseUrl).toBe("https://api.openai.com/v1");
    expect(second.model).toBe("gpt-4o-mini");
  });

  it("never exposes the API key but reports it as configured, and can clear it", async () => {
    const set = await updateSettings({ apiKey: "sk-secret-123" }, trigger, ctx.db);
    expect(set.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("sk-secret-123");
    // The raw value is stored for provider calls, just not surfaced to clients.
    expect((await getSettingsRecord(ctx.db))?.llmApiKey).toBe("sk-secret-123");

    const cleared = await updateSettings({ apiKey: "" }, trigger, ctx.db);
    expect(cleared.apiKeyConfigured).toBe(false);
    expect((await getSettingsRecord(ctx.db))?.llmApiKey).toBeNull();
  });

  it("stores the Telegram bot token as a masked, server-only secret", async () => {
    const set = await updateSettings({ telegramBotToken: "123:ABC-secret" }, trigger, ctx.db);
    expect(set.telegramBotTokenConfigured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("123:ABC-secret");
    // The raw value is retrievable server-side (for the poller), never via the client shape.
    expect(await getTelegramBotToken(ctx.db)).toBe("123:ABC-secret");

    const cleared = await updateSettings({ telegramBotToken: "" }, trigger, ctx.db);
    expect(cleared.telegramBotTokenConfigured).toBe(false);
    expect(await getTelegramBotToken(ctx.db)).toBeNull();
  });

  it("redacts the API key from recorded trace data", async () => {
    await updateSettings({ apiKey: "sk-secret-456", model: "m" }, trigger, ctx.db);

    const { traces } = await listTraces(ctx.db, { feature: "settings" });
    expect(traces).toHaveLength(1);
    expect(traces[0].action).toBe("update");
    expect(traces[0].status).toBe("success");

    const events = await ctx.db.execute("SELECT data FROM trace_events");
    expect(JSON.stringify(events.rows)).not.toContain("sk-secret-456");
  });

  it("keeps a single row across many updates", async () => {
    await updateSettings({ model: "a" }, trigger, ctx.db);
    await updateSettings({ model: "b" }, trigger, ctx.db);

    const rows = await ctx.db.execute("SELECT COUNT(*)::int AS count FROM settings");
    expect(Number((rows.rows[0] as { count: number }).count)).toBe(1);
  });
});
