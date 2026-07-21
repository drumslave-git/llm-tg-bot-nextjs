import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchLink } from "./fetch-link";

/**
 * Link reading exposed as an MCP tool. `read_web_page` reads ONE public web page
 * with headless Chromium and returns its readable text for the model to answer
 * from. The URL is SSRF-checked before the browser touches it, and the boundary
 * never throws — a blocked/failed read returns a clear error result rather than a
 * broken tool call. Registered under feature `link-fetch`, so every call is traced
 * in its own `mcp-tools-link-fetch` scope.
 */

export const READ_WEB_PAGE_TOOL = "read_web_page";

export const LINK_FETCH_TOOL_NAMES = [READ_WEB_PAGE_TOOL];

const READ_WEB_PAGE_DESCRIPTION =
  "Read ONE public web page and return its readable text so you can answer from it. " +
  "Use it whenever the user shares a URL, or asks about the content of a specific page whose URL is in the conversation — " +
  "read the page instead of answering about it from memory. " +
  "It reads a single http(s) page; it cannot download files (videos, archives, images) or read more than one link at a time.";

/** Structured payload returned alongside the text result. */
const readWebPageOutputSchema = {
  ok: z.boolean(),
  url: z.string(),
  title: z.string(),
};

/** Register the link-fetch MCP tools on the shared server. */
export function registerLinkFetchMcpTools(server: McpServer): void {
  server.registerTool(
    READ_WEB_PAGE_TOOL,
    {
      title: "Read a web page",
      description: READ_WEB_PAGE_DESCRIPTION,
      inputSchema: {
        url: z.string().min(1).describe("Public http(s) URL of the page to read"),
      },
      outputSchema: readWebPageOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      const result = await fetchLink(url);
      return {
        content: [{ type: "text" as const, text: result.context }],
        structuredContent: {
          ok: result.resolved,
          url: result.page.url,
          title: result.page.title,
        },
        ...(result.resolved ? {} : { isError: true }),
      };
    },
  );
}
