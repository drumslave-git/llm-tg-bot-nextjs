import "server-only";

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { loadMcpRegistry } from "@/server/mcp/runtime";
import type { ToolsView, ToolView } from "./schema";

/**
 * MCP-tools domain service — the boundary the Tools dashboard, its Route Handler,
 * and the reply runtime call. Every registered tool is always available to the
 * model; this service exposes the operator-facing list and resolves the toolset
 * for a reply turn. The registry itself is shared infra (`server/mcp`) and is
 * code-defined, not DB-backed — so these reads take no db handle.
 */

/** Build the dashboard view: every registered tool. */
export async function getToolsView(): Promise<ToolsView> {
  const registry = await loadMcpRegistry();
  const registered = await registry.listTools();
  const tools: ToolView[] = registered
    .map((tool) => ({ name: tool.name, description: tool.description, feature: tool.feature }))
    .sort((a, b) => a.feature.localeCompare(b.feature) || a.name.localeCompare(b.name));
  return { tools };
}

/** The toolset for a reply turn, ready for the tool-call loop. */
export interface Toolset {
  tools: ChatCompletionFunctionTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
}

/**
 * Server-only: the tools available for a reply — every registered tool — or null
 * when none are registered (so the caller takes the plain single-inference path).
 */
export async function getToolset(): Promise<Toolset | null> {
  const registry = await loadMcpRegistry();
  const tools = await registry.listOpenAiTools();
  if (tools.length === 0) return null;
  return {
    tools,
    callTool: (name, args) => registry.callTool(name, args),
  };
}
