import { describe, expect, it } from "vitest";

import { buildVisionContent, mediaKindLabel, renderMediaSuffix, toImagePart } from "./format";
import type { MediaAnnotation } from "./types";

describe("mediaKindLabel", () => {
  it("maps kinds to human labels", () => {
    expect(mediaKindLabel("photo")).toBe("photo");
    expect(mediaKindLabel("image_document")).toBe("image");
    expect(mediaKindLabel("animation")).toBe("GIF");
  });
});

describe("renderMediaSuffix", () => {
  const base: MediaAnnotation = { kind: "photo", status: "pending", description: null };

  it("shows the description once described", () => {
    expect(
      renderMediaSuffix({ ...base, status: "described", description: "a red car" }),
    ).toBe(" [photo: a red car]");
  });

  it("shows a bare kind marker while pending", () => {
    expect(renderMediaSuffix(base)).toBe(" [photo]");
  });

  it("flags unavailable media", () => {
    expect(renderMediaSuffix({ ...base, status: "unavailable" })).toBe(" [photo unavailable]");
  });
});

describe("toImagePart / buildVisionContent", () => {
  it("builds an image_url data URL part", () => {
    expect(toImagePart({ base64: "ABC", mimeHint: "image/jpeg" })).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,ABC" },
    });
  });

  it("puts the text first, then one part per image", () => {
    const content = buildVisionContent("what is this?", [
      { base64: "A", mimeHint: "image/jpeg" },
      { base64: "B", mimeHint: "image/jpeg" },
    ]);
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content).toHaveLength(3);
  });

  it("stands in a default instruction when there is no text", () => {
    const content = buildVisionContent("   ", [{ base64: "A", mimeHint: "image/jpeg" }]);
    expect(content[0]).toEqual({ type: "text", text: "Respond to this image." });
  });
});
