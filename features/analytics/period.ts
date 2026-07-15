/**
 * Pure bucket math for the analytics charts — dependency-free via `Intl`, so it
 * is client-safe and directly unit-testable.
 *
 * The period selector is **day / week / month / all-time**, and it drives every
 * metric. A chart is "the last N buckets up to now" at the chosen granularity,
 * bucketed by the operator's wall clock (not UTC). The **exact same** bucket-key
 * format is produced here in JS (to build the dense, gap-free x-axis) and by
 * Postgres `to_char(date_trunc(...))` in the repository (to group the values) — the
 * two must agree, which the unit tests pin. Weeks are ISO weeks (Monday start),
 * matching Postgres `date_trunc('week', …)`; the week's key is its Monday's date.
 */

import { addCalendarDays, zonedWallClockToUtc } from "@/features/scheduled-tasks/schedule";

import type { Granularity } from "./types";

/** How many buckets a chart shows by default per granularity. */
export const DEFAULT_BUCKET_COUNT: Record<Granularity, number> = {
  day: 30,
  week: 26,
  month: 24,
  all: 1,
};

/** Upper bound on buckets a caller may request, so a query can't fan out unbounded. */
export const MAX_BUCKET_COUNT = 400;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

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
export function truncUnit(granularity: Granularity): "day" | "week" | "month" | null {
  return granularity === "all" ? null : granularity;
}

/**
 * The Postgres `to_char` format string matching {@link bucketKey}. Applied to
 * `date_trunc(unit, ts at time zone tz)` it yields the identical string this
 * module builds in JS. Week uses the same date form as day — the difference is the
 * `date_trunc` unit (week truncates to its Monday).
 */
export function bucketFormat(granularity: Granularity): string {
  switch (granularity) {
    case "day":
    case "week":
      return "YYYY-MM-DD";
    case "month":
      return "YYYY-MM";
    case "all":
      return "all";
  }
}

/** Weekday 0=Sun..6=Sat for a Y/M/D date. */
function weekdayOfYmd(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The Monday (ISO week start) of the week containing a Y/M/D date. */
function mondayOf(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const back = (weekdayOfYmd(year, month, day) + 6) % 7;
  return addCalendarDays(year, month, day, -back);
}

/** The bucket key for wall-clock parts at a granularity. */
export function bucketKey(parts: ZonedParts, granularity: Granularity): string {
  switch (granularity) {
    case "day":
      return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    case "week": {
      const m = mondayOf(parts.year, parts.month, parts.day);
      return `${m.year}-${pad2(m.month)}-${pad2(m.day)}`;
    }
    case "month":
      return `${parts.year}-${pad2(parts.month)}`;
    case "all":
      return "all";
  }
}

/** The bucket key an instant falls into, in `timeZone`. */
export function bucketKeyOfInstant(instant: Date, granularity: Granularity, timeZone: string): string {
  return bucketKey(zonedParts(instant, timeZone), granularity);
}

/** The Monday-date bucket key for a `YYYY-MM-DD` day string. */
export function weekBucketOf(dateStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const m = mondayOf(y, mo, d);
  return `${m.year}-${pad2(m.month)}-${pad2(m.day)}`;
}

/** Add `n` days to a `YYYY-MM-DD` string, returning a `YYYY-MM-DD` string. */
export function addDaysToDateStr(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const r = addCalendarDays(y, mo, d, n);
  return `${r.year}-${pad2(r.month)}-${pad2(r.day)}`;
}

/** The start-of-bucket parts for the bucket the given parts fall in. */
function bucketStart(parts: ZonedParts, granularity: Granularity): ZonedParts {
  switch (granularity) {
    case "day":
      return { ...parts, hour: 0 };
    case "week": {
      const m = mondayOf(parts.year, parts.month, parts.day);
      return { ...m, hour: 0 };
    }
    case "month":
      return { year: parts.year, month: parts.month, day: 1, hour: 0 };
    case "all":
      return { ...parts };
  }
}

/** Step a bucket-start one bucket earlier (calendar-aware). */
function stepBack(parts: ZonedParts, granularity: Granularity): ZonedParts {
  switch (granularity) {
    case "day": {
      const d = addCalendarDays(parts.year, parts.month, parts.day, -1);
      return { ...d, hour: 0 };
    }
    case "week": {
      const d = addCalendarDays(parts.year, parts.month, parts.day, -7);
      return { ...d, hour: 0 };
    }
    case "month":
      return parts.month === 1
        ? { year: parts.year - 1, month: 12, day: 1, hour: 0 }
        : { year: parts.year, month: parts.month - 1, day: 1, hour: 0 };
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
    cursor = stepBack(cursor, granularity);
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
