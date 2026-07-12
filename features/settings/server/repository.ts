import "server-only";

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { settings, type SettingsRow } from "@/db/schema";

/**
 * Typed persistence for the single settings row. Pure data access: no policy, no
 * validation, no masking (the service decides what to expose). Every function
 * takes a {@link DrizzleDb} so it runs against the pool or a test instance.
 *
 * The record includes the raw API key — callers must never return it to clients.
 */

/** Fixed primary key of the one settings row (enforced by a DB check constraint). */
export const SETTINGS_ID = "singleton";

/** Internal settings record, including the secret API key and bot token. */
export interface SettingsRecord {
  llmBaseUrl: string | null;
  llmApiKey: string | null;
  model: string | null;
  activePersonalityId: string | null;
  telegramBotToken: string | null;
  ownerUsername: string | null;
  ownerUserId: string | null;
  maintenanceModeEnabled: boolean;
  updatedAt: string | null;
}

/** Columns a write may touch. Undefined = leave unchanged. */
export interface SettingsPatch {
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  model?: string | null;
  activePersonalityId?: string | null;
  telegramBotToken?: string | null;
  ownerUsername?: string | null;
  ownerUserId?: string | null;
  maintenanceModeEnabled?: boolean;
}

function mapRow(row: SettingsRow): SettingsRecord {
  return {
    llmBaseUrl: row.llmBaseUrl,
    llmApiKey: row.llmApiKey,
    model: row.model,
    activePersonalityId: row.activePersonalityId,
    telegramBotToken: row.telegramBotToken,
    ownerUsername: row.ownerUsername,
    ownerUserId: row.ownerUserId,
    maintenanceModeEnabled: row.maintenanceModeEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The settings record, or null when it has never been written. */
export async function getSettingsRecord(db: DrizzleDb): Promise<SettingsRecord | null> {
  const row = await db.query.settings.findFirst({ where: eq(settings.id, SETTINGS_ID) });
  return row ? mapRow(row) : null;
}

/**
 * Upsert a patch onto the single row, touching only the provided columns.
 * Returns the full, updated record.
 */
export async function upsertSettings(
  db: DrizzleDb,
  patch: SettingsPatch,
): Promise<SettingsRecord> {
  const changed = { ...patch, updatedAt: new Date() };
  const [row] = await db
    .insert(settings)
    .values({ id: SETTINGS_ID, ...changed })
    .onConflictDoUpdate({ target: settings.id, set: changed })
    .returning();
  return mapRow(row);
}
