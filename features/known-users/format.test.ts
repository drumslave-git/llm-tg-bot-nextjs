import { describe, expect, it } from "vitest";

import { formatKnownUserLabel, formatUserContext } from "./format";

describe("formatKnownUserLabel", () => {
  it("combines name and @username when both are present", () => {
    expect(
      formatKnownUserLabel({ firstName: "George", lastName: "T", username: "drumslave", userId: "1" }),
    ).toBe("George T (@drumslave)");
  });

  it("falls back to name, then @username, then id", () => {
    expect(formatKnownUserLabel({ firstName: "Ann", lastName: null, username: null, userId: "1" })).toBe(
      "Ann",
    );
    expect(formatKnownUserLabel({ firstName: null, lastName: null, username: "ann", userId: "1" })).toBe(
      "@ann",
    );
    expect(formatKnownUserLabel({ firstName: null, lastName: null, username: null, userId: "1" })).toBe(
      "User 1",
    );
  });
});

describe("formatUserContext", () => {
  it("names who the bot is talking to and points at the alias tool", () => {
    const block = formatUserContext({ label: "George (@drumslave)", aliases: [] });
    expect(block).toContain("private, one-on-one Telegram chat with George (@drumslave).");
    // No aliases → no "also known as" clause.
    expect(block).not.toContain("also known as");
    // The tool reference uses the same label so the model can call it.
    expect(block).toContain('update_user_aliases tool, referencing them as "George (@drumslave)"');
  });

  it("lists known aliases when present", () => {
    const block = formatUserContext({ label: "George", aliases: ["Жора", "Гоша"] });
    expect(block).toContain("They are also known as: Жора, Гоша.");
  });
});
