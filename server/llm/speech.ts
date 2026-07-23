import "server-only";

import { ApiError } from "@/lib/api-error";

import {
  createOpenAiClient,
  listModels,
  toLlmError,
  type LlmConnection,
} from "./client";

/**
 * Speech synthesis on an OpenAI-compatible `/v1/audio/speech` endpoint. Server-only.
 * Twin of `images.ts`: the connection comes from DB-backed settings
 * (`speech_base_url`/`speech_api_key`/`speech_model`/`speech_voice`, falling back
 * to the LLM connection), and the same client serves the Settings probe and the
 * voice-reply path.
 */

/** Synthesis is slower than chat token streaming but bounded by reply length. */
const SPEECH_TIMEOUT_MS = 120_000;

/** Short timeout for the Settings probe, which only lists models. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Fallback voice name when none is configured: OpenAI's default, which
 * OpenAI-compatible local servers (openedai-speech, kokoro) also map.
 */
export const DEFAULT_SPEECH_VOICE = "alloy";

/** A resolved speech connection: where to call, which model, and which voice. */
export interface SpeechRuntime extends LlmConnection {
  model: string;
  /** Voice name for the endpoint; null → {@link DEFAULT_SPEECH_VOICE}. */
  voice: string | null;
}

/**
 * Synthesize speech for a reply, returning MP3 bytes (the one response format
 * every OpenAI-compatible implementation serves; the caller transcodes to
 * OGG/Opus for Telegram). Throws a clean {@link ApiError} on provider/network
 * failure or an empty payload.
 */
export async function synthesizeSpeech(runtime: SpeechRuntime, input: string): Promise<Buffer> {
  try {
    const response = await createOpenAiClient(runtime).audio.speech.create(
      {
        model: runtime.model,
        voice: runtime.voice?.trim() || DEFAULT_SPEECH_VOICE,
        input,
        response_format: "mp3",
      },
      { timeout: SPEECH_TIMEOUT_MS },
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw ApiError.serviceUnavailable("Speech endpoint returned no audio data");
    }
    return bytes;
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** What a connection test learned about the configured speech endpoint. */
export interface SpeechProbe {
  model: string;
  /** How many models the endpoint advertises (context for the operator). */
  modelCount: number;
}

/**
 * Real probe of the speech configuration: calls the endpoint's model listing and
 * checks the configured model is actually served by it. Like the image probe it
 * deliberately does **not** synthesize — nothing about a voice reply can only be
 * learned by rendering one, and the model-listing check already proves the host
 * is reachable, the key is accepted, and the model id is not a typo.
 */
export async function probeSpeech(runtime: SpeechRuntime): Promise<SpeechProbe> {
  const models = await listModels(runtime, PROBE_TIMEOUT_MS);
  if (!models.includes(runtime.model)) {
    throw ApiError.badRequest(
      `Speech model "${runtime.model}" is not served by ${runtime.baseUrl}. ` +
        (models.length > 0
          ? `Available models: ${models.slice(0, 10).join(", ")}${models.length > 10 ? ", …" : ""}.`
          : "The endpoint advertises no models."),
    );
  }
  return { model: runtime.model, modelCount: models.length };
}
