import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { ApiError } from "@/lib/api-error";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { formatGroupContext } from "../format";
import {
  getGroupMembers,
  getKnownGroup,
  listKnownGroups,
  recordGroupMembership,
  setKnownGroupNotes,
  upsertKnownGroup,
  type GroupMemberRecord,
  type KnownGroupRecord,
  type KnownGroupSummaryRecord,
  type TelegramGroupProfile,
} from "./repository";
import type {
  GroupMember,
  GroupWithMembers,
  KnownGroup,
  KnownGroupSummary,
  UpdateGroupNotes,
} from "./schema";

/**
 * Known-groups domain service — the boundary Route Handlers, Server Components,
 * and the Telegram runtime call. Capturing group activity is a high-frequency
 * passive upsert (not traced); editing notes is an operator action (traced).
 * Mirrors the known-users service.
 */

const FEATURE = "known-groups";

/** Cap the injected roster so a busy group's context stays bounded. */
const ROSTER_LIMIT = 50;

/** A known-group record is already client-safe (no secrets). */
function toClientGroup(record: KnownGroupRecord): KnownGroup {
  return record;
}

function toClientSummary(record: KnownGroupSummaryRecord): KnownGroupSummary {
  return record;
}

function toClientMember(record: GroupMemberRecord): GroupMember {
  return record;
}

/** All known groups (with member counts), most-recently-seen first. */
export async function listGroups(db: DrizzleDb = getDb()): Promise<KnownGroupSummary[]> {
  return (await listKnownGroups(db)).map(toClientSummary);
}

/** One group with its resolved member list, or null if the group is unknown. */
export async function getGroupWithMembers(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<GroupWithMembers | null> {
  const group = await getKnownGroup(db, chatId);
  if (!group) return null;
  const members = await getGroupMembers(db, chatId);
  return { group: toClientGroup(group), members: members.map(toClientMember) };
}

/**
 * Server-only: remember (upsert) a group the bot is active in and record the
 * sender as a member. Refreshes the profile fields, preserves operator-curated
 * notes. Never throws into the message path — a capture failure must not drop the
 * reply. Assumes the sender's known-user row already exists (the runtime upserts
 * it first) so the membership FK is satisfied.
 */
export async function rememberGroupActivity(
  params: TelegramGroupProfile & { userId: string | null },
  db: DrizzleDb = getDb(),
): Promise<void> {
  try {
    await upsertKnownGroup(db, {
      chatId: params.chatId,
      title: params.title,
      type: params.type,
    });
    if (params.userId) {
      await recordGroupMembership(db, params.chatId, params.userId);
    }
    publishEvent("groups");
  } catch {
    // Best-effort capture; swallow so message handling continues.
  }
}

/** Replace a group's operator notes, recorded as a trace. */
export async function updateNotes(
  chatId: string,
  input: UpdateGroupNotes,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<KnownGroup> {
  const trace = await startTrace(
    { feature: FEATURE, action: "update-notes", trigger, inputSummary: `group ${chatId}` },
    db,
  );
  try {
    await trace.event({ type: "input", message: "notes update", data: { chatId, notes: input.notes } });
    const record = await setKnownGroupNotes(db, chatId, input.notes);
    if (!record) throw ApiError.notFound("Unknown group");
    await trace.event({ type: "db", message: "notes updated" });
    publishEvent("groups");
    await trace.succeed({
      outputSummary: input.notes ? "notes set" : "notes cleared",
      relatedIds: { known_groups: [chatId] },
    });
    return toClientGroup(record);
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** The current-day group context block injected into a group reply, or null. */
export interface GroupContext {
  content: string;
  memberCount: number;
}

/**
 * Server-only: build the group-context block for a reply — the group's title/notes
 * and a roster of its known participants (name + operator aliases), so the model
 * can recognize who is who even for people who have not spoken today. Returns null
 * when there is nothing useful to inject.
 */
export async function getGroupContext(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<GroupContext | null> {
  const [group, members] = await Promise.all([
    getKnownGroup(db, chatId),
    getGroupMembers(db, chatId, ROSTER_LIMIT),
  ]);
  const content = formatGroupContext({
    title: group?.title ?? null,
    notes: group?.notes ?? null,
    members: members.map((member) => ({
      label: formatKnownUserLabel(member),
      aliases: member.aliases,
    })),
  });
  if (!content) return null;
  return { content, memberCount: members.length };
}
