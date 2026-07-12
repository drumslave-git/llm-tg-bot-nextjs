import { describe, expect, it } from "vitest";

import { matchUsersByReference, normalizeReference, type UserMatchCandidate } from "./match";

const alice: UserMatchCandidate = {
  username: "alice",
  firstName: "Alice",
  lastName: "Anderson",
  aliases: ["Boss"],
};
const bob: UserMatchCandidate = {
  username: "bobby",
  firstName: "Bob",
  lastName: null,
  aliases: [],
};
const aliceB: UserMatchCandidate = {
  username: "alicia",
  firstName: "Alice",
  lastName: "Brown",
  aliases: [],
};

describe("normalizeReference", () => {
  it("trims, strips a leading @, and lowercases", () => {
    expect(normalizeReference("  @Alice ")).toBe("alice");
    expect(normalizeReference("@@BOB")).toBe("bob");
  });
});

describe("matchUsersByReference", () => {
  it("matches by first name, @username, full name, and existing alias (case-insensitive)", () => {
    expect(matchUsersByReference([alice, bob], "alice")).toEqual([alice]);
    expect(matchUsersByReference([alice, bob], "@alice")).toEqual([alice]);
    expect(matchUsersByReference([alice, bob], "Alice Anderson")).toEqual([alice]);
    expect(matchUsersByReference([alice, bob], "boss")).toEqual([alice]);
    expect(matchUsersByReference([alice, bob], "BOBBY")).toEqual([bob]);
  });

  it("returns nothing when no candidate name matches", () => {
    expect(matchUsersByReference([alice, bob], "charlie")).toEqual([]);
    expect(matchUsersByReference([alice, bob], "  ")).toEqual([]);
  });

  it("returns every match when a reference is ambiguous", () => {
    // Two people share the first name "Alice".
    expect(matchUsersByReference([alice, aliceB, bob], "alice")).toEqual([alice, aliceB]);
  });

  it("does not match on a substring — only whole names", () => {
    expect(matchUsersByReference([alice], "ali")).toEqual([]);
  });
});
