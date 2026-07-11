import Link from "next/link";

import { Button } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import type { TraceListView, TraceQuery } from "@/server/trace";
import { DebugFilters } from "./DebugFilters";
import { DownloadButton } from "./DownloadButton";
import { TraceList } from "./TraceList";

/** Build a query string from the active filters, optionally overriding `offset`. */
function queryString(query: TraceQuery, offset?: number): string {
  const params = new URLSearchParams();
  if (query.feature) params.set("feature", query.feature);
  if (query.status) params.set("status", query.status);
  if (offset !== undefined && offset > 0) params.set("offset", String(offset));
  return params.toString();
}

/**
 * Shared Debug explorer — filters, trace list, "download all" bundle export, and
 * pagination in one reusable block. Every feature's Debug page renders this with
 * an already-fetched {@link TraceListView}; scoped pages hide the feature filter
 * by passing `showFeatureFilter={false}`.
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
  /** The Debug page itself — filters and pagination navigate here. */
  basePath: string;
  /** Where trace rows link for detail. Shared single detail route by default. */
  detailBasePath?: string;
  showFeatureFilter?: boolean;
}) {
  const { traces, total, features, limit, offset } = view;
  const bundleQs = queryString(query);
  const rangeEnd = offset + traces.length;
  const hasPrev = offset > 0;
  const hasNext = rangeEnd < total;

  const pageHref = (nextOffset: number): string => {
    const qs = queryString(query, nextOffset);
    return qs ? `${basePath}?${qs}` : basePath;
  };

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
        <div className="flex items-center justify-between gap-3 text-sm text-muted">
          <span>
            {total === 0 ? "No traces" : `${offset + 1}–${rangeEnd} of ${total}`}
          </span>
          <div className="flex items-center gap-2">
            <Button
              asChild={hasPrev}
              variant="outline"
              size="sm"
              disabled={!hasPrev}
            >
              {hasPrev ? (
                <Link href={pageHref(Math.max(offset - limit, 0))}>Previous</Link>
              ) : (
                <span>Previous</span>
              )}
            </Button>
            <Button
              asChild={hasNext}
              variant="outline"
              size="sm"
              disabled={!hasNext}
            >
              {hasNext ? <Link href={pageHref(offset + limit)}>Next</Link> : <span>Next</span>}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
