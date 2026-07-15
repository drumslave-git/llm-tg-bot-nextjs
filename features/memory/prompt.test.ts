import { describe, expect, it } from "vitest";

import {
  buildGeneralReconcileRequest,
  buildUserMergeRequest,
  parseGeneralDecision,
  parseMergedDocument,
} from "./prompt";

/**
 * The nightly job's whole decision surface is pure, so its riskiest behavior —
 * what happens when the model returns something wrong — is testable without a
 * model or a database. Both parsers are written to fail *closed*: an unusable
 * response must leave memory untouched, never destroy or corrupt it.
 */

describe("buildUserMergeRequest", () => {
  it("names the person and shows the existing document with the incoming notes", () => {
    const request = buildUserMergeRequest({
      label: "Ada",
      existing: ["Lives in Porto.", "Prefers short answers."],
      incoming: ["Moved to Lisbon."],
    });
    expect(request).toContain("Ada");
    expect(request).toContain("Lives in Porto.");
    expect(request).toContain("Prefers short answers.");
    expect(request).toContain("- Moved to Lisbon.");
  });

  it("says so explicitly when the person has no memory yet", () => {
    const request = buildUserMergeRequest({ label: "Ada", existing: [], incoming: ["Likes rye."] });
    expect(request).toContain("(nothing known yet)");
  });
});

describe("parseMergedDocument", () => {
  it("returns the merged facts as lines", () => {
    const parsed = parseMergedDocument('{"memory": "Lives in Lisbon.\\nPrefers short answers."}');
    expect(parsed).toEqual(["Lives in Lisbon.", "Prefers short answers."]);
  });

  it("tolerates code fences and prose around the JSON", () => {
    const parsed = parseMergedDocument('Sure!\n```json\n{"memory": "Likes rye bread."}\n```');
    expect(parsed).toEqual(["Likes rye bread."]);
  });

  it("strips bullet characters the model adds despite being told not to", () => {
    const parsed = parseMergedDocument('{"memory": "- Likes rye.\\n* Dislikes small talk."}');
    expect(parsed).toEqual(["Likes rye.", "Dislikes small talk."]);
  });

  it("returns nothing for an unparseable response, so the caller leaves memory alone", () => {
    expect(parseMergedDocument("I could not do that.")).toEqual([]);
    expect(parseMergedDocument('{"wrong_key": "Likes rye."}')).toEqual([]);
  });

  it('treats a literal "none" as no document rather than storing the word', () => {
    expect(parseMergedDocument('{"memory": "none"}')).toEqual([]);
    expect(parseMergedDocument('{"memory": ""}')).toEqual([]);
  });
});

describe("buildGeneralReconcileRequest", () => {
  it("offers the candidates by id", () => {
    const request = buildGeneralReconcileRequest({
      note: "Standup moved to 10:00.",
      candidates: [{ id: "abc", content: "Standup is at 09:30." }],
      });
    expect(request).toContain("Standup moved to 10:00.");
    expect(request).toContain("[abc] Standup is at 09:30.");
  });

  it("says the store is empty when there is nothing to compare against", () => {
    const request = buildGeneralReconcileRequest({ note: "Standup is at 10:00.", candidates: [] });
    expect(request).toContain("(the store is empty — there is nothing similar)");
  });
});

describe("parseGeneralDecision", () => {
  it("reads an insert", () => {
    expect(parseGeneralDecision('{"action":"insert","content":"Standup is at 10:00."}', [])).toEqual(
      { action: "insert", content: "Standup is at 10:00." },
    );
  });

  it("reads a skip", () => {
    expect(parseGeneralDecision('{"action":"skip","content":"","replaces":[]}', ["a"])).toEqual({
      action: "skip",
    });
  });

  it("reads a replace, keeping only the ids it was actually offered", () => {
    const decision = parseGeneralDecision(
      '{"action":"replace","content":"Standup is at 10:00.","replaces":["a","hallucinated"]}',
      ["a", "b"],
    );
    expect(decision).toEqual({
      action: "replace",
      content: "Standup is at 10:00.",
      replaces: ["a"],
    });
  });

  it("downgrades a replace that supersedes nothing real to an insert, deleting nothing", () => {
    const decision = parseGeneralDecision(
      '{"action":"replace","content":"Standup is at 10:00.","replaces":["ghost"]}',
      ["a"],
    );
    expect(decision).toEqual({ action: "insert", content: "Standup is at 10:00." });
  });

  it("rejects an unusable response rather than acting on it", () => {
    expect(parseGeneralDecision("no json here", ["a"])).toBeNull();
    // insert/replace with no content would store an empty fact
    expect(parseGeneralDecision('{"action":"insert","content":""}', [])).toBeNull();
    expect(parseGeneralDecision('{"action":"nonsense","content":"x y"}', [])).toBeNull();
  });
});
