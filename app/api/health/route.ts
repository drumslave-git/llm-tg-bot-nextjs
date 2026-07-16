import { buildInfo } from "@/lib/build-info";
import { defineRoute } from "@/server/http";
import { getHealth } from "@/server/status";

// Always evaluate the probe at request time.
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness endpoint. Readiness is a real database probe (`SELECT 1`),
 * not an env-presence guess: `200` when the app can serve, `503` when its
 * bootstrap dependency (the DB) is down — so orchestrators react correctly. The
 * body also reports DB-stored configuration presence (informational; the LLM is
 * not a readiness gate).
 */
export const GET = defineRoute(async () => {
  const health = await getHealth();
  return Response.json(
    {
      status: health.ready ? "ok" : "unavailable",
      time: new Date().toISOString(),
      version: buildInfo.version,
      checks: {
        database: health.database,
        configuration: health.configuration,
      },
    },
    { status: health.ready ? 200 : 503 },
  );
});
