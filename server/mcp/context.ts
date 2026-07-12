import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-turn context for MCP tool handlers. Tools are registered once on the shared
 * in-process server at startup, but their execution is scoped to a single chat
 * turn. Rather than force the model to pass (and be trusted with) a chat id, the
 * runtime binds the current chat here and tool handlers read it — so a tool can
 * only ever touch the current conversation's data.
 */
export interface McpToolContext {
  /** The current chat's id (Telegram chat/group id as a string). */
  chatId: string;
}

const storage = new AsyncLocalStorage<McpToolContext>();

/** Run `fn` with the given tool context bound for any tool calls it triggers. */
export function runWithToolContext<T>(context: McpToolContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/**
 * The active tool context. Throws when called outside {@link runWithToolContext}
 * — a programming error (a tool ran without the runtime binding a turn).
 */
export function getToolContext(): McpToolContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("MCP tool called outside a tool context — no chat is bound");
  }
  return context;
}
