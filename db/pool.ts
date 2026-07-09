import "server-only";

import { Pool } from "pg";

import { requireEnv } from "@/server/env";

/**
 * Lazily-created, process-wide Postgres connection pool. Server-only. The
 * Drizzle instance in `drizzle.ts` is built on top of this pool.
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  }
  return pool;
}

/** Close the pool (graceful shutdown / tests). No-op if never created. */
export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
