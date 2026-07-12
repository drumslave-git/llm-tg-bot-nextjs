import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { ApiError } from "@/lib/api-error";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import {
  getKnownUser,
  listKnownUsers,
  setKnownUserAliases,
  upsertKnownUser,
  type KnownUserRecord,
  type TelegramUserProfile,
} from "./repository";
import type { KnownUser, UpdateAliases } from "./schema";

/**
 * Known-users domain service — the boundary Route Handlers, Server Components,
 * and the Telegram runtime call. Remembering a user is a high-frequency passive
 * upsert (not traced); editing aliases is an operator action (traced).
 */

const FEATURE = "known-users";

/** A known user record is already client-safe (no secrets). */
function toClient(record: KnownUserRecord): KnownUser {
  return record;
}

/** All known users, most-recently-seen first. */
export async function listUsers(db: DrizzleDb = getDb()): Promise<KnownUser[]> {
  return (await listKnownUsers(db)).map(toClient);
}

/** One known user by id, or null. */
export async function getUser(userId: string, db: DrizzleDb = getDb()): Promise<KnownUser | null> {
  const record = await getKnownUser(db, userId);
  return record ? toClient(record) : null;
}

/**
 * Server-only: remember (upsert) a Telegram user who messaged the bot. Refreshes
 * the profile fields, preserves operator-curated aliases. Never throws into the
 * message path — a capture failure must not drop the reply.
 */
export async function rememberUser(
  profile: TelegramUserProfile,
  db: DrizzleDb = getDb(),
): Promise<void> {
  try {
    await upsertKnownUser(db, profile);
    publishEvent("users");
  } catch {
    // Best-effort capture; swallow so message handling continues.
  }
}

/** Replace a known user's alias list, recorded as a trace. */
export async function updateAliases(
  userId: string,
  input: UpdateAliases,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<KnownUser> {
  const trace = await startTrace(
    { feature: FEATURE, action: "update-aliases", trigger, inputSummary: `user ${userId}` },
    db,
  );
  try {
    await trace.event({ type: "input", message: "aliases update", data: { userId, aliases: input.aliases } });
    const record = await setKnownUserAliases(db, userId, input.aliases);
    if (!record) throw ApiError.notFound("Unknown user");
    await trace.event({ type: "db", message: "aliases updated" });
    publishEvent("users");
    await trace.succeed({
      outputSummary: `${input.aliases.length} alias(es)`,
      relatedIds: { known_users: [userId] },
    });
    return toClient(record);
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
