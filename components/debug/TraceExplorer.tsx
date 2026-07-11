import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import type { TraceListView, TraceQuery } from "@/server/trace";
import { DebugFilters } from "./DebugFilters";
import { DownloadButton } from "./DownloadButton";
import { TraceList } from "./TraceList";

/** Build a query string from the active filters (for the bundle-export link). */
function queryString(query: TraceQuery): string {
  const params = new URLSearchParams();
  if (query.feature) params.set("feature", query.feature);
  if (query.status) params.set("status", query.status);
  return params.toString();
}

/**
 * Shared Debug explorer — filters, live indicator, "download all" bundle export,
 * and the (uncapped) trace list in one reusable block. Every feature's Debug page
 * renders this with an already-fetched {@link TraceListView}; scoped pages hide
 * the feature filter by passing `showFeatureFilter={false}`.
 */
export function TraceExplorer({
  view,
  query,
  basePath,
  detailBasePath = "/debug",
  showFeatureFilter = true,
}: {
  view: TraceListView;
  query: TraceQuery;
  /** The Debug page itself — filters navigate here. */
  basePath: string;
  /** Where trace rows link for detail. Shared single detail route by default. */
  detailBasePath?: string;
  showFeatureFilter?: boolean;
}) {
  const { traces, total, features } = view;
  const bundleQs = queryString(query);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DebugFilters
          basePath={basePath}
          features={showFeatureFilter ? features : undefined}
          feature={query.feature}
          status={query.status}
        />
        <div className="flex items-center gap-2">
          <LiveIndicator topic="traces" />
          <DownloadButton
            href={bundleQs ? `/api/traces/bundle?${bundleQs}` : "/api/traces/bundle"}
            label="Download all"
          />
        </div>
      </div>

      <TraceList traces={traces} basePath={detailBasePath} />

      {total > 0 ? (
        <p className="text-sm text-muted">
          {total} trace{total === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}
