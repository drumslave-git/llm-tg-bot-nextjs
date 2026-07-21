import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getBotPolicy } from "@/features/settings/server/service";
import { getToolContext } from "@/server/mcp/context";

import { enqueueBrowserRun } from "./service";
import { emitRunEnqueued } from "./signal";

/**
 * The browser agent exposed as a single MCP tool. `browse_web` enqueues a
 * background run: a sub-agent LLM drives a full browser (navigate, click, type,
 * scroll, read, screenshot, download) to accomplish the goal, then reports back
 * to this chat. The chat model calls this and moves on — it does not drive the
 * browser itself (recorded decision: background run, not inline).
 *
 * The generic browser tools the run uses are NOT MCP tools and are never offered
 * here; only this dispatch tool is. Anyone may start a run; the download tool
 * inside the run is gated to owner-started runs (resolved at enqueue time).
 */

export const BROWSE_WEB_TOOL = "browse_web";

export const BROWSER_AGENT_TOOL_NAMES = [BROWSE_WEB_TOOL];

const BROWSE_WEB_DESCRIPTION =
  "Start a background web-browsing agent to research or do something on the web that needs " +
  "actually visiting pages — following links, searching a site, filling a form, reading content " +
  "behind a click, or fetching a file. The agent opens a real browser and works step by step, " +
  "then reports back to this chat when it is done (this may take a while). " +
  "Call this when the request needs live web interaction beyond a single page read or a search " +
  "snippet. Do NOT call for a quick fact you already know, or when a plain web search or reading " +
  "one known URL is enough. " +
  "Write the goal as a clear, self-contained instruction, and INCLUDE ALL links the user gave — " +
  "the agent starts from nothing but this text. " +
  "The agent replies to the chat itself, so just tell the user you're on it; do not invent results.";

/** Register the browser-agent MCP tool on the shared server. */
export function registerBrowserAgentMcpTools(server: McpServer): void {
  server.registerTool(
    BROWSE_WEB_TOOL,
    {
      title: "Browse the web",
      description: BROWSE_WEB_DESCRIPTION,
      inputSchema: {
        goal: z
          .string()
          .min(4)
          .max(4000)
          .describe(
            "A clear, self-contained description of what to find or do on the web. Include ALL links the user gave.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        runId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        // Queues background work that will post to the chat; nothing destructive.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ goal }) => {
      const ctx = getToolContext();
      // Owner status gates the download tool for the whole run; resolve it now.
      const policy = await getBotPolicy().catch(() => null);
      const isOwner = Boolean(policy?.ownerUserId && ctx.userId === policy.ownerUserId);

      const run = await enqueueBrowserRun({
        goal,
        chatId: ctx.chatId,
        threadId: ctx.threadId ?? null,
        createdByUserId: ctx.userId ?? null,
        isOwner,
      });
      emitRunEnqueued();

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Browsing run started in the background. Tell the user you're on it and will ` +
              `report back here with what you find. Do not make up results — the run posts them itself.`,
          },
        ],
        structuredContent: { ok: true, runId: run.id },
      };
    },
  );
}
