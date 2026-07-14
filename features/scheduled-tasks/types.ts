/**
 * Client-safe shared types for scheduled tasks. Imported by the pure schedule
 * math, the server service/repository, the Route Handlers, and the dashboard UI —
 * so it must stay free of any server-only import.
 */

/** How a task repeats. */
export type ScheduleKind = "once" | "daily" | "weekly";

export const SCHEDULE_KINDS: ScheduleKind[] = ["once", "daily", "weekly"];

/** The schedule portion of a task (what the wall-clock math needs). */
export interface TaskSchedule {
  scheduleKind: ScheduleKind;
  /** Local time of day as `HH:MM` (24-hour) in the task timezone. */
  timeOfDay: string;
  /** Weekdays for `weekly`, 0=Sunday..6=Saturday. */
  weekdays?: number[] | null;
  /** Calendar date for `once` as `YYYY-MM-DD` in the task timezone. */
  runDate?: string | null;
}

/** A scheduled task as returned to clients (no secrets — all fields are safe). */
export interface ScheduledTask {
  id: string;
  chatId: string;
  threadId: number | null;
  createdByUserId: string | null;
  instruction: string;
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays: number[] | null;
  runDate: string | null;
  enabled: boolean;
  /** The last few delivered message texts (newest first), for wording variation. */
  recentDeliveries: string[];
  /** ISO timestamp of the last firing, or null. */
  lastRunAt: string | null;
  /** ISO timestamp of the next firing, or null when the task will not fire again. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}
