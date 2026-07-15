/**
 * Pure bucket math for the analytics charts — dependency-free via `Intl`, so it
 * is client-safe and directly unit-testable.
 *
 * A chart is "the last N buckets up to now" at a chosen granularity, bucketed by
 * the operator's wall clock (not UTC), matching how the rest of the app dates
 * things (`chat_summaries`, scheduled tasks). The **exact same** bucket-key format
 * is produced here in JS (to build the dense, gap-free x-axis) and by Postgres
 * `to_char(date_trunc(...))` in the repository (to group the values) — the two
 * must agree, which is what {@link bucketKeyOfInstant} and the SQL format string
 * guarantee together, and what the unit tests pin.
 */

import { addCalendarDays, zonedWallClockToUtc } from "@/features/scheduled-tasks/schedule";

import type { Granularity } from "./types";

/** How many buckets a chart shows by default per granularity. */
export const DEFAULT_BUCKET_COUNT: Record<Granularity, number> = {
  hour: 48,
  day: 90,
  month: 24,
  year: 10,
  all: 1,
};

/** Upper bound on buckets a caller may request, so a query can't fan out unbounded. */
export const MAX_BUCKET_COUNT = 400;

/** Wall-clock components of an instant in a timezone, including the hour. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

const HOUR_MS = 3_600_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Wall-clock Y/M/D/H of an instant in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return { year: map.year, month: map.month, day: map.day, hour: map.hour };
}

/** The `date_trunc` unit for a granularity (null for `all`, which has no unit). */
export function truncUnit(granularity: Granularity): "hour" | "day" | "month" | "year" | null {
  return granularity === "all" ? null : granularity;
}

/**
 * The Postgres `to_char` format string matching {@link bucketKey}. Applied to
 * `date_trunc(unit, ts at time zone tz)` it yields the identical string this
 * module builds in JS.
 */
export function bucketFormat(granularity: Granularity): string {
  switch (granularity) {
    case "hour":
      return "YYYY-MM-DD HH24:MI";
    case "day":
      return "YYYY-MM-DD";
    case "month":
      return "YYYY-MM";
    case "year":
      return "YYYY";
    case "all":
      return "all";
  }
}

/** The bucket key for wall-clock parts at a granularity. */
export function bucketKey(parts: ZonedParts, granularity: Granularity): string {
  switch (granularity) {
    case "hour":
      return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:00`;
    case "day":
      return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    case "month":
      return `${parts.year}-${pad2(parts.month)}`;
    case "year":
      return `${parts.year}`;
    case "all":
      return "all";
  }
}

/** The bucket key an instant falls into, in `timeZone`. */
export function bucketKeyOfInstant(instant: Date, granularity: Granularity, timeZone: string): string {
  return bucketKey(zonedParts(instant, timeZone), granularity);
}

/** The start-of-bucket parts for the bucket the given parts fall in. */
function bucketStart(parts: ZonedParts, granularity: Granularity): ZonedParts {
  switch (granularity) {
    case "hour":
      return { ...parts };
    case "day":
      return { ...parts, hour: 0 };
    case "month":
      return { year: parts.year, month: parts.month, day: 1, hour: 0 };
    case "year":
      return { year: parts.year, month: 1, day: 1, hour: 0 };
    case "all":
      return { ...parts };
  }
}

/** Step a bucket-start one bucket earlier (calendar-aware, DST-safe for hours). */
function stepBack(parts: ZonedParts, granularity: Granularity, timeZone: string): ZonedParts {
  switch (granularity) {
    case "hour": {
      const instant = zonedWallClockToUtc(parts.year, parts.month, parts.day, parts.hour, 0, timeZone);
      return zonedParts(new Date(instant.getTime() - HOUR_MS), timeZone);
    }
    case "day": {
      const d = addCalendarDays(parts.year, parts.month, parts.day, -1);
      return { ...d, hour: 0 };
    }
    case "month":
      return parts.month === 1
        ? { year: parts.year - 1, month: 12, day: 1, hour: 0 }
        : { year: parts.year, month: parts.month - 1, day: 1, hour: 0 };
    case "year":
      return { year: parts.year - 1, month: 1, day: 1, hour: 0 };
    case "all":
      return { ...parts };
  }
}

export interface BucketWindow {
  /** Bucket keys, oldest → newest. */
  keys: string[];
  /** UTC instant of the first bucket's start — the inclusive lower bound for SQL. */
  startUtc: Date;
}

/**
 * The last `count` bucket keys ending at the bucket `now` falls in, plus the UTC
 * instant the window starts at (for the SQL `sent_at >= startUtc` filter). `all`
 * is a single `"all"` bucket over the whole history (`startUtc` = epoch).
 */
export function bucketWindow(
  granularity: Granularity,
  opts: { now: Date; timeZone: string; count?: number },
): BucketWindow {
  if (granularity === "all") {
    return { keys: ["all"], startUtc: new Date(0) };
  }

  const requested = opts.count ?? DEFAULT_BUCKET_COUNT[granularity];
  const count = Math.max(1, Math.min(requested, MAX_BUCKET_COUNT));

  let cursor = bucketStart(zonedParts(opts.now, opts.timeZone), granularity);
  const partsNewestFirst: ZonedParts[] = [];
  for (let i = 0; i < count; i += 1) {
    partsNewestFirst.push(cursor);
    cursor = stepBack(cursor, granularity, opts.timeZone);
  }
  const partsOldestFirst = partsNewestFirst.reverse();
  const first = partsOldestFirst[0];

  return {
    keys: partsOldestFirst.map((p) => bucketKey(p, granularity)),
    startUtc: zonedWallClockToUtc(first.year, first.month, first.day, first.hour, 0, opts.timeZone),
  };
}

/** Align a sparse `key → value` map onto the dense `keys` axis, filling gaps with 0. */
export function densify(keys: string[], byBucket: Map<string, number>): number[] {
  return keys.map((k) => byBucket.get(k) ?? 0);
}
