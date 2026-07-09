import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Integration test config. Runs only `*.integration.test.ts` files, which spin
 * up real Postgres containers via Testcontainers (Docker required). Timeouts are
 * generous to cover container startup; files run serially to bound resource use.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/stubs/empty.ts"),
      "@": resolve(__dirname, "."),
    },
  },
});
