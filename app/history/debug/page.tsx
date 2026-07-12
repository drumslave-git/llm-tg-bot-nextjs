import { Database } from "lucide-react";

import { TraceExplorer } from "@/components/debug";
import { EmptyState, PageHeader } from "@/components/ui";
import { getTraceList, type TraceListView, type TraceQuery } from "@/server/trace";
import { traceQuerySchema } from "@/server/trace/schema";

// Traces are read from the database at request time.
export const dynamic = "force-dynamic";

const FEATURE = "history";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * History Debug page — the shared explorer scoped to the `history` feature
 * (message-edit traces). Passive message capture is intentionally untraced (the
 * mirror itself is the record); window loading is traced within each reply.
 */
export default async function HistoryDebugPage({
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
        title="History · Debug"
        description="Message-edit traces. Inspect steps and download a JSON bundle."
      />
      {view ? (
        <TraceExplorer
          view={view}
          query={query}
          basePath="/history/debug"
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
