import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getMediaByMessage,
  insertMedia,
} from "@/features/vision/server/repository";
import {
  describeAndStore,
  getMediaSuffixesForMessages,
} from "@/features/vision/server/service";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { getTraceDetail, listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

/**
 * Voice messages ride the vision media pipeline (`message_media`, kind `voice`);
 * these tests exercise the transcription dispatch inside `describeAndStore`
 * against real Postgres. The transcode step runs the real system ffmpeg (already
 * a project requirement for video frames), fed a generated PCM WAV so no fixture
 * files are needed.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

/** A minimal valid 0.1s silent mono PCM WAV, as base64 (ffmpeg decodes it fine). */
function tinyWavBase64(): string {
  const sampleRate = 8000;
  const samples = 800;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf.toString("base64");
}

async function seedVoice(over?: { telegramMessageId?: number; dataBase64?: string }) {
  return insertMedia(ctx.db, {
    id: crypto.randomUUID(),
    chatId: "5",
    telegramMessageId: over?.telegramMessageId ?? 70,
    kind: "voice",
    fileId: "voice-70",
    fileUniqueId: "vu70",
    mimeType: "audio/ogg",
    dataBase64: over?.dataBase64 ?? tinyWavBase64(),
    visionHint: null,
  });
}

function fakeComplete(content: string): ChatCompletionResult {
  return {
    content,
    model: "audio-model",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 12,
    requestBody: {},
    responseBody: { id: "cmpl-1", choices: [{ message: { content } }] },
  };
}

const TARGET = { baseUrl: "https://llm.example.com/v1", model: "omni-audio" };

describe("describeAndStore — voice dispatch", () => {
  it("transcribes a pending voice row via an input_audio turn and stores the transcript", async () => {
    await seedVoice();

    let seen: ChatMessage[] | null = null;
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 70 },
      {
        complete: async (messages) => {
          seen = messages;
          return fakeComplete("hello from the voice message");
        },
        target: TARGET,
      },
      ctx.db,
    );

    // The request was a transcription pass: strict system prompt + one audio part.
    const messages = seen! as ChatMessage[];
    expect(String(messages[0].content)).toContain("transcription engine");
    const parts = messages[1].content as Array<{
      type: string;
      input_audio?: { data: string; format: string };
    }>;
    const audio = parts.find((p) => p.type === "input_audio");
    expect(audio?.input_audio?.format).toBe("wav");
    expect((audio?.input_audio?.data.length ?? 0) > 0).toBe(true);

    // Transcript stored as the description; bytes dropped.
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("hello from the voice message");
    expect(result?.dataBase64).toBeNull();

    // History reads it exactly like other media annotations.
    const suffixes = await getMediaSuffixesForMessages("5", [70], ctx.db);
    expect(suffixes.get(70)).toBe(" [voice message: hello from the voice message]");

    // Traced under the voice feature, not vision.
    const voiceTraces = await listTraces({ feature: "voice" });
    expect(voiceTraces.traces[0]?.status).toBe("success");
    expect(voiceTraces.traces[0]?.action).toBe("transcribe");
    const visionTraces = await listTraces({ feature: "vision" });
    expect(visionTraces.traces).toHaveLength(0);

    // The trace names what was actually called (endpoint + model), carries the
    // full request with the audio bytes redacted to a size marker, and records
    // the provider's raw response body verbatim.
    const detail = await getTraceDetail(voiceTraces.traces[0]!.id);
    const request = detail?.events.find((e) => e.type === "llm_request");
    const requestData = request?.data as {
      endpoint?: string;
      model?: string;
      messages?: Array<{ content: unknown }>;
    };
    expect(requestData.endpoint).toBe(TARGET.baseUrl);
    expect(requestData.model).toBe(TARGET.model);
    const audioPart = (
      requestData.messages?.[1]?.content as Array<{ input_audio?: { data: string } }>
    ).find((p) => p.input_audio);
    expect(audioPart?.input_audio?.data).toMatch(/^<\d+ bytes>$/);
    const response = detail?.events.find((e) => e.type === "llm_response");
    expect(response?.data).toEqual({
      id: "cmpl-1",
      choices: [{ message: { content: "hello from the voice message" } }],
    });
  });

  it("prefers a wired dedicated STT endpoint over the chat model, with raw-body trace events", async () => {
    await seedVoice({ telegramMessageId: 75 });

    let completeCalled = false;
    let sttWav: Buffer | null = null;
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 75 },
      {
        complete: async () => {
          completeCalled = true;
          return fakeComplete("unused — the STT path must win");
        },
        target: TARGET,
        transcribe: async (wav) => {
          sttWav = wav;
          return {
            text: "spoken via whisper",
            latencyMs: 20,
            responseBody: { text: "spoken via whisper" },
          };
        },
        transcribeTarget: { baseUrl: "https://whisper.example.com/v1", model: "large-v3" },
      },
      ctx.db,
    );

    expect(completeCalled).toBe(false);
    expect((sttWav as Buffer | null)?.length ?? 0).toBeGreaterThan(0);
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("spoken via whisper");

    const traces = await listTraces({ feature: "voice" });
    const detail = await getTraceDetail(traces.traces[0]!.id);
    const request = detail?.events.find((e) => e.message === "transcription request");
    expect(request?.data).toMatchObject({
      endpoint: "https://whisper.example.com/v1",
      model: "large-v3",
    });
    const response = detail?.events.find((e) => e.message === "transcription response");
    expect(response?.data).toEqual({ text: "spoken via whisper" });
  });

  it("stores '(no speech)' terminally so the backfill never loops on silent audio", async () => {
    await seedVoice({ telegramMessageId: 71 });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 71 },
      { complete: async () => fakeComplete("[no speech]") },
      ctx.db,
    );
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("(no speech)");
  });

  it("leaves the row pending (for the backfill retry) when the audio cannot be transcoded", async () => {
    // Garbage bytes: ffmpeg cannot decode them, the transcode throws, the trace fails.
    await seedVoice({ telegramMessageId: 72, dataBase64: Buffer.from("junk").toString("base64") });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 72 },
      { complete: async () => fakeComplete("unused") },
      ctx.db,
    );
    expect(result).toBeNull();
    const row = await getMediaByMessage(ctx.db, "5", 72);
    expect(row?.status).toBe("pending");
    const traces = await listTraces({ feature: "voice" });
    expect(traces.traces[0]?.status).toBe("error");
  });
});
