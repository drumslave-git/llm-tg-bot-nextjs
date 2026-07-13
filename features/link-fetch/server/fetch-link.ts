import "server-only";

import { formatLinkFetchContext, formatLinkFetchFailure } from "../format";
import type { FetchedPage } from "../types";
import { isSafePublicUrl, normalizeUrl } from "../url-safety";
import { fetchPageWithPlaywright } from "./playwright";

/**
 * The read-link boundary the `read_page` MCP tool calls. It normalizes and
 * SSRF-checks the URL, reads the page, and formats a model-ready result. Like
 * the web-search boundary it **always resolves** (never throws) so the tool can
 * hand the model a usable success/failure message. The page fetcher is injectable
 * so this is unit-testable without launching a real browser.
 */

export interface FetchLinkConfig {
  /** Injectable page reader; defaults to headless Chromium. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

export interface FetchLinkOutput {
  page: FetchedPage;
  /** Text injected as the tool result (page content or failure message). */
  context: string;
  /** True when the page was read without error. */
  resolved: boolean;
  /** Short reason for the outcome (for logs/results). */
  reason: string;
}

/** Read one public web page, returning a model-ready result (never throws). */
export async function fetchLink(url: string, config: FetchLinkConfig = {}): Promise<FetchLinkOutput> {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    const page: FetchedPage = { url: url.trim(), title: "", text: "", error: "URL is not a valid http(s) link" };
    return { page, context: formatLinkFetchContext(page), resolved: false, reason: page.error! };
  }

  if (!isSafePublicUrl(normalized)) {
    const page: FetchedPage = {
      url: normalized,
      title: "",
      text: "",
      error: "URL blocked for safety (private network or unsupported scheme)",
    };
    return { page, context: formatLinkFetchContext(page), resolved: false, reason: page.error! };
  }

  const fetchPage = config.fetchPage ?? fetchPageWithPlaywright;
  try {
    const page = await fetchPage(normalized);
    const resolved = !page.error;
    return {
      page,
      context: formatLinkFetchContext(page),
      resolved,
      reason: resolved ? "Page read" : (page.error ?? "Page read failed"),
    };
  } catch (err) {
    return {
      page: { url: normalized, title: "", text: "", error: err instanceof Error ? err.message : String(err) },
      context: formatLinkFetchFailure(normalized, err),
      resolved: false,
      reason: err instanceof Error ? err.message : "Page read failed",
    };
  }
}
