import { getPeriodInsightCard } from "@/features/analytics/server/metrics";
import { insightsQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * The stored LLM-derived roll-up (mood + word of the period + top topic) for a
 * selected month/year/all bucket and scope. Returns `null` when that period has
 * not been computed yet (before the nightly job's first run for it).
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, insightsQuerySchema);
  return ok(
    await getPeriodInsightCard({
      granularity: query.granularity,
      bucket: query.bucket ?? null,
      scope: query.scope,
      chatId: query.chatId ?? null,
    }),
  );
});
