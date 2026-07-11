import { describe, expect, it } from "vitest";

import { formatDuration, formatTime, formatTimestamp } from "./format";

describe("formatTimestamp", () => {
  it("formats an ISO instant as UTC without locale drift", () => {
    expect(formatTimestamp("2026-07-11T14:23:05.123Z")).toBe("2026-07-11 14:23:05 UTC");
  });

  it("returns the input unchanged when unparseable", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("formatTime", () => {
  it("formats time-of-day in UTC", () => {
    expect(formatTime("2026-07-11T09:05:07.000Z")).toBe("09:05:07");
  });
});

describe("formatDuration", () => {
  it("returns null when there is no end time", () => {
    expect(formatDuration("2026-07-11T14:23:05.000Z", null)).toBeNull();
  });

  it("formats sub-second, seconds, and minute ranges", () => {
    const start = "2026-07-11T14:00:00.000Z";
    expect(formatDuration(start, "2026-07-11T14:00:00.842Z")).toBe("842ms");
    expect(formatDuration(start, "2026-07-11T14:00:03.200Z")).toBe("3.2s");
    expect(formatDuration(start, "2026-07-11T14:01:04.000Z")).toBe("1m 4s");
  });

  it("returns null for a negative span", () => {
    expect(
      formatDuration("2026-07-11T14:00:05.000Z", "2026-07-11T14:00:00.000Z"),
    ).toBeNull();
  });
});
