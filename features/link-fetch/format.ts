import type { FetchedPage } from "./types";

/**
 * Pure formatting for the read-link tool. Turns the fetched page into the text
 * the model reads back as the tool result. Client-safe (no server-only marker)
 * and unit-tested directly. Mirrors the web-search formatter's contract: always
 * tell the model plainly when a read failed so it never pretends it opened a page.
 */

/** Human-readable message for an error value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The text the model reads for a fetched page (success or per-page error). */
export function formatLinkFetchContext(page: FetchedPage): string {
  const header = `Read page: ${page.url}`;

  if (page.error) {
    return (
      `${header}\nFailed to read: ${page.error}\n\n` +
      `Tell the user the page could not be read. Do not invent its contents.`
    );
  }

  const titleLine = page.title ? `\nTitle: ${page.title}` : "";
  const bodyLine = page.text
    ? `\nContent:\n${page.text}`
    : "\nContent: (page had no readable text)";

  return (
    `${header}${titleLine}${bodyLine}\n\n` +
    `Use the page content above to answer. Do not tell the user you cannot open links. ` +
    `If Content is empty, say the page had no readable text rather than guessing.`
  );
}

/** The text the model reads when the read failed outright (never pretend success). */
export function formatLinkFetchFailure(url: string, err: unknown): string {
  return (
    `Reading the page ${url} failed: ${errorMessage(err)}\n\n` +
    `Tell the user the live page read failed. Do not pretend you opened the link.`
  );
}
