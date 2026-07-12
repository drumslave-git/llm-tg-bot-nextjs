import { describe, expect, it } from "vitest";

import { collectUserIds, startOfUtcDay, toPriorTurn } from "./format";
import type { ChatMessageRecord } from "./repository";

function record(over: Partial<ChatMessageRecord>): ChatMessageRecord {
  return {
    id: 1,
    chatId: "5",
    telegramMessageId: 10,
    role: "user",
    userId: "100",
    content: "hello",
    replyToMessageId: null,
    sentAt: "2026-07-12T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-07-12T10:00:00.000Z",
    ...over,
  };
}

describe("startOfUtcDay", () => {
  it("truncates to midnight UTC", () => {
    const start = startOfUtcDay(new Date("2026-07-12T15:37:42.123Z"));
    expect(start.toISOString()).toBe("2026-07-12T00:00:00.000Z");
  });

  it("keeps an instant already at midnight", () => {
    const start = startOfUtcDay(new Date("2026-07-12T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-12T00:00:00.000Z");
  });
});

describe("toPriorTurn", () => {
  it("maps an assistant row to an assistant message with no prefix", () => {
    const turn = toPriorTurn(record({ role: "assistant", userId: null, content: "hi back" }), {
      isGroup: true,
      speakerLabels: new Map([["100", "Alice"]]),
    });
    expect(turn).toEqual({ role: "assistant", content: "hi back" });
  });

  it("leaves a private user turn unprefixed", () => {
    const turn = toPriorTurn(record({ content: "hey" }), { isGroup: false });
    expect(turn).toEqual({ role: "user", content: "hey" });
  });

  it("prefixes a group user turn with the resolved speaker label", () => {
    const turn = toPriorTurn(record({ content: "hey", userId: "100" }), {
      isGroup: true,
      speakerLabels: new Map([["100", "Alice (@alice)"]]),
    });
    expect(turn).toEqual({ role: "user", content: "Alice (@alice): hey" });
  });

  it("falls back to no prefix in a group when the speaker is unknown", () => {
    const turn = toPriorTurn(record({ content: "hey", userId: "999" }), {
      isGroup: true,
      speakerLabels: new Map([["100", "Alice"]]),
    });
    expect(turn).toEqual({ role: "user", content: "hey" });
  });
});

describe("collectUserIds", () => {
  it("returns distinct non-null sender ids", () => {
    const ids = collectUserIds([
      record({ userId: "1" }),
      record({ userId: "2" }),
      record({ userId: "1" }),
      record({ role: "assistant", userId: null }),
    ]);
    expect(ids.sort()).toEqual(["1", "2"]);
  });
});
