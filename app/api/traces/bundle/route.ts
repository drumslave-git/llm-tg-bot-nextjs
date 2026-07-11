import { buildTraceListBundle } from "@/server/trace";
import { defineRoute, jsonDownload, parseQuery } from "@/server/http";
import { traceQuerySchema } from "@/server/trace/schema";

/**
 * Downloadable JSON log/trace bundle for a filtered set of traces (newest first,
 * capped), each with its events. Powers the Debug page "Download all" export.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, traceQuerySchema);
  const bundle = await buildTraceListBundle(query);
  const scope = query.feature ?? "all";
  return jsonDownload(bundle, `traces-${scope}.json`);
});
