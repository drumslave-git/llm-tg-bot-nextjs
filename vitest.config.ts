import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Test runner config. Mirrors the `@/*` path alias from tsconfig and stubs the
 * `server-only` import guard (which throws outside an RSC bundle) so server
 * modules can be unit-tested directly.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // Integration tests (real Postgres via Testcontainers) run via
    // `npm run test:integration` with their own config.
    exclude: ["node_modules", ".next", "dist", "**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/stubs/empty.ts"),
      "@": resolve(__dirname, "."),
    },
  },
});
