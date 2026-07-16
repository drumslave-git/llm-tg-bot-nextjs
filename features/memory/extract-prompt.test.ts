import { describe, expect, it } from "vitest";

import type { SummarizableMessage } from "@/features/history/summary";

import {
  buildExtractionRequest,
  EXTRACTION_SYSTEM,
  parseExtractedNotes,
  participantsOf,
  toExtractionLine,
} from "./extract-prompt";
import { MAX_FACT_LENGTH } from "./prompt";

function message(overrides: Partial<SummarizableMessage> = {}): SummarizableMessage {
  return {
    telegramMessageId: 1,
    role: "user",
    content: "hello",
    label: "Alice",
    userId: "1001",
    sentAt: "2026-07-13T10:00:00.000Z",
    ...overrides,
  };
}

const STORABLE = new Set(["1001", "1002"]);

describe("toExtractionLine", () => {
  it("carries the speaker's id, since a display name is not what memory is keyed by", () => {
    expect(toExtractionLine(message({ content: "I moved to Lisbon" }), STORABLE)).toBe(
      "[#1] [2026-07-13T10:00:00.000Z] Alice [id:1001]: I moved to Lisbon",
    );
  });

  it("shows the bot's own rows without an id, so no fact can be attributed to it", () => {
    expect(
      toExtractionLine(message({ label: "Bot", userId: null, role: "assistant" }), STORABLE),
    ).toBe("[#1] [2026-07-13T10:00:00.000Z] Bot: hello");
  });

  it("hides the id of a speaker who is not a known user — it could never be stored against", () => {
    expect(
      toExtractionLine(message({ label: "User 9999", userId: "9999" }), STORABLE),
    ).toBe("[#1] [2026-07-13T10:00:00.000Z] User 9999: hello");
  });
});

describe("participantsOf", () => {
  it("lists each person once, in first-seen order, ignoring the bot", () => {
    const participants = participantsOf([
      message({ userId: "1001", label: "Alice" }),
      message({ userId: null, label: "Bot", role: "assistant" }),
      message({ userId: "1002", label: "Bob" }),
      message({ userId: "1001", label: "Alice" }),
    ]);
    expect(participants).toEqual([
      { userId: "1001", label: "Alice" },
      { userId: "1002", label: "Bob" },
    ]);
  });
});

describe("buildExtractionRequest", () => {
  const alice = { userId: "1001", label: "Alice" };
  const bob = { userId: "1002", label: "Bob" };

  it("offers the roster the model must pick user ids from", () => {
    const request = buildExtractionRequest(
      "2026-07-13",
      [
        message({ userId: "1001", label: "Alice", content: "I'm a vet" }),
        message({ telegramMessageId: 2, userId: "1002", label: "Bob", content: "nice" }),
      ],
      [alice, bob],
    );
    expect(request).toContain("Date of this conversation: 2026-07-13.");
    expect(request).toContain("[id:1001] Alice");
    expect(request).toContain("[id:1002] Bob");
    expect(request).toContain("[#1] [2026-07-13T10:00:00.000Z] Alice [id:1001]: I'm a vet");
  });

  it("tells the model to keep a fact about an unrostered person as general, naming them", () => {
    expect(EXTRACTION_SYSTEM).toContain("Never drop such a fact");
    expect(EXTRACTION_SYSTEM).toContain("do not set user_id");
  });

  /**
   * The bug the first live run found: history holds speakers who were never
   * registered as known users (imported history does this routinely). Offering
   * their ids made the model extract a perfectly good fact that `saveMemoryNote`
   * then refused with "No known person has id …".
   */
  it("keeps an unstorable speaker in the transcript but off the roster", () => {
    const request = buildExtractionRequest(
      "2026-07-13",
      [
        message({ userId: "1001", label: "Alice", content: "I'm a vet" }),
        message({ telegramMessageId: 2, userId: "9999", label: "User 9999", content: "I live in Porto" }),
      ],
      [alice],
    );
    // Offered.
    expect(request).toContain("[id:1001] Alice");
    // Not offered — the model has no id to attribute a fact to.
    expect(request).not.toContain("[id:9999]");
    // But still readable: what they say is evidence about the people who are storable.
    expect(request).toContain("User 9999: I live in Porto");
  });

  it("points a day with nobody storable at general scope, rather than showing an empty roster", () => {
    const request = buildExtractionRequest(
      "2026-07-13",
      [message({ userId: null, label: "Bot", role: "assistant" })],
      [],
    );
    expect(request).toContain("use scope 'general' for every fact");
  });
});

