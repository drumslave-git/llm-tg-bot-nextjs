/**
 * Client-safe shared types for the browser-agent feature. Imported by the server
 * service/repository/runner, the Route Handlers, and the dashboard UI — so it
 * must stay free of any server-only import.
 */

/** Lifecycle of a run: queued → running → done | failed. */
export const BROWSER_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type BrowserRunStatus = (typeof BROWSER_RUN_STATUSES)[number];

/**
 * One download completed by a run (structural twin of the jsonb shape on
 * `browser_agent_runs.downloads`).
 */
export interface BrowserDownloadRecord {
  /** The page the file came from (the link the agent was on). */
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
  /** True when the file was small enough to also attach to the chat. */
  inline: boolean;
}

/** A browser-agent run as returned to clients (no secrets — all fields are safe). */
export interface BrowserAgentRun {
  id: string;
  /** Chat the run reports to, or null for a dashboard-started run. */
  chatId: string | null;
  threadId: number | null;
  createdByUserId: string | null;
  /** Whether the run was started by the owner (download tool enabled). */
  isOwner: boolean;
  goal: string;
  status: BrowserRunStatus;
  /** The agent's final report, or null while unfinished/failed. */
  report: string | null;
  /** Failure reason when `status = 'failed'`. */
  error: string | null;
  /** Browser actions performed. */
  steps: number;
  downloads: BrowserDownloadRecord[];
  /** Trace id of the run's execution trace, for Debug drill-down. */
  traceId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Run detail: the run plus which screenshots exist (served as images by seq). */
export interface BrowserAgentRunDetail extends BrowserAgentRun {
  /** Capture-order sequence numbers of stored screenshots. */
  screenshotSeqs: number[];
}
