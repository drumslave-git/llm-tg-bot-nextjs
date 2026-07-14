import { describe, expect, it } from "vitest";

import { formatGroupContext, formatKnownGroupLabel } from "./format";

describe("formatKnownGroupLabel", () => {
  it("uses the title when present", () => {
    expect(formatKnownGroupLabel({ title: "Family", chatId: "-100" })).toBe("Family");
  });

  it("falls back to the id when there is no title", () => {
    expect(formatKnownGroupLabel({ title: null, chatId: "-100" })).toBe("Group -100");
    expect(formatKnownGroupLabel({ title: "  ", chatId: "-100" })).toBe("Group -100");
  });
});

describe("formatGroupContext", () => {
  it("returns null when there are no members and no notes", () => {
    expect(formatGroupContext({ title: "Family", notes: null, members: [] })).toBeNull();
    expect(formatGroupContext({ title: "Family", notes: "   ", members: [] })).toBeNull();
  });

  it("lists members with their aliases and the group title", () => {
    const block = formatGroupContext({
      title: "Family",
      notes: null,
      members: [
        { label: "Ada L (@testuser)", aliases: ["Cap", "Chief"] },
        { label: "Bob", aliases: [] },
      ],
    });
    expect(block).toContain('You are chatting in the Telegram group "Family".');
    expect(block).toContain("- Ada L (@testuser) — also known as: Cap, Chief");
    expect(block).toContain("- Bob");
    // A member without aliases gets no "also known as" suffix.
    expect(block).not.toContain("- Bob —");
  });

  it("includes operator notes and works without a title", () => {
    const block = formatGroupContext({
      title: null,
      notes: "Keep replies casual.",
      members: [{ label: "Alice", aliases: [] }],
    });
    expect(block).toContain("You are chatting in a Telegram group.");
    expect(block).toContain("About this group: Keep replies casual.");
  });

  it("injects notes even when there are no members", () => {
    const block = formatGroupContext({ title: "Family", notes: "Private group.", members: [] });
    expect(block).toContain("About this group: Private group.");
    expect(block).not.toContain("Known participants");
  });
});
