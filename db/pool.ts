import "server-only";

import { Pool } from "pg";

import { requireEnv } from "@/server/env";

/**
 * Lazily-created, process-wide Postgres connection pool. Server-only. The
 * Drizzle instance in `drizzle.ts` is built on top of this pool.
 *
 * Held on `globalThis` like every other process-wide singleton (hub, trace
 * store, bot manager): a module-local would be re-created on each dev
 * hot-reload / bundle duplication, leaking connections.
 */

const POOL_KEY = Symbol.for("llm-tg-bot.db.pool");

type PoolGlobal = typeof globalThis & { [POOL_KEY]?: Pool };

export function getPool(): Pool {
  const g = globalThis as PoolGlobal;
  if (!g[POOL_KEY]) {
    g[POOL_KEY] = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  }
  return g[POOL_KEY];
}

/** Close the pool (graceful shutdown / tests). No-op if never created. */
export async function closePool(): Promise<void> {
  const g = globalThis as PoolGlobal;
  const current = g[POOL_KEY];
  if (current) {
    delete g[POOL_KEY];
    await current.end();
  }
}
