import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertKnownUser } from "@/features/known-users/server/repository";
import { listTraces } from "@/server/trace/repository";
import { startTestDb, type TestDb } from "@/test/db";
import { getSettingsRecord } from "./repository";
import { updateSettingsSchema } from "./schema";
import {
  getBotPolicy,
  getDailyJobsRunTime,
  getEmbeddingRuntime,
  getSettings,
  getTelegramBotToken,
  getWebSearchApiKey,
  updateSettings,
} from "./service";

/** Seed a known user so the owner can be chosen by id. */
async function seedUser(ctx: TestDb, userId: string, username: string | null) {
  await upsertKnownUser(ctx.db, { userId, username, firstName: null, lastName: null });
}

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
      webSearchConfigured: false,
      embeddingBaseUrl: null,
      embeddingModel: null,
      embeddingApiKeyConfigured: false,
      ownerUsername: null,
      ownerUserId: null,
      maintenanceModeEnabled: false,
      timezone: "UTC",
      dailyJobsRunTime: "04:00",
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

  it("stores a valid timezone and rejects an unknown one", async () => {
    const set = await updateSettings({ timezone: "Europe/Berlin" }, trigger, ctx.db);
    expect(set.timezone).toBe("Europe/Berlin");
    await expect(updateSettings({ timezone: "Mars/Phobos" }, trigger, ctx.db)).rejects.toThrow(
      /timezone/i,
    );
  });

  it("persists the daily-jobs run time (validated at the schema boundary)", async () => {
    const set = await updateSettings({ dailyJobsRunTime: "05:30" }, trigger, ctx.db);
    expect(set.dailyJobsRunTime).toBe("05:30");
    // One setting drives every nightly job — both schedulers read this same value.
    expect(await getDailyJobsRunTime(ctx.db)).toBe("05:30");
    // The HH:MM shape is enforced by `updateSettingsSchema` before the service.
    expect(updateSettingsSchema.safeParse({ dailyJobsRunTime: "25:99" }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ dailyJobsRunTime: "3pm" }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ dailyJobsRunTime: "23:45" }).success).toBe(true);
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

  it("stores the Tavily API key as a masked, server-only secret", async () => {
    const set = await updateSettings({ tavilyApiKey: "tvly-secret" }, trigger, ctx.db);
    expect(set.webSearchConfigured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("tvly-secret");
    // Retrievable server-side for the web-search tool, never via the client shape.
    expect(await getWebSearchApiKey(ctx.db)).toBe("tvly-secret");

    const cleared = await updateSettings({ tavilyApiKey: "" }, trigger, ctx.db);
    expect(cleared.webSearchConfigured).toBe(false);
    expect(await getWebSearchApiKey(ctx.db)).toBeNull();
  });

  it("redacts secrets from recorded trace data", async () => {
    await updateSettings(
      { apiKey: "sk-secret-456", tavilyApiKey: "tvly-secret-456", model: "m" },
      trigger,
      ctx.db,
    );

    const { traces } = await listTraces(ctx.db, { feature: "settings" });
    expect(traces).toHaveLength(1);
    expect(traces[0].action).toBe("update");
    expect(traces[0].status).toBe("success");

    const events = await ctx.db.execute("SELECT data FROM trace_events");
    const json = JSON.stringify(events.rows);
    expect(json).not.toContain("sk-secret-456");
    expect(json).not.toContain("tvly-secret-456");
  });

  it("keeps a single row across many updates", async () => {
    await updateSettings({ model: "a" }, trigger, ctx.db);
    await updateSettings({ model: "b" }, trigger, ctx.db);

    const rows = await ctx.db.execute("SELECT COUNT(*)::int AS count FROM settings");
    expect(Number((rows.rows[0] as { count: number }).count)).toBe(1);
  });

  it("sets the owner from a known user (denormalizing the username) and toggles maintenance", async () => {
    await seedUser(ctx, "555", "ownername");

    const set = await updateSettings(
      { ownerUserId: "555", maintenanceModeEnabled: true },
      trigger,
      ctx.db,
    );
    expect(set.ownerUserId).toBe("555");
    expect(set.ownerUsername).toBe("ownername");
    expect(set.maintenanceModeEnabled).toBe(true);

    const off = await updateSettings({ maintenanceModeEnabled: false }, trigger, ctx.db);
    // Untouched owner survives a maintenance-only update.
    expect(off.ownerUserId).toBe("555");
    expect(off.maintenanceModeEnabled).toBe(false);
  });

  it("rejects an owner id that is not a known user", async () => {
    await expect(updateSettings({ ownerUserId: "404" }, trigger, ctx.db)).rejects.toThrow(
      /not a known user/i,
    );
  });

  it("clears the owner when passed null", async () => {
    await seedUser(ctx, "555", "ownername");
    await updateSettings({ ownerUserId: "555" }, trigger, ctx.db);

    const cleared = await updateSettings({ ownerUserId: null }, trigger, ctx.db);
    expect(cleared.ownerUserId).toBeNull();
    expect(cleared.ownerUsername).toBeNull();
  });
});

