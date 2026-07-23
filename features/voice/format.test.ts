import { describe, expect, it } from "vitest";

import { buildTranscribeMessages, parseTranscript, toAudioPart } from "./format";
import { NO_SPEECH_MARKER, VOICE_TRANSCRIBE_SYSTEM } from "./prompt";

describe("toAudioPart", () => {
  it("builds an input_audio content part carrying the base64 and format", () => {
    expect(toAudioPart("QUJD", "wav")).toEqual({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "wav" },
    });
  });
});

describe("buildTranscribeMessages", () => {
  it("pairs the strict transcribe system prompt with one audio user turn", () => {
    const messages = buildTranscribeMessages("QUJD", "wav");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: VOICE_TRANSCRIBE_SYSTEM });
    const content = messages[1].content as { type: string }[];
    expect(messages[1].role).toBe("user");
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "wav" },
    });
  });
});

describe("parseTranscript", () => {
  it("trims the model output", () => {
    expect(parseTranscript("  hello there \n")).toBe("hello there");
  });

  it("maps the no-speech marker to empty (case-insensitive)", () => {
    expect(parseTranscript(NO_SPEECH_MARKER)).toBe("");
    expect(parseTranscript("[No Speech]")).toBe("");
  });

  it("keeps a transcript that merely contains the marker words", () => {
    expect(parseTranscript("he said no speech today")).toBe("he said no speech today");
  });
});
