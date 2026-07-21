import { Database } from "lucide-react";

import { PruneCard, TraceExplorer } from "@/components/debug";
import { EmptyState, PageHeader } from "@/components/ui";
import { getTraceList, getTraceMonths, type TraceListView } from "@/server/trace";
import { traceQuerySchema } from "@/server/trace/schema";

// Traces are read from the database at request time.
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Global Debug page — every feature's traces in one filterable list, linking to
 * the shared detail view and JSON bundle export. A genuine DB read: a failure
 * surfaces as a real error, not a misleading empty state.
 */
export default async function DebugPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parsed = traceQuerySchema.safeParse({
    feature: first(sp.feature),
    status: first(sp.status),
    limit: first(sp.limit),
    offset: first(sp.offset),
  });
  const query = parsed.success ? parsed.data : {};

  let view: TraceListView | null = null;
  let months: string[] = [];
  let dbError: string | null = null;
  try {
    [view, months] = await Promise.all([getTraceList(query), getTraceMonths()]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read traces from the database";
  }

  return (
    <>
      <PageHeader
        title="Debug"
        description="Every traced action across features — inspect decision steps, external calls, LLM usage, and errors, then download a JSON bundle."
      />
      {view ? (
        <div className="space-y-6">
          <TraceExplorer view={view} query={query} basePath="/debug" />
          <PruneCard months={months} />
        </div>
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
