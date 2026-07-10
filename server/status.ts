import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@/db/drizzle";
import { getSettingsRecord } from "@/features/settings/server/repository";
import { listModels } from "@/server/llm/client";

/**
 * System status for the dashboard overview. Every field is a *real probe* —
 * an actual `SELECT 1`, an actual `/v1/models` call — never a "is the env var
 * set" guess. Config lives in the DB, so status is derived by exercising it.
 *
 * Probes are best-effort and never throw: each failure is captured as a detail
 * string so the overview renders honest state instead of erroring.
 */

/** Short timeout so the overview stays responsive even against a dead endpoint. */
const LLM_PROBE_TIMEOUT_MS = 5_000;

export interface DbStatus {
  connected: boolean;
  detail: string;
}

export interface LlmStatus {
  state: "unconfigured" | "connected" | "error";
  detail: string;
  modelCount?: number;
}

export interface ModelStatus {
  selected: boolean;
  detail: string;
}

export interface SystemStatus {
  db: DbStatus;
  llm: LlmStatus;
  model: ModelStatus;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ConfigReadiness {
  configured: boolean;
  detail: string;
}

/**
 * Cheap, DB-only configuration readiness for the persistent shell (no live LLM
 * probe — that would run on every page). "Configured" means an endpoint and a
 * model are saved; the Overview page does the live reachability check.
 */
export async function getConfigReadiness(): Promise<ConfigReadiness> {
  try {
    const settings = await getSettingsRecord(getDb());
    const configured = Boolean(settings?.llmBaseUrl && settings?.model);
    return {
      configured,
      detail: configured
        ? "LLM endpoint and model set — see Overview for live status."
        : "Connect an LLM endpoint and choose a model.",
    };
  } catch {
    return { configured: false, detail: "Database unavailable." };
  }
}

/** Probe the database, the LLM endpoint, and the model selection. */
export async function getSystemStatus(): Promise<SystemStatus> {
  const db = getDb();

  // 1. Database — a real query. If it fails, nothing downstream can be checked.
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const detail = errorMessage(err);
    return {
      db: { connected: false, detail },
      llm: { state: "unconfigured", detail: "Requires a database connection" },
      model: { selected: false, detail: "Requires a database connection" },
    };
  }

  // 2. LLM endpoint — probe only what is actually configured in the DB.
  const settings = await getSettingsRecord(db);
  const baseUrl = settings?.llmBaseUrl ?? null;

  let llm: LlmStatus;
  if (!baseUrl) {
    llm = { state: "unconfigured", detail: "No endpoint set — configure it in Settings" };
  } else {
    try {
      const models = await listModels(
        { baseUrl, apiKey: settings?.llmApiKey ?? null },
        LLM_PROBE_TIMEOUT_MS,
      );
      llm = { state: "connected", detail: baseUrl, modelCount: models.length };
    } catch (err) {
      llm = { state: "error", detail: errorMessage(err) };
    }
  }

  // 3. Model selection.
  const model: ModelStatus = settings?.model
    ? { selected: true, detail: settings.model }
    : { selected: false, detail: "No model selected" };

  return { db: { connected: true, detail: "Connected" }, llm, model };
}
