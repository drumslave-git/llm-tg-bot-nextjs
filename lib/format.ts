/**
 * Shared, deterministic formatters for operator-facing timestamps and durations.
 *
 * Kept dependency-free and locale/timezone-stable (UTC) so the same string
 * renders identically on the server and the client — no hydration drift — and is
 * consistent across every feature's Debug and dashboard views.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/** ISO instant → `YYYY-MM-DD HH:mm:ss UTC`. Returns the input unchanged if unparseable. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** Time only (`HH:mm:ss`) for dense event timelines where the date is redundant. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Elapsed time between two ISO instants, human-readable (`842ms`, `3.2s`, `1m 4s`). */
export function formatDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
