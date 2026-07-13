import type { Document, Message, Sticker } from "@grammyjs/types";

import type { DetectedMedia, MediaKind } from "./types";

/**
 * Pure detection of vision-capable media on a Telegram message. Decides *what*
 * file to download and how to hint the describer — the actual download lives in
 * the server-only telegram-files module. Client-safe (only `@grammyjs/types`,
 * which are types).
 *
 * Precedence mirrors the MVP: a real image (photo / image document / gif) is
 * decoded directly; animations, videos, and animated/video stickers are read
 * from Telegram's single-frame JPEG thumbnail (the file itself is not an image).
 */

/** A short describe hint for a sticker: its emoji and pack name when present. */
function stickerHint(sticker: Sticker): string | null {
  const parts: string[] = [];
  if (sticker.emoji) parts.push(`Sticker emoji: ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`Sticker pack: ${sticker.set_name}`);
  return parts.length > 0 ? parts.join(". ") : null;
}

/** Thumbnail file id of a document that is really a video/gif (not a PDF etc.). */
function videoLikeDocumentThumbId(document: Document): string | undefined {
  if (!document.thumbnail) return undefined;
  const mime = document.mime_type ?? "";
  if (mime.startsWith("video/") || mime === "image/gif") return document.thumbnail.file_id;
  return undefined;
}

/**
 * The vision-capable media on a message, or null when there is none. Returns the
 * concrete `file_id` to download (already resolved to a thumbnail for non-image
 * media) plus a describe hint for stickers.
 */
export function detectMessageMedia(message: Message): DetectedMedia | null {
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return payload("photo", photo.file_id, photo.file_unique_id, null);
  }

  if (message.sticker) {
    const sticker = message.sticker;
    const animated = sticker.is_animated || sticker.is_video;
    // Animated (.tgs) / video (.webm) stickers are not still images — read their
    // JPEG thumbnail. A static (.webp) sticker is decoded directly.
    const fileId = animated ? sticker.thumbnail?.file_id : sticker.file_id;
    const fileUniqueId = animated ? sticker.thumbnail?.file_unique_id : sticker.file_unique_id;
    if (!fileId) return null;
    return payload("sticker", fileId, fileUniqueId ?? null, stickerHint(sticker));
  }

  if (message.document?.mime_type?.startsWith("image/")) {
    const doc = message.document;
    return payload("image_document", doc.file_id, doc.file_unique_id, null);
  }

  const animated = message.animation ?? message.video;
  if (animated) {
    const kind: MediaKind = message.animation ? "animation" : "video";
    // A true image/gif animation decodes directly; anything else uses the frame.
    if (animated.mime_type === "image/gif") {
      return payload(kind, animated.file_id, animated.file_unique_id, null);
    }
    if (animated.thumbnail) {
      return payload(kind, animated.thumbnail.file_id, animated.thumbnail.file_unique_id, null);
    }
    return null;
  }

  if (message.document) {
    const thumbId = videoLikeDocumentThumbId(message.document);
    if (thumbId) {
      return payload("video", thumbId, message.document.thumbnail?.file_unique_id ?? null, null);
    }
  }

  return null;
}

function payload(
  kind: MediaKind,
  fileId: string,
  fileUniqueId: string | null,
  visionHint: string | null,
): DetectedMedia {
  return { kind, fileId, fileUniqueId, visionHint };
}

/** Whether a message carries any vision-capable media. */
export function messageHasVisionMedia(message: Message | undefined): boolean {
  return message ? detectMessageMedia(message) !== null : false;
}

/**
 * The first message in a reply chain (up to `maxDepth`) that carries
 * vision-capable media — so "what is this?" as a reply to an earlier image
 * resolves to that image.
 */
export function findReplyMediaMessage(
  message: Message | undefined,
  maxDepth = 4,
): Message | null {
  let current: Message | undefined = message?.reply_to_message;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (messageHasVisionMedia(current)) return current;
    current = current.reply_to_message;
    depth++;
  }
  return null;
}
