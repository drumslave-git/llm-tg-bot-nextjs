import "server-only";

import type { Message } from "@grammyjs/types";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { FEATURES } from "@/lib/features";
import { llmUsageOf, sanitizeMessagesForTrace, type ChatCompletionResult, type ChatMessage } from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import {
  getLlmRuntime,
  getTranscriptionRuntime,
} from "@/features/settings/server/service";
import { buildTranscribeMessages, parseTranscript } from "@/features/voice/format";
import { chatCompletion } from "@/server/llm/client";
import { transcribeAudio, type TranscriptionResult } from "@/server/llm/transcription";
import { toWavForTranscription } from "@/server/media/audio";

import { detectMessageMedia } from "../detect";
import { frameSequenceHint, renderMediaSuffix } from "../format";
import type { DetectedMedia, ImagePayload, MediaAnnotation, MediaKind, MediaView } from "../types";
import { buildDescribeMessages } from "./describe";
import { VIDEO_FRAME_COUNT, extractVideoFrames } from "./frames";
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
 *    stored (bytes in `media_blobs`) with `status = 'pending'`.
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
 * The loadable image(s) for a detected media, plus the describe `hint` stored on
 * the row and the reply `note` shown to the model this turn. A still image is one
 * image; a video/GIF is the ordered sequence of frames sampled with ffmpeg (the
 * Telegram single-frame thumbnail is the fallback when extraction is
 * unavailable). Best-effort — resolves null when nothing can be read.
 */
interface LoadedMedia {
  images: ImagePayload[];
  /** Raw audio bytes for a voice message (stored as-is, transcribed later). */
  audio: { base64: string; mimeHint: string } | null;
  /** Stored on the row + fed to the describe pass (sticker emoji / frame-sequence note). */
  hint: string | null;
  /** Injected into the current reply turn so the model reads it in context (video/GIF only). */
  note: string | null;
}

/** Sample a video/GIF into an ordered sequence of normalized frames, or null on failure. */
async function loadVideoFrames(
  token: string,
  detected: DetectedMedia,
): Promise<LoadedMedia | null> {
  const raw = await downloadTelegramFile(token, detected.fileId);
  if (!raw) return null;
  const input = Buffer.from(raw.base64, "base64");
  const frames = await extractVideoFrames(input, {
    count: VIDEO_FRAME_COUNT,
    durationSec: detected.durationSec,
  });
  if (frames.length === 0) return null;
  // Normalize each frame to a bounded JPEG so it is sent full-resolution.
  const images = await Promise.all(
    frames.map((frame) => normalizeImageForChat(frame.toString("base64"))),
  );
  const kind = detected.kind === "animation" ? "animation" : "video";
  const hint = frameSequenceHint(kind, images.length);
  return { images, audio: null, hint, note: hint };
}

/** Resolve a detected media to loadable images/audio + hints. Best-effort — null on failure. */
async function loadDetectedMedia(
  token: string,
  detected: DetectedMedia,
): Promise<LoadedMedia | null> {
  // A voice message stores its bytes as-is (OGG/Opus) — no normalization; the
  // transcode to a model-readable format happens at transcription time.
  if (detected.isAudio) {
    const raw = await downloadTelegramFile(token, detected.fileId).catch(() => null);
    if (!raw) return null;
    return {
      images: [],
      audio: { base64: raw.base64, mimeHint: raw.mimeHint },
      hint: detected.visionHint,
      note: null,
    };
  }

  if (!detected.isVideo) {
    const image = await loadImage(token, detected.fileId);
    return image ? { images: [image], audio: null, hint: detected.visionHint, note: null } : null;
  }

  // Video/GIF: sample frames with ffmpeg; on any failure fall back to the
  // Telegram single-frame thumbnail so the media is still recognized.
  const sequence = await loadVideoFrames(token, detected).catch(() => null);
  if (sequence) return sequence;

  if (detected.thumbnailFileId) {
    const thumb = await loadImage(token, detected.thumbnailFileId);
    if (thumb) {
      const kind = detected.kind === "animation" ? "animation" : "video";
      const hint = frameSequenceHint(kind, 1);
      return { images: [thumb], audio: null, hint, note: hint };
    }
  }
  return null;
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
): Promise<{ images: ImagePayload[]; kind: MediaKind; note: string | null } | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;

  const loaded = await loadDetectedMedia(params.token, detected);
  if (!loaded) {
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

  // A still image stores its single frame; a video/GIF stores the whole frame
  // sequence (its first frame doubles as the dashboard preview); a voice message
  // stores its raw audio (played back on the dashboard while pending).
  const isSequence = loaded.images.length > 1;
  await insertMedia(db, {
    id: crypto.randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: detected.kind,
    fileId: detected.fileId,
    fileUniqueId: detected.fileUniqueId,
    mimeType: loaded.audio ? loaded.audio.mimeHint : loaded.images[0].mimeHint,
    dataBase64: loaded.audio ? loaded.audio.base64 : loaded.images[0].base64,
    frames: isSequence ? loaded.images.map((image) => image.base64) : null,
    visionHint: loaded.hint,
  }).catch(() => null);
  publishEvent(FEATURE.realtimeTopic);

  return { images: loaded.images, kind: detected.kind, note: loaded.note };
}

