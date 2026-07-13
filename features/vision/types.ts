/**
 * Shared vision types. Client-safe (no server imports) so both the server
 * services and the dashboard/debug UI can import them.
 */

/** The kinds of visual media the bot can read from a Telegram message. */
export type MediaKind = "photo" | "sticker" | "image_document" | "animation" | "video";

/** Lifecycle status of a stored media row. */
export type MediaStatus = "pending" | "described" | "unavailable";

/** A normalized image ready for the vision model: base64 JPEG + mime hint. */
export interface ImagePayload {
  base64: string;
  mimeHint: string;
}

/**
 * The vision-capable media found on a Telegram message, before download. Enough
 * to fetch the bytes and to record the row.
 */
export interface DetectedMedia {
  kind: MediaKind;
  fileId: string;
  fileUniqueId: string | null;
  /** A sticker's emoji / pack hint, folded into the describe prompt. */
  visionHint: string | null;
}

/**
 * How a stored media row is surfaced in the history transcript: a short kind
 * marker plus (once described) the model's text description.
 */
export interface MediaAnnotation {
  kind: MediaKind;
  status: MediaStatus;
  description: string | null;
}

/**
 * A media row shaped for the dashboard. Pending rows carry a `preview` data URL
 * (the stored image) so the operator can see un-captioned media; described rows
 * carry the text `description` instead (their bytes are gone). Client-safe.
 */
export interface MediaView {
  id: string;
  chatId: string;
  telegramMessageId: number;
  kind: MediaKind;
  status: MediaStatus;
  description: string | null;
  /** `data:<mime>;base64,…` for a pending row with bytes, else null. */
  preview: string | null;
  createdAt: string;
  describedAt: string | null;
}
