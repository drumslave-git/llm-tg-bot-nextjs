/**
 * Result of reading one web page. Client-safe (no server-only marker) so the
 * pure formatter and its tests can share the shape with the server fetcher.
 */
export interface FetchedPage {
  /** The (normalized) URL that was read. */
  url: string;
  /** Page `<title>`, or "" when it had none. */
  title: string;
  /** Readable page text, trimmed to a bounded length. */
  text: string;
  /** Set when the page could not be read; `title`/`text` are then empty. */
  error?: string;
}
