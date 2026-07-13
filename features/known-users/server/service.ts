import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getChatParticipantIds } from "@/features/history/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { matchUsersByReference } from "../match";
import {
  getKnownUser,
  getKnownUsersByIds,
  listKnownUsers,
  setKnownUserAliases,
  upsertKnownUser,
  type KnownUserRecord,
  type TelegramUserProfile,
} from "./repository";
import { updateAliasesSchema, type KnownUser, type UpdateAliases } from "./schema";

/**
 * Known-users domain service — the boundary Route Handlers, Server Components,
 * and the Telegram runtime call. Remembering a user is a high-frequency passive
 * upsert (not traced); editing aliases is an operator action (traced).
 */

const FEATURE = FEATURES["known-users"];

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
    publishEvent(FEATURE.realtimeTopic);
  } catch {
    // Best-effort capture; swallow so message handling continues.
  }
}

/** Set of a user's own lowercased names — aliases already implied by identity. */
function ownNames(user: KnownUserRecord): Set<string> {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const v = value?.trim().toLowerCase();
    if (v) out.add(v);
  };
  add(user.username);
  add(user.firstName);
  add(user.lastName);
  for (const alias of user.aliases) add(alias);
  return out;
}

/** Outcome of an alias-from-reference update, mapped by the tool to a reply. */
export type AddAliasByReferenceResult =
  | { status: "updated"; user: KnownUser; added: string[] }
  | { status: "noop"; user: KnownUser }
  | { status: "not_found" }
  | { status: "ambiguous"; count: number }
  | { status: "invalid"; reason: string };

/**
 * Resolve a name reference to a participant of `chatId` and add nickname(s) to
 * their known-user aliases — the write behind the `update_user_aliases` MCP tool.
 * Chat-scoped (only people who have messaged in this chat can be matched) so a
 * tool can never touch an unrelated user. Recorded as a trace so operators see
 * model-driven alias changes on the Users Debug page alongside their own edits.
 */
export async function addAliasByReference(
  params: { chatId: string; reference: string; aliases: string[] },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<AddAliasByReferenceResult> {
  const trace = await startTrace(
    { feature: FEATURE.id, action: "add-aliases", trigger, inputSummary: params.reference },
    db,
  );
  try {
    await trace.event({
      type: "input",
      message: "alias from tool",
      data: { reference: params.reference, aliases: params.aliases },
    });

    const participantIds = await getChatParticipantIds(db, params.chatId);
    const users = await getKnownUsersByIds(db, participantIds);
    const matches = matchUsersByReference(users, params.reference);

    if (matches.length === 0) {
      await trace.skip(`no participant matches "${params.reference}"`);
      return { status: "not_found" };
    }
    if (matches.length > 1) {
      await trace.skip(`"${params.reference}" is ambiguous — ${matches.length} matches`);
      return { status: "ambiguous", count: matches.length };
    }

    const user = matches[0];
    const known = ownNames(user);
    // Aliases are plain names — strip a leading `@` so "@alice" is recognized as
    // the (already-known) username rather than stored as a distinct nickname.
    const toAdd = params.aliases
      .map((a) => a.trim().replace(/^@+/, "").trim())
      .filter((a) => a && !known.has(a.toLowerCase()));

    if (toAdd.length === 0) {
      await trace.skip("nothing new to add", {
        relatedIds: { [FEATURE.relatedIdsKey]: [user.userId] },
      });
      return { status: "noop", user: toClient(user) };
    }

    const parsed = updateAliasesSchema.safeParse({ aliases: [...user.aliases, ...toAdd] });
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "Invalid aliases";
      await trace.skip(`rejected: ${reason}`, {
        relatedIds: { [FEATURE.relatedIdsKey]: [user.userId] },
      });
      return { status: "invalid", reason };
    }

    const record = await setKnownUserAliases(db, user.userId, parsed.data.aliases);
    if (!record) throw ApiError.notFound("Unknown user");
    await trace.event({ type: "db", message: "aliases updated", data: { aliases: parsed.data.aliases } });
    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: `+${toAdd.length} alias(es) for ${user.userId}`,
      relatedIds: { [FEATURE.relatedIdsKey]: [user.userId] },
    });
    return { status: "updated", user: toClient(record), added: toAdd };
  } catch (err) {
    await trace.fail(err);
    throw err;
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
    { feature: FEATURE.id, action: "update-aliases", trigger, inputSummary: `user ${userId}` },
    db,
  );
  try {
    await trace.event({ type: "input", message: "aliases update", data: { userId, aliases: input.aliases } });
    const record = await setKnownUserAliases(db, userId, input.aliases);
    if (!record) throw ApiError.notFound("Unknown user");
    await trace.event({ type: "db", message: "aliases updated" });
    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: `${input.aliases.length} alias(es)`,
      relatedIds: { [FEATURE.relatedIdsKey]: [userId] },
    });
    return toClient(record);
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
