import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import type { TraceTrigger } from "@/lib/trace";
import { listModels } from "@/server/llm/client";
import { startTrace } from "@/server/trace";
import {
  getSettingsRecord,
  SETTINGS_ID,
  upsertSettings,
  type SettingsPatch,
  type SettingsRecord,
} from "./repository";
import type { Settings, TestConnection, UpdateSettings } from "./schema";

/**
 * Settings domain service — the boundary the Route Handlers and Server
 * Components call. Reads never expose the API key (only `apiKeyConfigured`).
 * Writes and connection tests are recorded as traces; the API key value is
 * redacted from trace data.
 */

const FEATURE = "settings";

/** Project an internal record to the client-safe shape (masking the secret). */
function toClientSettings(record: SettingsRecord | null): Settings {
  return {
    llmBaseUrl: record?.llmBaseUrl ?? null,
    model: record?.model ?? null,
    apiKeyConfigured: Boolean(record?.llmApiKey),
    updatedAt: record?.updatedAt ?? null,
  };
}

/** Current settings (no secret values), or empty defaults when never configured. */
export async function getSettings(db: DrizzleDb = getDb()): Promise<Settings> {
  return toClientSettings(await getSettingsRecord(db));
}

/** Translate a validated update into a column patch (empty key string clears it). */
function toPatch(input: UpdateSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (input.llmBaseUrl !== undefined) patch.llmBaseUrl = input.llmBaseUrl;
  if (input.model !== undefined) patch.model = input.model;
  if (input.apiKey !== undefined) patch.llmApiKey = input.apiKey === "" ? null : input.apiKey;
  return patch;
}

/** Redact the secret before it reaches trace storage. */
function redact(input: UpdateSettings): Record<string, unknown> {
  const { apiKey, ...rest } = input;
  return apiKey === undefined ? rest : { ...rest, apiKey: "«redacted»" };
}

/** Apply a validated partial update, recording the change as a trace. */
export async function updateSettings(
  input: UpdateSettings,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Settings> {
  const fields = Object.keys(input);
  const trace = await startTrace(
    { feature: FEATURE, action: "update", trigger, inputSummary: fields.join(", ") },
    db,
  );
  try {
    await trace.event({ type: "input", message: "settings update", data: redact(input) });
    const record = await upsertSettings(db, toPatch(input));
    await trace.event({ type: "db", message: "settings row upserted" });
    await trace.succeed({
      outputSummary: `Updated ${fields.join(", ")}`,
      relatedIds: { settings: [SETTINGS_ID] },
    });
    return toClientSettings(record);
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/**
 * Probe an OpenAI-compatible endpoint and return its model ids. Uses the given
 * key, or falls back to the stored key when `apiKey` is omitted (so the URL can
 * be re-tested without resending the secret). Recorded as a trace.
 */
export async function testConnection(
  input: TestConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ models: string[] }> {
  const trace = await startTrace(
    { feature: FEATURE, action: "test-connection", trigger, inputSummary: input.llmBaseUrl },
    db,
  );
  try {
    const apiKey =
      input.apiKey !== undefined ? input.apiKey : (await getSettingsRecord(db))?.llmApiKey ?? null;
    await trace.event({ type: "external_call", message: `GET ${input.llmBaseUrl} /models` });
    const models = await listModels({ baseUrl: input.llmBaseUrl, apiKey });
    await trace.event({ type: "output", message: `${models.length} models returned` });
    await trace.succeed({ outputSummary: `${models.length} models` });
    return { models };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
