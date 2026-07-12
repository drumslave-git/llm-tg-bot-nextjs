import { describe, expect, it } from "vitest";

import { HISTORY_GET_IN_RANGE_TOOL, HISTORY_SEARCH_TOOL } from "@/features/history/server/mcp-tools";
import { getToolset, getToolsView } from "./service";

/**
 * MCP-tools service. The tool registry is shared, in-process, code-defined infra
 * (no DB); these tests confirm the operator-facing list and the reply toolset both
 * expose every registered tool (all tools are always available — no on/off).
 */

describe("getToolsView", () => {
  it("lists every registered history tool with its owning feature", async () => {
    const view = await getToolsView();
    const names = view.tools.map((t) => t.name);
    expect(names).toContain(HISTORY_SEARCH_TOOL);
    expect(names).toContain(HISTORY_GET_IN_RANGE_TOOL);
    expect(view.tools.every((t) => t.feature === "history")).toBe(true);
    expect(view.tools.every((t) => t.description.length > 0)).toBe(true);
  });
});

describe("getToolset", () => {
  it("returns every registered tool in OpenAI shape with a callTool", async () => {
    const toolset = await getToolset();
    expect(toolset).not.toBeNull();
    const names = toolset!.tools.map((t) => t.function.name).sort();
    expect(names).toEqual([HISTORY_GET_IN_RANGE_TOOL, HISTORY_SEARCH_TOOL].sort());
    expect(typeof toolset!.callTool).toBe("function");
  });
});
