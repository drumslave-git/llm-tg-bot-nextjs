import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getWebSearchApiKey } from "@/features/settings/server/service";
import { runWebSearch } from "./search";

/**
 * Web search exposed as an MCP tool. `search_web` runs a Tavily query and returns
 * a summary with sources for the model to cite. The API key lives in DB-backed
 * settings and is read at call time (so a key change takes effect immediately);
 * when it is unset the tool returns a clear error rather than a broken search.
 */

export const SEARCH_WEB_TOOL = "search_web";

export const WEB_SEARCH_TOOL_NAMES = [SEARCH_WEB_TOOL];

const SEARCH_WEB_DESCRIPTION =
  "Search the public web via Tavily to DISCOVER pages and get quick text snippets when you do not " +
  "already have a specific URL — to find sources, look up general facts, news, or definitions, or " +
  "verify a claim. ONLY call when the user asks you to look something up online. " +
  "Do NOT use for casual chat, general knowledge, or opinions the user did not ask you to verify. " +
  "Do NOT use to open a specific web page the user already gave you or that is already in the " +
  "conversation — a known URL should be read directly, not searched for. " +
  "Do NOT use to read a LIVE or CURRENT value off a specific site the user named — a live " +
  "player/viewer count, live stats, a chart or dashboard, a current price or availability: this " +
  "returns a cached snippet that is stale or plain wrong for those numbers, which change by the " +
  "minute and are computed in the browser. Those must be read by actually visiting and rendering " +
  "the page with the browsing agent, not with this search.";

/** Structured payload returned alongside the text summary. */
const searchWebOutputSchema = {
  ok: z.boolean(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
};

/** Register the web-search MCP tools on the shared server. */
export function registerWebSearchMcpTools(server: McpServer): void {
  server.registerTool(
    SEARCH_WEB_TOOL,
    {
      title: "Search the web",
      description: SEARCH_WEB_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Short search-engine query, in the user's language when obvious"),
      },
      outputSchema: searchWebOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      const apiKey = await getWebSearchApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Web search is not configured (no Tavily API key set). Tell the user web search " +
                "is unavailable — do not pretend you searched.",
            },
          ],
          structuredContent: { ok: false, sources: [] },
          isError: true,
        };
      }

      const result = await runWebSearch(query, { apiKey });
      return {
        content: [{ type: "text" as const, text: result.context }],
        structuredContent: { ok: result.ok, sources: result.sources },
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
}