/**
 * Provenance hint stored on a bot-generated image's media row.
 *
 * Deliberately states *that* the bot drew the image and **not** what it was asked
 * to draw. The prompt is available at the call site and it is tempting to pass it
 * along, but a describer told what the picture is supposed to contain writes a
 * paraphrase of the prompt instead of a recognition of the image — and diffusion
 * models routinely miss or mangle parts of a prompt. The whole reason the
 * generated image is stored as ordinary media is to learn what actually came out,
 * so the hint must not answer the question the describer is being asked.
 */
const GENERATED_IMAGE_HINT =
  "This image was generated by the bot itself, in response to a request in this chat.";

/**
 * Store an image the bot generated and just sent, as ordinary media — the same
 * `message_media` row, lifecycle, and describer that user-sent pictures get. It
 * lands `pending` and is recognized either by the backfill job or, like any
 * pending row, on demand; on describe its bytes are dropped and the description is
 * what remains in history. That is what lets a later turn know what the bot drew.
 *
 * Bytes are already in hand (the provider returned them), so unlike
 * {@link ingestMessageMedia} there is nothing to download — but they are still put
 * through the same normalization, so a stored generated image is byte-for-byte the
 * same kind of thing as a stored received one.
 *
 * Passive and untraced (the stored row is the record), and best-effort: a failure
 * to store must not undo an image the user can already see in their chat.
 */
export async function ingestGeneratedImage(
  params: {
    chatId: string;
    telegramMessageId: number;
    fileId: string;
    fileUniqueId?: string | null;
    base64: string;
  },
  db: DrizzleDb = getDb(),
): Promise<MediaRecord | null> {
  const normalized = await normalizeImageForChat(params.base64).catch(() => null);
  if (!normalized) return null;
  const record = await insertMedia(db, {
    id: crypto.randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: "photo",
    fileId: params.fileId,
    fileUniqueId: params.fileUniqueId ?? null,
    mimeType: normalized.mimeHint,
    dataBase64: normalized.base64,
    visionHint: GENERATED_IMAGE_HINT,
  }).catch(() => null);
  publishEvent(FEATURE.realtimeTopic);
  return record;
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
): Promise<{ images: ImagePayload[]; kind: MediaKind; note: string | null } | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;

  const stored = await getMediaByMessage(db, params.chatId, params.message.message_id).catch(
    () => null,
  );

  // A replied-to voice message resolves to its transcript (the chat model reads
  // text, not audio, in the reply turn). Transcription is eager, so the stored
  // row almost always has one; without it there is nothing useful to attach.
  if (detected.isAudio) {
    if (stored?.description) {
      return {
        images: [],
        kind: detected.kind,
        note: `Transcript of that voice message: ${stored.description}`,
      };
    }
    return null;
  }

  // Reuse the stored image(s) — a photo, or a video's full frame sequence — when
  // present, so a reply to old media needs no re-download or re-extraction.
  const storedImages = storedMediaImages(stored);
  if (storedImages) {
    return { images: storedImages, kind: detected.kind, note: stored?.visionHint ?? null };
  }

  const loaded = await loadDetectedMedia(params.token, detected);
  return loaded ? { images: loaded.images, kind: detected.kind, note: loaded.note } : null;
}

