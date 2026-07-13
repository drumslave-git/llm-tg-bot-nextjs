import "server-only";

import {
  HISTORY_TOOL_NAMES,
  registerHistoryMcpTools,
} from "@/features/history/server/mcp-tools";
import {
  KNOWN_USERS_TOOL_NAMES,
  registerKnownUsersMcpTools,
} from "@/features/known-users/server/mcp-tools";
import {
  registerWebSearchMcpTools,
  WEB_SEARCH_TOOL_NAMES,
} from "@/features/web-search/server/mcp-tools";
import { BotMcpRegistry } from "./registry";

/**
 * Process-wide MCP registry. Tools are registered once and the in-process
 * client/server pair connects once; both the reply runtime (per turn) and the
 * Tools dashboard read the same registry. Kept on a `globalThis` singleton — like
 * the bot manager — so it survives module re-evaluation across Next bundles and
 * dev hot-reload, and the MCP server is never connected twice.
 *
 * New tool-owning features add their registrar here.
 */

interface RegistryStore {
  registry: BotMcpRegistry | null;
  loading: Promise<BotMcpRegistry> | null;
}

const STORE_KEY = Symbol.for("llm-tg-bot.mcp.registry");

function store(): RegistryStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: RegistryStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { registry: null, loading: null };
  return g[STORE_KEY];
}

/** Build the registry, register every feature's tools, and connect. */
async function build(): Promise<BotMcpRegistry> {
  const registry = new BotMcpRegistry();
  registry.registerTools("history", registerHistoryMcpTools, HISTORY_TOOL_NAMES);
  registry.registerTools("known-users", registerKnownUsersMcpTools, KNOWN_USERS_TOOL_NAMES);
  registry.registerTools("web-search", registerWebSearchMcpTools, WEB_SEARCH_TOOL_NAMES);
  await registry.finishRegistration();
  return registry;
}

/**
 * The shared MCP registry, loaded and connected. Idempotent and safe to call
 * concurrently — the first call builds it, the rest await the same promise.
 */
export async function loadMcpRegistry(): Promise<BotMcpRegistry> {
  const s = store();
  if (s.registry) return s.registry;
  if (!s.loading) {
    s.loading = build().then((registry) => {
      s.registry = registry;
      return registry;
    });
  }
  return s.loading;
}
