import "server-only";

import { toFile } from "openai";

import { createOpenAiClient, toLlmError, type LlmConnection } from "./client";

/**
 * Speech-to-text on an OpenAI-compatible `/v1/audio/transcriptions` endpoint
 * (whisper.cpp server, speaches/faster-whisper, LocalAI…). Server-only. Twin of
 * `speech.ts`: the connection comes from DB-backed settings
 * (`transcription_base_url`/`transcription_api_key`/`transcription_model`,
 * falling back to the LLM connection), and the same client serves the Settings
 * probe and the voice-message path.
 */

/** Transcribing minutes of audio is slower than chat but bounded by the cap. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Short timeout for the Settings probe, which transcribes a fraction of a second. */
const PROBE_TIMEOUT_MS = 15_000;

/** A resolved transcription connection: where to call, and which model. */
export interface TranscriptionRuntime extends LlmConnection {
  model: string;
}

/** What a transcription call produced, shaped for trace recording. */
export interface TranscriptionResult {
  text: string;
  latencyMs: number;
  /** Raw response object returned by the endpoint (for Debug bodies). */
  responseBody: unknown;
}

/**
 * Transcribe WAV audio on the dedicated STT endpoint. Throws a clean `ApiError`
 * (via `toLlmError`) on provider/network failure.
 */
export async function transcribeAudio(
  runtime: TranscriptionRuntime,
  wav: Buffer,
): Promise<TranscriptionResult> {
  const start = Date.now();
  try {
    const response = await createOpenAiClient(runtime).audio.transcriptions.create(
      {
        model: runtime.model,
        file: await toFile(wav, "voice.wav", { type: "audio/wav" }),
      },
      { timeout: TRANSCRIBE_TIMEOUT_MS },
    );
    return {
      text: (response.text ?? "").trim(),
      latencyMs: Date.now() - start,
      responseBody: response,
    };
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** What a connection test learned about the configured transcription endpoint. */
export interface TranscriptionProbe {
  model: string;
  /** What the endpoint transcribed the probe silence as (usually empty). */
  text: string;
}

/**
 * Real probe of the transcription configuration: transcribes a fraction of a
 * second of generated silence. Unlike the image/speech probes a model listing
 * proves nothing here — whisper-class servers often serve
 * `/v1/audio/transcriptions` without `/v1/models` — and the silence call is
 * cheap, fast, and exercises exactly the request the voice path will make.
 */
export async function probeTranscription(
  runtime: TranscriptionRuntime,
  probeWav: Buffer,
): Promise<TranscriptionProbe> {
  try {
    const response = await createOpenAiClient(runtime).audio.transcriptions.create(
      {
        model: runtime.model,
        file: await toFile(probeWav, "probe.wav", { type: "audio/wav" }),
      },
      { timeout: PROBE_TIMEOUT_MS },
    );
    return { model: runtime.model, text: (response.text ?? "").trim() };
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}
