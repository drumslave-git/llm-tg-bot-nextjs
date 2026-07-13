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
  "Search the public web via Tavily and return a summary with sources. " +
  "ONLY call when the user explicitly asks you to search the web, look something up online, " +
  "verify a claim, or check current facts. " +
  "Do NOT use for casual chat, general knowledge, or opinions the user did not ask you to verify.";

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
