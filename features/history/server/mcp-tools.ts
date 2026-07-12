import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDb } from "@/db/drizzle";
import { getToolContext } from "@/server/mcp/context";
import { getChatMessagesInRange, searchChatMessages, type ChatMessageRecord } from "./repository";

/**
 * History exposed as MCP tools — deeper-than-today lookups the model can request
 * when the current-day window (already injected into every reply) is not enough.
 * The chat is bound per turn via the tool context, so a tool only ever reads the
 * current conversation's messages; the model does not pass (and cannot pick) a
 * chat id.
 */

export const HISTORY_SEARCH_TOOL = "history_search";
export const HISTORY_GET_IN_RANGE_TOOL = "history_get_in_range";

export const HISTORY_TOOL_NAMES = [HISTORY_SEARCH_TOOL, HISTORY_GET_IN_RANGE_TOOL];

const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;

/** Structured payload returned alongside the text transcript. */
const historyOutputSchema = {
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  messages: z.array(z.object({ role: z.string(), content: z.string(), at: z.string() })),
};

/** One message rendered as a transcript line. */
function formatLine(record: ChatMessageRecord): string {
  return `[${record.sentAt}] ${record.role}: ${record.content}`;
}

/** Build the tool result (text transcript + structured messages) from records. */
function buildResult(records: ChatMessageRecord[]) {
  const messages = records.map((r) => ({ role: r.role, content: r.content, at: r.sentAt }));
  const transcript =
    records.length === 0 ? "(no matching messages)" : records.map(formatLine).join("\n");
  return {
    content: [{ type: "text" as const, text: transcript }],
    structuredContent: { ok: true, count: records.length, messages },
  };
}

/** Merge results from several queries into one de-duplicated, ordered list. */
function mergeById(batches: ChatMessageRecord[][]): ChatMessageRecord[] {
  const byId = new Map<number, ChatMessageRecord>();
  for (const batch of batches) {
    for (const record of batch) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Register the history MCP tools on the shared server. */
export function registerHistoryMcpTools(server: McpServer): void {
  server.registerTool(
    HISTORY_SEARCH_TOOL,
    {
      title: "Search conversation history",
      description:
        "Search this conversation's full stored history for messages containing the given " +
        "text (case-insensitive). Use it to recall things said before today, since only " +
        "today's messages are provided automatically. Pass one query string, or several to " +
        "search multiple phrasings at once.",
      inputSchema: {
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe("Text to look for — a single string, or an array of strings"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .default(SEARCH_LIMIT_DEFAULT)
          .describe(`Max matches per query (max ${SEARCH_LIMIT_MAX})`),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const { chatId } = getToolContext();
      const queries = Array.isArray(query) ? query : [query];
      const cap = limit ?? SEARCH_LIMIT_DEFAULT;
      const db = getDb();
      const batches = await Promise.all(
        queries.map((q) => searchChatMessages(db, chatId, q, cap)),
      );
      return buildResult(mergeById(batches));
    },
  );

  server.registerTool(
    HISTORY_GET_IN_RANGE_TOOL,
    {
      title: "Get history in a date range",
      description:
        "Return this conversation's messages sent within a date/time range (inclusive), " +
        "oldest first. Provide ISO-8601 datetimes; use it to review what was discussed on a " +
        "particular day or period.",
      inputSchema: {
        from: z.string().min(1).describe("Start of the range, ISO-8601 datetime (inclusive)"),
        to: z.string().min(1).describe("End of the range, ISO-8601 datetime (inclusive)"),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ from, to }) => {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid range: provide ISO-8601 'from' and 'to' datetimes where from <= to.",
            },
          ],
          isError: true,
        };
      }
      const { chatId } = getToolContext();
      const records = await getChatMessagesInRange(getDb(), chatId, fromDate, toDate);
      return buildResult(records);
    },
  );
}