/** The stored image sequence for a media row (frames for a video, else the single image). */
function storedMediaImages(media: MediaRecord | null): ImagePayload[] | null {
  if (!media) return null;
  // A voice row's bytes are audio — never an image sequence.
  if (media.kind === "voice") return null;
  if (media.frames && media.frames.length > 0) {
    return media.frames.map((base64) => ({ base64, mimeHint: "image/jpeg" }));
  }
  if (media.dataBase64) {
    return [{ base64: media.dataBase64, mimeHint: media.mimeType ?? "image/jpeg" }];
  }
  return null;
}

/** Collaborators for the describe pass; injected so it is unit-testable. */
export interface DescribeDeps {
  /** Run the describe completion; returns the text plus usage/model for tracing. */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /**
   * Where `complete` sends the request (base URL + model id), recorded on the
   * trace's request event — the operator must be able to see which endpoint and
   * model a describe/transcribe actually hit, especially when it fails.
   */
  target?: { baseUrl: string; model: string };
  /**
   * Dedicated STT for voice rows (`/v1/audio/transcriptions`), present when the
   * operator configured a transcription endpoint. When set, voice transcription
   * uses it **instead of** the chat model's `input_audio` path (user decision:
   * support both, whisper preferred when configured).
   */
  transcribe?: (wav: Buffer) => Promise<TranscriptionResult>;
  /** Where `transcribe` sends the request, recorded like {@link target}. */
  transcribeTarget?: { baseUrl: string; model: string };
}

/**
 * The real {@link DescribeDeps}, resolved from DB settings at call time: the
 * chat runtime for describes (and the `input_audio` transcription fallback),
 * plus the dedicated transcription endpoint when one is configured. Null when
 * the LLM is not configured. Shared by the live message path and the backfill
 * scheduler so the two can never resolve differently.
 */
export async function resolveDescribeDeps(): Promise<DescribeDeps | null> {
  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return null;
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };
  const stt = await getTranscriptionRuntime().catch(() => null);
  return {
    complete: (messages) => chatCompletion(conn, { model: runtime.model, messages }),
    target: { baseUrl: runtime.baseUrl, model: runtime.model },
    ...(stt
      ? {
          transcribe: (wav: Buffer) => transcribeAudio(stt, wav),
          transcribeTarget: { baseUrl: stt.baseUrl, model: stt.model },
        }
      : {}),
  };
}

/**
 * Describe a message's stored media and drop its bytes. Dispatches by kind: an
 * image/video is captioned by the vision model (traced under `vision`/`describe`);
 * a voice message is transcribed by the audio-capable chat model (traced under
 * `voice`/`transcribe`) with the transcript stored as its description. A no-op
 * (skipped) when the message has no pending media. Best-effort: on failure the
 * row stays `pending` for the backfill job to retry.
 */
