import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import { detectMessageMedia, findReplyMediaMessage, messageHasVisionMedia } from "./detect";

/** Minimal message factory — only the fields detection reads. Loose input so
 * reply chains can nest full `Message`s (the SDK types `reply_to_message` as the
 * narrower `ReplyMessage`). */
function msg(partial: Record<string, unknown>): Message {
  return { message_id: 1, date: 0, chat: { id: 1, type: "private" }, ...partial } as unknown as Message;
}

describe("detectMessageMedia", () => {
  it("returns the largest photo size", () => {
    const detected = detectMessageMedia(
      msg({
        photo: [
          { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
          { file_id: "big", file_unique_id: "b", width: 1280, height: 1280 },
        ],
      }),
    );
    expect(detected).toEqual({ kind: "photo", fileId: "big", fileUniqueId: "b", visionHint: null });
  });

  it("decodes a static sticker directly and hints its emoji/pack", () => {
    const detected = detectMessageMedia(
      msg({
        sticker: {
          file_id: "stk",
          file_unique_id: "u",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          emoji: "😀",
          set_name: "Pack",
        },
      }),
    );
    expect(detected?.kind).toBe("sticker");
    expect(detected?.fileId).toBe("stk");
    expect(detected?.visionHint).toContain("😀");
    expect(detected?.visionHint).toContain("Pack");
  });

  it("uses the thumbnail for an animated/video sticker", () => {
    const detected = detectMessageMedia(
      msg({
        sticker: {
          file_id: "anim",
          file_unique_id: "u",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          thumbnail: { file_id: "thumb", file_unique_id: "t", width: 128, height: 128 },
        },
      }),
    );
    expect(detected?.fileId).toBe("thumb");
  });

  it("reads an image document", () => {
    const detected = detectMessageMedia(
      msg({ document: { file_id: "doc", file_unique_id: "d", mime_type: "image/png" } }),
    );
    expect(detected).toEqual({
      kind: "image_document",
      fileId: "doc",
      fileUniqueId: "d",
      visionHint: null,
    });
  });

  it("decodes a real image/gif animation directly", () => {
    const detected = detectMessageMedia(
      msg({
        animation: {
          file_id: "gif",
          file_unique_id: "g",
          width: 320,
          height: 240,
          duration: 2,
          mime_type: "image/gif",
        },
      }),
    );
    expect(detected).toEqual({ kind: "animation", fileId: "gif", fileUniqueId: "g", visionHint: null });
  });

  it("uses the frame thumbnail for an mp4 video", () => {
    const detected = detectMessageMedia(
      msg({
        video: {
          file_id: "vid",
          file_unique_id: "v",
          width: 1920,
          height: 1080,
          duration: 5,
          mime_type: "video/mp4",
          thumbnail: { file_id: "frame", file_unique_id: "f", width: 320, height: 180 },
        },
      }),
    );
    expect(detected).toEqual({ kind: "video", fileId: "frame", fileUniqueId: "f", visionHint: null });
  });

  it("ignores a non-image document (e.g. a PDF)", () => {
    const detected = detectMessageMedia(
      msg({ document: { file_id: "pdf", file_unique_id: "p", mime_type: "application/pdf" } }),
    );
    expect(detected).toBeNull();
  });

  it("returns null for a text-only message", () => {
    expect(detectMessageMedia(msg({ text: "hello" }))).toBeNull();
    expect(messageHasVisionMedia(msg({ text: "hello" }))).toBe(false);
  });
});

describe("findReplyMediaMessage", () => {
  it("finds the first media message up the reply chain", () => {
    const image = msg({
      message_id: 10,
      photo: [{ file_id: "p", file_unique_id: "p", width: 100, height: 100 }],
    });
    const middle = msg({ message_id: 11, text: "hmm", reply_to_message: image });
    const current = msg({ message_id: 12, text: "what is this?", reply_to_message: middle });
    expect(findReplyMediaMessage(current)?.message_id).toBe(10);
  });

  it("returns null when no ancestor carries media", () => {
    const parent = msg({ message_id: 2, text: "hi" });
    const current = msg({ message_id: 3, text: "yo", reply_to_message: parent });
    expect(findReplyMediaMessage(current)).toBeNull();
  });
});
