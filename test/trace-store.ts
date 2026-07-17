import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "vitest";

import { resetEnvCache } from "@/server/env";
import { __resetTraceStoreForTests } from "@/server/trace/store";

/**
 * Isolate the file-backed trace store for a Docker-free unit suite: point
 * `TRACES_DIR` at a fresh temp dir per test and clear the in-memory store, so
 * trace reads see only the current test. Returns a handle whose `dir` is the
 * active temp directory (for suites that read the NDJSON files directly). Call
 * once at the top level of the suite.
 *
 * Integration suites don't need this — `test/setup-trace-store.ts` wires the same
 * isolation globally via `setupFiles`.
 */
export function setupTempTraceStore(): { readonly dir: string } {
  const handle = { dir: "" };
  beforeEach(() => {
    handle.dir = mkdtempSync(path.join(tmpdir(), "traces-unit-"));
    process.env.TRACES_DIR = handle.dir;
    resetEnvCache();
    __resetTraceStoreForTests();
  });
  afterEach(() => {
    __resetTraceStoreForTests();
    delete process.env.TRACES_DIR;
    resetEnvCache();
    try {
      rmSync(handle.dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  });
  return handle;
}