export async function describeAndStore(
  params: { chatId: string; telegramMessageId: number },
  deps: DescribeDeps,
  db: DrizzleDb = getDb(),
): Promise<MediaRecord | null> {
  const media = await getMediaByMessage(db, params.chatId, params.telegramMessageId).catch(
    () => null,
  );
  const isVoice = media?.kind === "voice";
  const feature = isVoice ? FEATURES["voice"] : FEATURE;
  const trace = await startTrace(
    {
      feature: feature.id,
      action: isVoice ? "transcribe" : "describe",
      trigger: {
        kind: "telegram",
        actor: params.chatId,
        correlationId: `${params.chatId}:${params.telegramMessageId}`,
      },
      inputSummary: `media on message ${params.telegramMessageId}`,
    }
  );
  try {
    if (isVoice) {
      const audioBase64 = media?.status === "pending" ? media.dataBase64 : null;
      if (!media || !audioBase64) {
        await trace.skip("no pending voice message to transcribe");
        return null;
      }

      // OGG/Opus → 16 kHz mono WAV: what both transcription paths consume. A
      // transcode failure leaves the row pending.
      const wav = await toWavForTranscription(Buffer.from(audioBase64, "base64"));

      let rawText: string;
      if (deps.transcribe) {
        // Dedicated STT endpoint (whisper-class), preferred when configured.
        await trace.event({
          type: "external_call",
          message: "transcription request",
          data: {
            ...(deps.transcribeTarget
              ? { endpoint: deps.transcribeTarget.baseUrl, model: deps.transcribeTarget.model }
              : {}),
            wavBytes: wav.length,
          },
        });
        const result = await deps.transcribe(wav);
        await trace.event({
          type: "output",
          message: "transcription response",
          // The provider's raw response body, verbatim (full-raw-bodies rule).
          data: result.responseBody ?? { text: result.text },
        });
        rawText = result.text;
      } else {
        // Fallback: the audio-capable chat model via an `input_audio` part.
        const messages = buildTranscribeMessages(wav.toString("base64"), "wav");
        // The whole request as sent — endpoint, model, and the full
        // (byte-redacted) body — so a failing transcription names what was
        // actually called.
        await trace.event({
          type: "llm_request",
          message: "transcribe request",
          data: {
            ...(deps.target ? { endpoint: deps.target.baseUrl, model: deps.target.model } : {}),
            messages: sanitizeMessagesForTrace(messages),
          },
        });

        const result = await deps.complete(messages);
        await trace.event({
          type: "llm_response",
          message: "transcribe response",
          // The provider's raw response body, verbatim (full-raw-bodies rule).
          data: result.responseBody ?? { content: result.content },
          usage: { ...llmUsageOf(result), callKind: "voice-transcribe" },
        });
        rawText = result.content;
      }

      // "(no speech)" is terminal on purpose: leaving a speechless recording
      // pending would make the backfill re-transcribe it forever.
      const transcript = parseTranscript(rawText) || "(no speech)";
      const updated = await markDescribed(db, media.id, transcript);
      await trace.event({
        type: "db",
        message: "voice message transcribed",
        data: { chars: transcript.length },
      });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: transcript,
        relatedIds: { [feature.relatedIdsKey ?? FEATURE.relatedIdsKey]: [media.id] },
      });
      return updated ?? media;
    }

    const images = media?.status === "pending" ? storedMediaImages(media) : null;
    if (!media || !images) {
      await trace.skip("no pending media to describe");
      return null;
    }

    // A video/GIF describes from its ordered frame sequence; a still image from
    // its single frame. The hint tells the model the frames are one clip in order.
    const messages = buildDescribeMessages(images, media.visionHint);
    await trace.event({
      type: "llm_request",
      message: "describe request",
      data: {
        ...(deps.target ? { endpoint: deps.target.baseUrl, model: deps.target.model } : {}),
        messages: sanitizeMessagesForTrace(messages),
      },
    });

    const result = await deps.complete(messages);
    await trace.event({
      type: "llm_response",
      message: "describe response",
      // The provider's raw response body, verbatim (full-raw-bodies rule).
      data: result.responseBody ?? { content: result.content },
      usage: { ...llmUsageOf(result), callKind: "vision-describe" },
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

/**
 * Rendered media suffixes (` [photo: <description>]` / ` [photo]`) keyed by
 * Telegram message id — how a media message reads as text. Shared by the reply
 * transcript window and the `/history` display so both show the same annotation.
 */
export async function getMediaSuffixesForMessages(
  chatId: string,
  telegramMessageIds: number[],
  db: DrizzleDb = getDb(),
): Promise<Map<number, string>> {
  const annotations = await getMediaAnnotations(db, chatId, telegramMessageIds);
  const suffixes = new Map<number, string>();
  for (const [id, annotation] of annotations) {
    const suffix = renderMediaSuffix(annotation);
    if (suffix) suffixes.set(id, suffix);
  }
  return suffixes;
}

/** Map a stored row to its dashboard view (bytes → preview only while pending). */
function toView(record: MediaRecord): MediaView {
  const pending = record.status === "pending";
  // A video/GIF exposes all its sampled frames; a still image exposes one preview.
  const frames =
    pending && record.frames && record.frames.length > 0
      ? record.frames.map((base64) => `data:image/jpeg;base64,${base64}`)
      : null;
  return {
    id: record.id,
    chatId: record.chatId,
    telegramMessageId: record.telegramMessageId,
    kind: record.kind,
    status: record.status,
    description: record.description,
    preview:
      pending && record.dataBase64
        ? `data:${record.mimeType ?? "image/jpeg"};base64,${record.dataBase64}`
        : null,
    frames,
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
