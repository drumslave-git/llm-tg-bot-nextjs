import type { ChatContentPart } from "@/server/llm/client";

import type { ImagePayload, MediaAnnotation, MediaKind } from "./types";

/**
 * Pure formatting helpers for vision: how media reads in a transcript, how an
 * image becomes a model content part, and human labels. No server imports, so
 * they are unit-testable in isolation.
 */

const KIND_LABEL: Record<MediaKind, string> = {
  photo: "photo",
  sticker: "sticker",
  image_document: "image",
  animation: "GIF",
  video: "video",
};

/** Human label for a media kind. */
export function mediaKindLabel(kind: MediaKind): string {
  return KIND_LABEL[kind] ?? "image";
}

/**
 * The suffix appended to a transcript line for a media message, so a past image
 * turn reads as text. `[photo: <description>]` once described; `[photo]` while
 * still pending (bytes not yet captioned); `[photo unavailable]` when it could
 * not be read.
 */
export function renderMediaSuffix(annotation: MediaAnnotation): string {
  const label = mediaKindLabel(annotation.kind);
  if (annotation.status === "described" && annotation.description) {
    return ` [${label}: ${annotation.description}]`;
  }
  if (annotation.status === "unavailable") {
    return ` [${label} unavailable]`;
  }
  return ` [${label}]`;
}

/** Build the OpenAI `image_url` content part for a normalized image. */
export function toImagePart(image: ImagePayload): ChatContentPart {
  return { type: "image_url", image_url: { url: `data:${image.mimeHint};base64,${image.base64}` } };
}

/**
 * Assemble a vision `user` turn: the turn's text followed by one image part per
 * image. When there is no text, a minimal instruction stands in so the model has
 * something to answer.
 */
export function buildVisionContent(text: string, images: ImagePayload[]): ChatContentPart[] {
  const prompt = text.trim() || "Respond to this image.";
  return [{ type: "text", text: prompt }, ...images.map(toImagePart)];
}