describe("getBotPolicy", () => {
  it("reads the owner id and maintenance flag", async () => {
    await seedUser(ctx, "999", "ownername");
    await updateSettings({ ownerUserId: "999", maintenanceModeEnabled: true }, trigger, ctx.db);

    const policy = await getBotPolicy(ctx.db);
    expect(policy).toEqual({ ownerUserId: "999", maintenanceModeEnabled: true });
  });

  it("defaults to no owner and maintenance off when unconfigured", async () => {
    expect(await getBotPolicy(ctx.db)).toEqual({
      ownerUserId: null,
      maintenanceModeEnabled: false,
    });
  });
});

describe("embedding configuration", () => {
  it("stores the embedding endpoint and never returns its key", async () => {
    const settings = await updateSettings(
      {
        embeddingBaseUrl: "https://embeddings.example.com/v1",
        embeddingApiKey: "secret-embed-key",
        embeddingModel: "bge-m3",
      },
      trigger,
      ctx.db,
    );

    expect(settings.embeddingBaseUrl).toBe("https://embeddings.example.com/v1");
    expect(settings.embeddingModel).toBe("bge-m3");
    expect(settings.embeddingApiKeyConfigured).toBe(true);
    // The value itself never round-trips to a client.
    expect(JSON.stringify(settings)).not.toContain("secret-embed-key");
    // …but it is stored, so the server can actually call the endpoint.
    expect((await getSettingsRecord(ctx.db))?.embeddingApiKey).toBe("secret-embed-key");
  });

  it("redacts the embedding key from the trace", async () => {
    await updateSettings({ embeddingApiKey: "secret-embed-key" }, trigger, ctx.db);

    const { traces } = await listTraces(ctx.db, { feature: "settings" });
    expect(JSON.stringify(traces)).not.toContain("secret-embed-key");
  });

  it("falls back to the LLM connection when no embedding endpoint is set", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        embeddingModel: "bge-m3",
      },
      trigger,
      ctx.db,
    );

    // Chat and embeddings share a host in the common case, so the LLM's URL *and*
    // its key are used — a key belongs to the host it authenticates.
    expect(await getEmbeddingRuntime(ctx.db)).toEqual({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "llm-key",
      model: "bge-m3",
    });
  });

  it("uses the embedding endpoint's own key when it has its own URL", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        embeddingBaseUrl: "https://embeddings.example.com/v1",
        embeddingApiKey: "embed-key",
        embeddingModel: "bge-m3",
      },
      trigger,
      ctx.db,
    );

    expect(await getEmbeddingRuntime(ctx.db)).toEqual({
      baseUrl: "https://embeddings.example.com/v1",
      apiKey: "embed-key",
      model: "bge-m3",
    });
  });

  it("is unconfigured (not half-configured) without a model", async () => {
    await updateSettings(
      { llmBaseUrl: "https://llm.example.com/v1", model: "gemma3" },
      trigger,
      ctx.db,
    );

    // No embedding model → semantic recall is off, rather than guessing a model id.
    expect(await getEmbeddingRuntime(ctx.db)).toBeNull();
  });

});
