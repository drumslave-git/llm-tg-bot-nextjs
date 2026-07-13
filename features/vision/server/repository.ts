import "server-only";

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { messageMedia, type MessageMediaRow } from "@/db/schema";

import type { MediaAnnotation, MediaKind, MediaStatus } from "../types";

/**
 * Typed persistence for `message_media`. Pure data access — no policy,
 * validation, or trace recording (the service owns those). Every function takes
 * a {@link DrizzleDb} so it runs against the pool or a test instance.
 */

/** A stored media row. */
export interface MediaRecord {
  id: string;
  chatId: string;
  telegramMessageId: number;
  kind: MediaKind;
  fileId: string;
  fileUniqueId: string | null;
  mimeType: string | null;
  dataBase64: string | null;
  visionHint: string | null;
  description: string | null;
  status: MediaStatus;
  createdAt: string;
  describedAt: string | null;
}

/** Fields for inserting a freshly ingested (pending) media row. */
export interface InsertMedia {
  id: string;
  chatId: string;
  telegramMessageId: number;
  kind: MediaKind;
  fileId: string;
  fileUniqueId?: string | null;
  mimeType?: string | null;
  dataBase64: string;
  visionHint?: string | null;
}

function mapRow(row: MessageMediaRow): MediaRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    kind: row.kind as MediaKind,
    fileId: row.fileId,
    fileUniqueId: row.fileUniqueId,
    mimeType: row.mimeType,
    dataBase64: row.dataBase64,
    visionHint: row.visionHint,
    description: row.description,
    status: row.status as MediaStatus,
    createdAt: row.createdAt.toISOString(),
    describedAt: row.describedAt ? row.describedAt.toISOString() : null,
  };
}

/**
 * Insert a pending media row. Idempotent on `(chat_id, telegram_message_id)` so a
 * re-delivered update does not duplicate. Returns the stored row, or null when
 * one already existed.
 */
export async function insertMedia(db: DrizzleDb, values: InsertMedia): Promise<MediaRecord | null> {
  const [row] = await db
    .insert(messageMedia)
    .values({
      id: values.id,
      chatId: values.chatId,
      telegramMessageId: values.telegramMessageId,
      kind: values.kind,
      fileId: values.fileId,
      fileUniqueId: values.fileUniqueId ?? null,
      mimeType: values.mimeType ?? "image/jpeg",
      dataBase64: values.dataBase64,
      visionHint: values.visionHint ?? null,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [messageMedia.chatId, messageMedia.telegramMessageId],
    })
    .returning();
  return row ? mapRow(row) : null;
}

/** Insert a placeholder row for media that could not be loaded/decoded. */
export async function insertUnavailableMedia(
  db: DrizzleDb,
  values: Omit<InsertMedia, "dataBase64">,
): Promise<MediaRecord | null> {
  const [row] = await db
    .insert(messageMedia)
    .values({
      id: values.id,
      chatId: values.chatId,
      telegramMessageId: values.telegramMessageId,
      kind: values.kind,
      fileId: values.fileId,
      fileUniqueId: values.fileUniqueId ?? null,
      mimeType: null,
      dataBase64: null,
      visionHint: values.visionHint ?? null,
      status: "unavailable",
    })
    .onConflictDoNothing({
      target: [messageMedia.chatId, messageMedia.telegramMessageId],
    })
    .returning();
  return row ? mapRow(row) : null;
}

/** The media row for a specific message, or null. */
export async function getMediaByMessage(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
): Promise<MediaRecord | null> {
  const row = await db.query.messageMedia.findFirst({
    where: and(
      eq(messageMedia.chatId, chatId),
      eq(messageMedia.telegramMessageId, telegramMessageId),
    ),
  });
  return row ? mapRow(row) : null;
}

/** One media row by id, or null. */
export async function getMediaById(db: DrizzleDb, id: string): Promise<MediaRecord | null> {
  const row = await db.query.messageMedia.findFirst({ where: eq(messageMedia.id, id) });
  return row ? mapRow(row) : null;
}

/**
 * Record a description on a media row and drop its bytes (`data_base64` → null,
 * `status` → described). Returns the updated row, or null when it was already
 * described (so a concurrent/duplicate describe is a no-op). Scoped to a pending
 * row so we never overwrite a prior description.
 */
export async function markDescribed(
  db: DrizzleDb,
  id: string,
  description: string,
): Promise<MediaRecord | null> {
  const [row] = await db
    .update(messageMedia)
    .set({ description, dataBase64: null, status: "described", describedAt: new Date() })
    .where(and(eq(messageMedia.id, id), eq(messageMedia.status, "pending")))
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Media annotations for a set of messages in a chat, keyed by Telegram message
 * id — how each media message reads in the history transcript.
 */
export async function getMediaAnnotations(
  db: DrizzleDb,
  chatId: string,
  telegramMessageIds: number[],
): Promise<Map<number, MediaAnnotation>> {
  if (telegramMessageIds.length === 0) return new Map();
  const rows = await db
    .select({
      telegramMessageId: messageMedia.telegramMessageId,
      kind: messageMedia.kind,
      status: messageMedia.status,
      description: messageMedia.description,
    })
    .from(messageMedia)
    .where(
      and(
        eq(messageMedia.chatId, chatId),
        inArray(messageMedia.telegramMessageId, telegramMessageIds),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.telegramMessageId,
      { kind: r.kind as MediaKind, status: r.status as MediaStatus, description: r.description },
    ]),
  );
}

/** Recent media rows for the dashboard, newest first. */
export async function listRecentMedia(db: DrizzleDb, limit = 100): Promise<MediaRecord[]> {
  const rows = await db
    .select()
    .from(messageMedia)
    .orderBy(desc(messageMedia.createdAt))
    .limit(limit);
  return rows.map(mapRow);
}

/**
 * Oldest pending media rows (bytes still present), for the vision backfill job
 * (priority 8). Oldest-first so the backlog drains in arrival order.
 */
export async function listPendingMedia(db: DrizzleDb, limit = 20): Promise<MediaRecord[]> {
  const rows = await db
    .select()
    .from(messageMedia)
    .where(eq(messageMedia.status, "pending"))
    .orderBy(asc(messageMedia.createdAt))
    .limit(limit);
  return rows.map(mapRow);
}

/** How many media rows are still awaiting a description (backfill backlog size). */
export async function countPendingMedia(db: DrizzleDb): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(messageMedia)
    .where(eq(messageMedia.status, "pending"));
  return row?.value ?? 0;
}
