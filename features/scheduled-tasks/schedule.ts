/**
 * Wall-clock schedule math for tasks, dependency-free via `Intl`.
 *
 * Tasks fire at a local time in a configured IANA timezone. These helpers convert
 * between a zone's wall-clock components and absolute UTC instants so the
 * scheduler can compute the next firing instant without a tz library. Pure and
 * client-safe (no server-only import) so the dashboard can describe/preview a
 * schedule with the exact same code the server schedules against.
 *
 * Grounded in the MVP's `features/tasks/schedule.ts` (the best-shaped MVP code) —
 * reused nearly verbatim, adapted to return `Date` instants.
 */

import type { ScheduleKind, TaskSchedule } from "./types";

const DAY_MS = 86_400_000;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Parse `HH:MM`; returns null when malformed or out of range. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Normalize `HH:MM` to zero-padded form, or null when invalid. */
export function normalizeTimeOfDay(value: string): string | null {
  const parsed = parseTimeOfDay(value);
  if (!parsed) return null;
  return `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
}

/** Parse `YYYY-MM-DD`; returns null when malformed. */
export function parseRunDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Sorted, de-duplicated weekday list filtered to 0..6. */
export function normalizeWeekdays(weekdays: readonly number[]): number[] {
  return [...new Set(weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
}

/** Whether a string is a valid IANA timezone name (per `Intl`). */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of a timezone at a given instant: zoneWallClock - utcWallClock. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - instant.getTime();
}

/** Convert wall-clock components in `timeZone` to an absolute UTC instant. */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  // First guess uses the offset at the naive instant, then refine once so DST
  // transition boundaries land on the correct side.
  const offset = zoneOffsetMs(new Date(wallAsUtc), timeZone);
  let utc = wallAsUtc - offset;
  const refined = zoneOffsetMs(new Date(utc), timeZone);
  if (refined !== offset) utc = wallAsUtc - refined;
  return new Date(utc);
}

/** Wall-clock calendar date of an instant in `timeZone`. */
export function zonedDate(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return { year: map.year, month: map.month, day: map.day };
}

/** Calendar weekday (0=Sun..6=Sat) for a Y-M-D date — independent of time. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Add `n` calendar days to a Y-M-D date, wrapping months/years. */
export function addCalendarDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day) + n * DAY_MS);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Next firing instant (UTC) at or after `from`, or `null` when the task will
 * never fire again (a spent `once` task or a `weekly` task with no days).
 */
export function computeNextRun(
  schedule: TaskSchedule,
  from: Date,
  timeZone: string,
): Date | null {
  const time = parseTimeOfDay(schedule.timeOfDay);
  if (!time) return null;

  if (schedule.scheduleKind === "once") {
    if (!schedule.runDate) return null;
    const date = parseRunDate(schedule.runDate);
    if (!date) return null;
    const instant = zonedWallClockToUtc(
      date.year,
      date.month,
      date.day,
      time.hour,
      time.minute,
      timeZone,
    );
    return instant.getTime() > from.getTime() ? instant : null;
  }

  const today = zonedDate(from, timeZone);

  if (schedule.scheduleKind === "daily") {
    const todayInstant = zonedWallClockToUtc(
      today.year,
      today.month,
      today.day,
      time.hour,
      time.minute,
      timeZone,
    );
    if (todayInstant.getTime() > from.getTime()) return todayInstant;
    const next = addCalendarDays(today.year, today.month, today.day, 1);
    return zonedWallClockToUtc(next.year, next.month, next.day, time.hour, time.minute, timeZone);
  }

  // weekly
  const days = normalizeWeekdays(schedule.weekdays ?? []);
  if (days.length === 0) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addCalendarDays(today.year, today.month, today.day, offset);
    if (!days.includes(weekdayOf(date.year, date.month, date.day))) continue;
    const instant = zonedWallClockToUtc(
      date.year,
      date.month,
      date.day,
      time.hour,
      time.minute,
      timeZone,
    );
    if (offset === 0 && instant.getTime() <= from.getTime()) continue;
    return instant;
  }
  return null;
}

/** Short human-readable schedule summary, e.g. "every day at 17:00". */
export function describeSchedule(schedule: TaskSchedule): string {
  const time = normalizeTimeOfDay(schedule.timeOfDay) ?? schedule.timeOfDay;
  switch (schedule.scheduleKind) {
    case "once":
      return `once on ${schedule.runDate ?? "?"} at ${time}`;
    case "daily":
      return `every day at ${time}`;
    case "weekly": {
      const days = normalizeWeekdays(schedule.weekdays ?? []);
      const labels = days.map((d) => WEEKDAY_LABELS[d]).join(", ");
      return `every ${labels || "?"} at ${time}`;
    }
  }
}

/**
 * Validate + normalize a raw schedule, throwing a plain `Error` with a
 * user-facing message on bad input. Shared by the service and the MCP tools so
 * the same rules apply everywhere. Returns canonical schedule fields.
 */
export function normalizeSchedule(input: {
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays?: number[] | null;
  runDate?: string | null;
}): { scheduleKind: ScheduleKind; timeOfDay: string; weekdays: number[] | null; runDate: string | null } {
  const timeOfDay = normalizeTimeOfDay(input.timeOfDay ?? "");
  if (!timeOfDay) {
    throw new Error("time must be in HH:MM 24-hour form");
  }

  if (input.scheduleKind === "weekly") {
    const weekdays = normalizeWeekdays(input.weekdays ?? []);
    if (weekdays.length === 0) {
      throw new Error("weekly tasks need at least one weekday (0=Sunday..6=Saturday)");
    }
    return { scheduleKind: "weekly", timeOfDay, weekdays, runDate: null };
  }

  if (input.scheduleKind === "once") {
    if (!input.runDate || !parseRunDate(input.runDate)) {
      throw new Error("once tasks need a date in YYYY-MM-DD form");
    }
    return { scheduleKind: "once", timeOfDay, weekdays: null, runDate: input.runDate.trim() };
  }

  return { scheduleKind: "daily", timeOfDay, weekdays: null, runDate: null };
}
