"use client";

import { useRouter } from "next/navigation";

import { Label, Select } from "@/components/ui";
import { FEATURE_IDS, featureLabel } from "@/lib/features";
import { traceStatusSchema, type TraceStatus } from "@/lib/trace";

const STATUSES = traceStatusSchema.options;

/**
 * Merge the registered features with any feature ids that appear in the data
 * (future/unregistered features still show up) plus the active selection, then
 * order by label. Listing every registered feature — not only those that have
 * recorded a trace yet — means a feature is always selectable, so an empty list
 * reads as "no traces yet" rather than "this feature does not exist".
 */
function featureOptions(dataFeatures: string[], selected?: string): string[] {
  const ids = new Set<string>([...FEATURE_IDS, ...dataFeatures]);
  if (selected) ids.add(selected);
  return [...ids].sort((a, b) => featureLabel(a).localeCompare(featureLabel(b)));
}

/**
 * Debug list filters (Client Component). Pushes the selected feature/status into
 * the URL so the Server Component page re-reads with the filter and the view is
 * shareable/refresh-safe. Pagination resets on any filter change. When `features`
 * is omitted the feature dropdown is hidden.
 */
export function DebugFilters({
  basePath,
  features,
  feature,
  status,
}: {
  basePath: string;
  features?: string[];
  feature?: string;
  status?: TraceStatus;
}) {
  const router = useRouter();

  function navigate(next: { feature?: string; status?: string }) {
    const params = new URLSearchParams();
    if (next.feature) params.set("feature", next.feature);
    if (next.status) params.set("status", next.status);
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      {features ? (
        <div className="space-y-1">
          <Label htmlFor="debug-feature">Feature</Label>
          <Select
            id="debug-feature"
            value={feature ?? ""}
            onChange={(e) => navigate({ feature: e.target.value, status })}
            className="min-w-40"
          >
            <option value="">All features</option>
            {featureOptions(features, feature).map((f) => (
              <option key={f} value={f}>
                {featureLabel(f)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="debug-status">Status</Label>
        <Select
          id="debug-status"
          value={status ?? ""}
          onChange={(e) => navigate({ feature, status: e.target.value })}
          className="min-w-40"
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
