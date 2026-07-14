import { describe, expect, it } from "vitest";

import {
  computeNextRun,
  describeSchedule,
  isValidTimezone,
  normalizeSchedule,
  normalizeTimeOfDay,
  normalizeWeekdays,
  parseRunDate,
  parseTimeOfDay,
  zonedWallClockToUtc,
} from "./schedule";

describe("parseTimeOfDay / normalizeTimeOfDay", () => {
  it("parses valid times and rejects bad ones", () => {
    expect(parseTimeOfDay("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("12:60")).toBeNull();
    expect(parseTimeOfDay("noon")).toBeNull();
  });

  it("normalizes to zero-padded HH:MM", () => {
    expect(normalizeTimeOfDay("9:5")).toBeNull(); // minutes must be 2 digits
    expect(normalizeTimeOfDay("9:05")).toBe("09:05");
    expect(normalizeTimeOfDay("07:00")).toBe("07:00");
  });
});

describe("parseRunDate / normalizeWeekdays", () => {
  it("parses ISO dates", () => {
    expect(parseRunDate("2026-07-14")).toEqual({ year: 2026, month: 7, day: 14 });
    expect(parseRunDate("2026-13-01")).toBeNull();
    expect(parseRunDate("14/07/2026")).toBeNull();
  });

  it("sorts, dedupes, and clamps weekdays", () => {
    expect(normalizeWeekdays([3, 1, 1, 5, 9, -1])).toEqual([1, 3, 5]);
    expect(normalizeWeekdays([])).toEqual([]);
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
  });
});

describe("zonedWallClockToUtc", () => {
  it("converts a wall-clock time to the correct UTC instant", () => {
    // 12:00 in UTC is 12:00Z.
    expect(zonedWallClockToUtc(2026, 1, 15, 12, 0, "UTC").toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
    // Berlin in January is UTC+1, so 12:00 local = 11:00Z.
    expect(zonedWallClockToUtc(2026, 1, 15, 12, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-01-15T11:00:00.000Z",
    );
    // Berlin in July is UTC+2 (DST), so 12:00 local = 10:00Z.
    expect(zonedWallClockToUtc(2026, 7, 15, 12, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-07-15T10:00:00.000Z",
    );
  });
});

describe("computeNextRun", () => {
  const from = new Date("2026-07-14T08:30:00.000Z"); // a Tuesday

  it("once: future date fires, past date does not", () => {
    expect(
      computeNextRun({ scheduleKind: "once", timeOfDay: "12:00", runDate: "2026-07-14" }, from, "UTC")
        ?.toISOString(),
    ).toBe("2026-07-14T12:00:00.000Z");
    expect(
      computeNextRun(
        { scheduleKind: "once", timeOfDay: "08:00", runDate: "2026-07-14" },
        from,
        "UTC",
      ),
    ).toBeNull();
  });

  it("daily: today if still ahead, else tomorrow", () => {
    expect(
      computeNextRun({ scheduleKind: "daily", timeOfDay: "12:00" }, from, "UTC")?.toISOString(),
    ).toBe("2026-07-14T12:00:00.000Z");
    expect(
      computeNextRun({ scheduleKind: "daily", timeOfDay: "08:00" }, from, "UTC")?.toISOString(),
    ).toBe("2026-07-15T08:00:00.000Z");
  });

  it("weekly: next matching weekday", () => {
    // from is Tuesday (2). Ask for Wednesday (3) → next day.
    expect(
      computeNextRun(
        { scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [3] },
        from,
        "UTC",
      )?.toISOString(),
    ).toBe("2026-07-15T09:00:00.000Z");
    // Ask for Tuesday (2) but the time already passed today → next Tuesday.
    expect(
      computeNextRun(
        { scheduleKind: "weekly", timeOfDay: "08:00", weekdays: [2] },
        from,
        "UTC",
      )?.toISOString(),
    ).toBe("2026-07-21T08:00:00.000Z");
    // No weekdays → never.
    expect(
      computeNextRun({ scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [] }, from, "UTC"),
    ).toBeNull();
  });

  it("returns null for an unparseable time", () => {
    expect(computeNextRun({ scheduleKind: "daily", timeOfDay: "??" }, from, "UTC")).toBeNull();
  });
});

describe("describeSchedule", () => {
  it("renders human summaries", () => {
    expect(describeSchedule({ scheduleKind: "daily", timeOfDay: "17:00" })).toBe(
      "every day at 17:00",
    );
    expect(
      describeSchedule({ scheduleKind: "weekly", timeOfDay: "9:00", weekdays: [1, 3, 5] }),
    ).toBe("every Mon, Wed, Fri at 09:00");
    expect(
      describeSchedule({ scheduleKind: "once", timeOfDay: "12:30", runDate: "2026-12-31" }),
    ).toBe("once on 2026-12-31 at 12:30");
  });
});

describe("normalizeSchedule", () => {
  it("normalizes each kind and rejects bad input", () => {
    expect(normalizeSchedule({ scheduleKind: "daily", timeOfDay: "9:00" })).toEqual({
      scheduleKind: "daily",
      timeOfDay: "09:00",
      weekdays: null,
      runDate: null,
    });
    expect(
      normalizeSchedule({ scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [5, 1, 1] }),
    ).toEqual({ scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [1, 5], runDate: null });
    expect(() => normalizeSchedule({ scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [] })).toThrow(
      /weekday/,
    );
    expect(() => normalizeSchedule({ scheduleKind: "once", timeOfDay: "09:00" })).toThrow(/date/);
    expect(() => normalizeSchedule({ scheduleKind: "daily", timeOfDay: "bad" })).toThrow(/HH:MM/);
  });
});
