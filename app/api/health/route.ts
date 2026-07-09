import { defineRoute, ok } from "@/server/http";
import { envPresence } from "@/server/env";
import { buildInfo } from "@/server/build-info";

/**
 * Liveness + configuration presence endpoint. Reports which capability-critical
 * env vars are configured (never their values) so the dashboard overview can
 * show honest status without a live database connection.
 */
export const GET = defineRoute(async () => {
  return ok({
    status: "ok" as const,
    time: new Date().toISOString(),
    version: buildInfo.version,
    config: envPresence(),
  });
});
