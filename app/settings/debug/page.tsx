import { Database } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { TraceExplorer } from "@/components/debug";
import { EmptyState } from "@/components/ui";
import { getTraceList, type TraceListView, type TraceQuery } from "@/server/trace";
import { traceQuerySchema } from "@/server/trace/schema";

// Traces are read from the database at request time.
export const dynamic = "force-dynamic";

const FEATURE = "settings";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Settings Debug page — the shared explorer scoped to the `settings` feature.
 * Demonstrates the feature-contract Debug page as a thin wrapper over the shared
 * components (no bespoke debug UI).
 */
export default async function SettingsDebugPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parsed = traceQuerySchema.safeParse({
    status: first(sp.status),
    limit: first(sp.limit),
    offset: first(sp.offset),
  });
  const query: TraceQuery = { ...(parsed.success ? parsed.data : {}), feature: FEATURE };

  let view: TraceListView | null = null;
  let dbError: string | null = null;
  try {
    view = await getTraceList(query);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read traces from the database";
  }

  return (
    <>
      <PageHeader
        title="Settings · Debug"
        description="Configuration change and connection-test traces. Inspect steps and download a JSON bundle."
      />
      {view ? (
        <TraceExplorer
          view={view}
          query={query}
          basePath="/settings/debug"
          showFeatureFilter={false}
        />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The trace database could not be reached."}
        />
      )}
    </>
  );
}
