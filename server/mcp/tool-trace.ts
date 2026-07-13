import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { startTrace } from "@/server/trace";
import { tryGetToolContext } from "./context";
import type { McpToolCallResult } from "./tool-result";

/**
 * Per-tool trace recording — every MCP tool call runs inside its own trace,
 * scoped to a `mcp-tools-<owning-feature>` feature (e.g. `mcp-tools-history`) with
 * the tool name as the trace action. This gives each tool an independent Debug
 * scope (`/debug?feature=mcp-tools-<owner>`), separate from the inline
 * `external_call` step the bot-messaging reply trace also records. Wrapping the
 * single `BotMcpRegistry.callTool` choke point means every current and future tool
 * gets its own scope automatically — no per-tool wiring.
 */

const MCP_FEATURE_PREFIX = "mcp-tools-";

/** The trace `feature` id for a tool owned by `owningFeature`. */
export function toolTraceFeature(owningFeature: string): string {
  return `${MCP_FEATURE_PREFIX}${owningFeature}`;
}

/**
 * Run one tool call wrapped in its own scoped trace. A tool that returns an error
 * *result* (`isError`) still ran, so its trace settles `success` with a warn-level
 * output; only a thrown error fails the trace.
 */
export async function tracedToolCall(
  owningFeature: string,
  name: string,
  args: Record<string, unknown>,
  run: () => Promise<McpToolCallResult>,
  db?: DrizzleDb,
): Promise<McpToolCallResult> {
  const ctx = tryGetToolContext();
  let trace: Awaited<ReturnType<typeof startTrace>>;
  try {
    trace = await startTrace(
      {
        feature: toolTraceFeature(owningFeature),
        action: name,
        trigger: { kind: "telegram", actor: ctx?.chatId, correlationId: ctx?.chatId },
        inputSummary: name,
      },
      db,
    );
  } catch {
    // Trace backend unavailable — never block the tool call on it (the reply trace
    // still records the call inline). Run the tool untraced.
    return run();
  }
  try {
    await trace.event({ type: "input", message: "tool args", data: { args } });
    const result = await run();
    await trace.event({
      type: "output",
      level: result.isError ? "warn" : "success",
      message: result.isError ? "tool returned error result" : "tool result",
      data: {
        text: result.text,
        structuredContent: result.structuredContent,
        isError: result.isError ?? false,
      },
    });
    await trace.succeed({ outputSummary: result.isError ? "error result" : "ok" });
    return result;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
