import { fileURLToPath } from "node:url";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import type { DrizzleDb } from "@/db/drizzle";
import * as schema from "@/db/schema";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../db/migrations", import.meta.url));

/**
 * Integration test database backed by a real Postgres (Testcontainers). Start
 * one per test file in `beforeAll`, `truncate()` between tests for isolation,
 * and `stop()` in `afterAll`.
 */
export interface TestDb {
  db: DrizzleDb;
  truncate: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  ).start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    async truncate() {
      await pool.query('TRUNCATE TABLE "trace_events", "traces", "settings" CASCADE');
    },
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
