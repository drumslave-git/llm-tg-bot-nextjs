import { Database } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { TraceExplorer } from "@/components/debug";
import { EmptyState } from "@/components/ui";
import { getTraceList, type TraceListView } from "@/server/trace";
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
  let dbError: string | null = null;
  try {
    view = await getTraceList(query);
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
        <TraceExplorer view={view} query={query} basePath="/debug" />
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
