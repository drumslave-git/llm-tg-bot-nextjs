import { describe, expect, it } from "vitest";

import {
  addDaysToDateStr,
  bucketFormat,
  bucketKeyOfInstant,
  bucketWindow,
  densify,
  truncUnit,
  weekBucketOf,
} from "./period";

describe("bucketWindow", () => {
  it("produces the last N day buckets, oldest first, with the right start", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const { keys, startUtc } = bucketWindow("day", { now, timeZone: "UTC", count: 3 });
    expect(keys).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
    expect(startUtc.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("produces ISO week buckets keyed by their Monday", () => {
    // 2026-07-15 is a Wednesday; its week's Monday is 2026-07-13.
    const now = new Date("2026-07-15T10:00:00Z");
    const { keys, startUtc } = bucketWindow("week", { now, timeZone: "UTC", count: 3 });
    expect(keys).toEqual(["2026-06-29", "2026-07-06", "2026-07-13"]);
    expect(startUtc.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("produces month buckets with calendar stepping", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(bucketWindow("month", { now, timeZone: "UTC", count: 3 }).keys).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("collapses `all` into a single bucket over all history", () => {
    const { keys, startUtc } = bucketWindow("all", { now: new Date(), timeZone: "UTC" });
    expect(keys).toEqual(["all"]);
    expect(startUtc.getTime()).toBe(0);
  });

  it("buckets by the operator's wall clock, not UTC", () => {
    const now = new Date("2026-07-15T02:00:00Z"); // 2026-07-14 22:00 in New York
    const { keys } = bucketWindow("day", { now, timeZone: "America/New_York", count: 1 });
    expect(keys).toEqual(["2026-07-14"]);
  });
});

describe("week helpers", () => {
  it("weekBucketOf returns the Monday of a day", () => {
    expect(weekBucketOf("2026-07-15")).toBe("2026-07-13"); // Wed → Mon
    expect(weekBucketOf("2026-07-13")).toBe("2026-07-13"); // Mon → itself
    expect(weekBucketOf("2026-07-19")).toBe("2026-07-13"); // Sun → that Mon
  });

  it("addDaysToDateStr wraps months", () => {
    expect(addDaysToDateStr("2026-07-13", 6)).toBe("2026-07-19");
    expect(addDaysToDateStr("2026-07-29", 5)).toBe("2026-08-03");
  });
});

describe("bucketKeyOfInstant", () => {
  it("matches the granularity forms", () => {
    const at = new Date("2026-07-15T10:00:00Z");
    expect(bucketKeyOfInstant(at, "day", "UTC")).toBe("2026-07-15");
    expect(bucketKeyOfInstant(at, "week", "UTC")).toBe("2026-07-13");
    expect(bucketKeyOfInstant(at, "month", "UTC")).toBe("2026-07");
    expect(bucketKeyOfInstant(at, "all", "UTC")).toBe("all");
  });
});

describe("sql/js format agreement", () => {
  it("pins the to_char format strings the repository groups by", () => {
    expect(bucketFormat("day")).toBe("YYYY-MM-DD");
    expect(bucketFormat("week")).toBe("YYYY-MM-DD");
    expect(bucketFormat("month")).toBe("YYYY-MM");
    expect(truncUnit("week")).toBe("week");
    expect(truncUnit("all")).toBeNull();
  });
});

describe("densify", () => {
  it("fills gaps with zero and aligns to the key axis", () => {
    expect(densify(["a", "b", "c"], new Map([["a", 5], ["c", 9]]))).toEqual([5, 0, 9]);
  });
});
