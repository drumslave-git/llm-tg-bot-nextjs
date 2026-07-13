import "server-only";

import type { Message } from "@grammyjs/types";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { FEATURES } from "@/lib/features";
import { sanitizeMessagesForTrace, type ChatCompletionResult, type ChatMessage } from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { detectMessageMedia } from "../detect";
import type { ImagePayload, MediaAnnotation, MediaKind, MediaView } from "../types";
import { buildDescribeMessages } from "./describe";
import { normalizeImageForChat } from "./normalize";
import {
  countPendingMedia,
  getMediaAnnotations,
  getMediaByMessage,
  getMediaById,
  insertMedia,
  insertUnavailableMedia,
  listRecentMedia,
  markDescribed,
  type MediaRecord,
} from "./repository";
import { downloadTelegramFile } from "./telegram-files";

/**
 * Vision domain service — the boundary the Telegram runtime and dashboard call.
 *
 * Two paths:
 *  - **Ingest** (passive, untraced, high-volume like history capture): every
 *    incoming media message is downloaded, normalized to a bounded JPEG, and
 *    stored as base64 with `status = 'pending'`.
 *  - **Describe** (traced, a meaningful action): for the addressed turn the
 *    stored image is captioned immediately and the bytes are dropped
 *    (`markDescribed`), so past turns read as text in the transcript. The rest
 *    stay pending for the backfill job (priority 8).
 */

const FEATURE = FEATURES["vision"];

/** Load-and-normalize an image by Telegram file id. Best-effort — null on any failure. */
async function loadImage(token: string, fileId: string): Promise<ImagePayload | null> {
  try {
    const raw = await downloadTelegramFile(token, fileId);
    if (!raw) return null;
    return await normalizeImageForChat(raw.base64);
  } catch {
    return null;
  }
}

/**
 * Ingest media on an incoming message: download, normalize, and store a pending
 * row. Returns the normalized image(s) for immediate use in the reply pass and
 * the stored record (or null when the message has no media). Best-effort:
 * media that cannot be loaded is recorded as `unavailable` and returns no images.
 * Passive and untraced — the stored row is the record.
 */
export async function ingestMessageMedia(
  params: { token: string; chatId: string; telegramMessageId: number; message: Message },
  db: DrizzleDb = getDb(),
): Promise<{ images: ImagePayload[]; kind: MediaKind } | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;

  const image = await loadImage(params.token, detected.fileId);
  if (!image) {
    await insertUnavailableMedia(db, {
      id: crypto.randomUUID(),
      chatId: params.chatId,
      telegramMessageId: params.telegramMessageId,
      kind: detected.kind,
      fileId: detected.fileId,
      fileUniqueId: detected.fileUniqueId,
      visionHint: detected.visionHint,
    }).catch(() => null);
    publishEvent(FEATURE.realtimeTopic);
    return null;
  }

  await insertMedia(db, {
    id: crypto.randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: detected.kind,
    fileId: detected.fileId,
    fileUniqueId: detected.fileUniqueId,
    mimeType: image.mimeHint,
    dataBase64: image.base64,
    visionHint: detected.visionHint,
  }).catch(() => null);
  publishEvent(FEATURE.realtimeTopic);

  return { images: [image], kind: detected.kind };
}

/**
 * Images for a replied-to media message, so "what is this?" as a reply to an
 * earlier image resolves to it. Reuses the stored bytes when present, otherwise
 * re-downloads by file id. Returns null when the message has no media or it can't
 * be loaded.
 */
export async function loadReplyTargetImages(
  params: { token: string; chatId: string; message: Message },
  db: DrizzleDb = getDb(),
): Promise<{ images: ImagePayload[]; kind: MediaKind } | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;

  const stored = await getMediaByMessage(db, params.chatId, params.message.message_id).catch(
    () => null,
  );
  if (stored?.dataBase64) {
    return { images: [{ base64: stored.dataBase64, mimeHint: stored.mimeType ?? "image/jpeg" }], kind: detected.kind };
  }

  const image = await loadImage(params.token, detected.fileId);
  return image ? { images: [image], kind: detected.kind } : null;
}

