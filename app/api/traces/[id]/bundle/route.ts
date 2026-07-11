import { buildTraceBundle } from "@/server/trace";
import { defineRoute, jsonDownload } from "@/server/http";

/** Downloadable JSON log/trace bundle for a single trace (with its events). */
export const GET = defineRoute(async ({ params }) => {
  const bundle = await buildTraceBundle(params.id);
  return jsonDownload(bundle, `trace-${params.id}.json`);
});
