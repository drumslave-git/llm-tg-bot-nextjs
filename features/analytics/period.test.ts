import { describe, expect, it } from "vitest";

import { bucketFormat, bucketKeyOfInstant, bucketWindow, densify, truncUnit } from "./period";

describe("bucketWindow", () => {
  it("produces the last N day buckets, oldest first, with the right start", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const { keys, startUtc } = bucketWindow("day", { now, timeZone: "UTC", count: 3 });
    expect(keys).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
    expect(startUtc.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("produces hour buckets aligned to the hour", () => {
    const now = new Date("2026-07-15T10:30:00Z");
    const { keys } = bucketWindow("hour", { now, timeZone: "UTC", count: 3 });
    expect(keys).toEqual(["2026-07-15 08:00", "2026-07-15 09:00", "2026-07-15 10:00"]);
  });

  it("produces month and year buckets with calendar stepping", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(bucketWindow("month", { now, timeZone: "UTC", count: 3 }).keys).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
    expect(bucketWindow("year", { now, timeZone: "UTC", count: 2 }).keys).toEqual(["2025", "2026"]);
  });

  it("collapses `all` into a single bucket over all history", () => {
    const { keys, startUtc } = bucketWindow("all", { now: new Date(), timeZone: "UTC" });
    expect(keys).toEqual(["all"]);
    expect(startUtc.getTime()).toBe(0);
  });

  it("buckets by the operator's wall clock, not UTC", () => {
    // 02:00Z on 2026-07-15 is still 2026-07-14 (22:00) in New York.
    const now = new Date("2026-07-15T02:00:00Z");
    const { keys } = bucketWindow("day", { now, timeZone: "America/New_York", count: 1 });
    expect(keys).toEqual(["2026-07-14"]);
  });
});

describe("bucketKeyOfInstant", () => {
  it("matches the period granularity forms", () => {
    const at = new Date("2026-07-15T10:00:00Z");
    expect(bucketKeyOfInstant(at, "month", "UTC")).toBe("2026-07");
    expect(bucketKeyOfInstant(at, "year", "UTC")).toBe("2026");
    expect(bucketKeyOfInstant(at, "all", "UTC")).toBe("all");
  });
});

describe("sql/js format agreement", () => {
  it("pins the to_char format strings the repository groups by", () => {
    expect(bucketFormat("hour")).toBe("YYYY-MM-DD HH24:MI");
    expect(bucketFormat("day")).toBe("YYYY-MM-DD");
    expect(bucketFormat("month")).toBe("YYYY-MM");
    expect(bucketFormat("year")).toBe("YYYY");
    expect(truncUnit("hour")).toBe("hour");
    expect(truncUnit("all")).toBeNull();
  });
});

describe("densify", () => {
  it("fills gaps with zero and aligns to the key axis", () => {
    const keys = ["a", "b", "c"];
    expect(densify(keys, new Map([["a", 5], ["c", 9]]))).toEqual([5, 0, 9]);
  });
});
