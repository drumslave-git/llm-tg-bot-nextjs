/**
 * Normalized result of an MCP tool call, as consumed by the tool-call loop.
 * Pure type (no server-only marker) so both the loop and trace UI can import it.
 */
export interface McpToolCallResult {
  /** Human/model-readable text (joined from the tool's text content blocks). */
  text: string;
  /** Structured payload the tool returned, when any (recorded in traces). */
  structuredContent?: unknown;
  /** True when the tool reported an error result (`isError`). */
  isError?: boolean;
}