describe("parseExtractedNotes", () => {
  const ids = ["1001", "1002"];

  it("keeps well-formed user and general facts", () => {
    const notes = parseExtractedNotes(
      JSON.stringify({
        facts: [
          { scope: "user", user_id: "1001", content: "Alice is a veterinarian in Lisbon." },
          { scope: "general", content: "The team deploys on Thursdays." },
        ],
      }),
      ids,
    );
    expect(notes).toEqual([
      { scope: "user", userId: "1001", content: "Alice is a veterinarian in Lisbon." },
      { scope: "general", content: "The team deploys on Thursdays." },
    ]);
  });

  it("tolerates a fenced/chatty response, like the sibling memory passes", () => {
    const notes = parseExtractedNotes(
      'Sure!\n```json\n{"facts":[{"scope":"general","content":"Standups are at 9."}]}\n```',
      ids,
    );
    expect(notes).toEqual([{ scope: "general", content: "Standups are at 9." }]);
  });

  it("drops a user fact whose id was never offered, so nothing is filed under a stranger", () => {
    const notes = parseExtractedNotes(
      JSON.stringify({
        facts: [
          { scope: "user", user_id: "9999", content: "Someone lives in Porto." },
          { scope: "user", user_id: "1002", content: "Bob studies law." },
        ],
      }),
      ids,
    );
    expect(notes).toEqual([{ scope: "user", userId: "1002", content: "Bob studies law." }]);
  });

  it("drops a user fact with no id at all", () => {
    expect(
      parseExtractedNotes(
        JSON.stringify({ facts: [{ scope: "user", content: "Someone likes cats." }] }),
        ids,
      ),
    ).toEqual([]);
  });

  it("drops unknown scopes, empty content, and over-long content", () => {
    const notes = parseExtractedNotes(
      JSON.stringify({
        facts: [
          { scope: "chat", content: "not a real scope" },
          { scope: "general", content: "   " },
          { scope: "general", content: "x".repeat(MAX_FACT_LENGTH + 1) },
          { scope: "general", content: "This one is fine." },
        ],
      }),
      ids,
    );
    expect(notes).toEqual([{ scope: "general", content: "This one is fine." }]);
  });

  it("de-duplicates a fact the pass proposed twice, ignoring case and spacing", () => {
    const notes = parseExtractedNotes(
      JSON.stringify({
        facts: [
          { scope: "user", user_id: "1001", content: "Alice has a dog named Rex." },
          { scope: "user", user_id: "1001", content: "  alice has a dog named rex.  " },
        ],
      }),
      ids,
    );
    expect(notes).toHaveLength(1);
  });

  it("keeps the same sentence for two different people", () => {
    const notes = parseExtractedNotes(
      JSON.stringify({
        facts: [
          { scope: "user", user_id: "1001", content: "Lives in Lisbon." },
          { scope: "user", user_id: "1002", content: "Lives in Lisbon." },
        ],
      }),
      ids,
    );
    expect(notes).toHaveLength(2);
  });

  it("returns nothing for an empty harvest — a quiet day is a correct answer", () => {
    expect(parseExtractedNotes(JSON.stringify({ facts: [] }), ids)).toEqual([]);
  });

  it("returns nothing rather than throwing when the model returns junk", () => {
    expect(parseExtractedNotes("I could not find any facts.", ids)).toEqual([]);
    expect(parseExtractedNotes(JSON.stringify({ facts: "lots" }), ids)).toEqual([]);
    expect(parseExtractedNotes("", ids)).toEqual([]);
  });
});
