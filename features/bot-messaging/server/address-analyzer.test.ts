import { describe, expect, it } from "vitest";

import { BOT } from "@/test/__mocks__/telegram";
import { buildAnalyzerMessages, parseAnalyzerVerdict } from "./address-analyzer";

describe("buildAnalyzerMessages", () => {
  const messages = buildAnalyzerMessages({
    bot: BOT,
    chatType: "supergroup",
    text: "  Ари, привет  ",
  });

  it("states the rules as a system message and the message to judge as the user turn", () => {
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("other_alphabet");
  });

  it("gives the model the name it is looking for, the chat type, and the text", () => {
    expect(messages[1].content).toContain(`Bot display name: ${BOT.displayName}`);
    expect(messages[1].content).toContain(`Bot username: @${BOT.username}`);
    expect(messages[1].content).toContain("Chat type: supergroup");
    expect(messages[1].content).toContain("Ари, привет");
  });
});

describe("parseAnalyzerVerdict", () => {
  it("treats every present form of the name as addressed", () => {
    for (const match of ["exact", "other_alphabet", "inflected"]) {
      const verdict = parseAnalyzerVerdict(`{"name_match": "${match}"}`);
      expect(verdict).toEqual({
        addressed: true,
        nameMatch: match,
        reason: `display name appears as ${match}`,
      });
    }
  });

  it("treats an absent name as not addressed", () => {
    expect(parseAnalyzerVerdict('{"name_match": "absent"}')).toEqual({
      addressed: false,
      nameMatch: "absent",
      reason: "display name absent",
    });
  });

  it("reads an answer the model wrapped in fences or prose", () => {
    const raw = 'Sure!\n```json\n{"name_match": "inflected"}\n```';
    expect(parseAnalyzerVerdict(raw).addressed).toBe(true);
  });

  it("accepts a classification the model shouted or padded", () => {
    expect(parseAnalyzerVerdict('{"name_match": " Exact "}').nameMatch).toBe("exact");
  });

  // An answer we cannot read must not become a reply: the bot stays out of a
  // conversation it was never shown to be part of.
  it("stays silent on an answer it cannot read", () => {
    for (const raw of ["", "no idea", "{}", '{"name_match": "maybe"}', '{"name_match": 3}']) {
      expect(parseAnalyzerVerdict(raw)).toEqual({
        addressed: false,
        nameMatch: null,
        reason: "unreadable analyzer answer",
      });
    }
  });
});
