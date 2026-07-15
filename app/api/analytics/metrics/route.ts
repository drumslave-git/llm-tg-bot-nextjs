import { getMetrics } from "@/features/analytics/server/metrics";
import { metricsQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * Numeric analytics series for the dashboard charts. All metrics are aggregated
 * live from the base tables (exact, self-healing); the query selects the
 * granularity and an optional chat/user filter.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, metricsQuerySchema);
  return ok(await getMetrics(query));
});
