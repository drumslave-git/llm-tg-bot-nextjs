import "server-only";

import {
  extractWebSearchSources,
  formatWebSearchContext,
  formatWebSearchFailure,
  normalizeTavilyResults,
} from "../format";
import type { WebSearchPayload, WebSearchSource } from "../types";

/**
 * Tavily-backed web search. `runWebSearch` is the boundary the MCP tool calls:
 * it always resolves (never throws) so the tool can hand the model a usable
 * success or failure message. The `fetch` implementation is injectable so the
 * behavior is unit-testable without hitting the network.
 */

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;

export interface WebSearchConfig {
  apiKey: string;
  maxResults?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface WebSearchOutput {
  ok: boolean;
  sources: WebSearchSource[];
  /** Text injected into the model's turn (success context or failure message). */
  context: string;
  /** Short reason for the outcome (for logs/results). */
  reason: string;
}

interface TavilySearchResponse {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

async function fetchTavilySearch(query: string, config: WebSearchConfig): Promise<WebSearchPayload> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error("Web search API key is not configured");

  const fetchFn = config.fetch ?? fetch;
  const res = await fetchFn(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: config.maxResults ?? DEFAULT_MAX_RESULTS,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Web search API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as TavilySearchResponse;
  return {
    results: normalizeTavilyResults(data.results),
    answer: data.answer?.trim() || null,
  };
}

/** Run a web search, returning a model-ready result (never throws). */
export async function runWebSearch(query: string, config: WebSearchConfig): Promise<WebSearchOutput> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      ok: false,
      sources: [],
      context: formatWebSearchFailure("", new Error("Empty search query")),
      reason: "Empty query",
    };
  }

  try {
    const payload = await fetchTavilySearch(trimmed, config);
    return {
      ok: true,
      sources: extractWebSearchSources(payload),
      context: formatWebSearchContext(trimmed, payload),
      reason: "Search completed",
    };
  } catch (err) {
    return {
      ok: false,
      sources: [],
      context: formatWebSearchFailure(trimmed, err),
      reason: err instanceof Error ? err.message : "Search failed",
    };
  }
}