/** Collaborators for the describe pass; injected so it is unit-testable. */
export interface DescribeDeps {
  /** Run the describe completion; returns the text plus usage/model for tracing. */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
}

/**
 * Describe a message's stored media and drop its bytes. Traced under `vision`.
 * A no-op (skipped) when the message has no pending media. Best-effort: on
 * failure the row stays `pending` for the backfill job to retry.
 */
export async function describeAndStore(
  params: { chatId: string; telegramMessageId: number },
  deps: DescribeDeps,
  db: DrizzleDb = getDb(),
): Promise<MediaRecord | null> {
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "describe",
      trigger: {
        kind: "telegram",
        actor: params.chatId,
        correlationId: `${params.chatId}:${params.telegramMessageId}`,
      },
      inputSummary: `media on message ${params.telegramMessageId}`,
    },
    db,
  );
  try {
    const media = await getMediaByMessage(db, params.chatId, params.telegramMessageId);
    if (!media || media.status !== "pending" || !media.dataBase64) {
      await trace.skip("no pending media to describe");
      return null;
    }

    const images: ImagePayload[] = [
      { base64: media.dataBase64, mimeHint: media.mimeType ?? "image/jpeg" },
    ];
    const messages = buildDescribeMessages(images, media.visionHint);
    await trace.event({
      type: "llm_request",
      message: "describe request",
      data: { messages: sanitizeMessagesForTrace(messages) },
    });

    const result = await deps.complete(messages);
    await trace.event({
      type: "llm_response",
      message: "describe response",
      data: { content: result.content },
      usage: {
        model: result.model,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
        latencyMs: result.latencyMs,
      },
    });

    const description = result.content.trim();
    if (!description) {
      await trace.skip("empty description");
      return null;
    }

    const updated = await markDescribed(db, media.id, description);
    await trace.event({
      type: "db",
      message: "media described",
      data: { kind: media.kind, chars: description.length },
    });
    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: description,
      relatedIds: { [FEATURE.relatedIdsKey]: [media.id] },
    });
    return updated ?? media;
  } catch (err) {
    await trace.fail(err);
    return null;
  }
}

/** Media annotations for a set of messages in a chat (for the history transcript). */
export async function getMediaAnnotationsForMessages(
  chatId: string,
  telegramMessageIds: number[],
  db: DrizzleDb = getDb(),
): Promise<Map<number, MediaAnnotation>> {
  return getMediaAnnotations(db, chatId, telegramMessageIds);
}

/** Map a stored row to its dashboard view (bytes → preview only while pending). */
function toView(record: MediaRecord): MediaView {
  return {
    id: record.id,
    chatId: record.chatId,
    telegramMessageId: record.telegramMessageId,
    kind: record.kind,
    status: record.status,
    description: record.description,
    preview:
      record.status === "pending" && record.dataBase64
        ? `data:${record.mimeType ?? "image/jpeg"};base64,${record.dataBase64}`
        : null,
    createdAt: record.createdAt,
    describedAt: record.describedAt,
  };
}

/** Recent media for the dashboard, newest first. */
export async function listMedia(limit = 100, db: DrizzleDb = getDb()): Promise<MediaView[]> {
  const rows = await listRecentMedia(db, limit);
  return rows.map(toView);
}

/** One media row by id (dashboard detail), or null. */
export async function getMediaDetail(id: string, db: DrizzleDb = getDb()): Promise<MediaRecord | null> {
  return getMediaById(db, id);
}

/** Count of media rows still awaiting a description (backfill backlog size). */
export async function getPendingMediaCount(db: DrizzleDb = getDb()): Promise<number> {
  return countPendingMedia(db);
}
