import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { getAnalyticsJobInfo } from "@/features/analytics/server/scheduler";
import { getMetrics, getMoodTrendPoints, getPeriodInsightCard } from "@/features/analytics/server/metrics";
import { metricsQuerySchema } from "@/features/analytics/server/schema";
import type {
  AnalyticsJobInfo,
  AnalyticsMetrics,
  MoodPoint,
  PeriodGranularity,
  PeriodInsight,
} from "@/features/analytics/types";
import { AnalyticsCharts } from "@/features/analytics/ui/AnalyticsCharts";
import { AnalyticsFilters, type FilterOption } from "@/features/analytics/ui/AnalyticsFilters";
import { AnalyticsJobCard } from "@/features/analytics/ui/AnalyticsJobCard";
import {
  HealthPanel,
  InsightCards,
  ModelTable,
  SummaryTiles,
  TopUsersPanel,
} from "@/features/analytics/ui/AnalyticsPanels";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { listGroups } from "@/features/known-groups/server/service";
import { listUsers } from "@/features/known-users/server/service";
import { featureDebugHref } from "@/lib/features";

// Every metric is read live from the database at request time.
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The insight card is stored only at month/year/all; map any granularity onto that. */
function periodGranularityOf(g: string): PeriodGranularity {
  return g === "month" || g === "year" ? g : "all";
}

interface AnalyticsData {
  metrics: AnalyticsMetrics;
  mood: MoodPoint[];
  insight: PeriodInsight | null;
  job: AnalyticsJobInfo;
  chats: FilterOption[];
  userOptions: FilterOption[];
}

/**
 * Analytics dashboard. Server Component: reads the numeric metrics live (SQL
 * aggregation over the base tables) and the stored LLM-derived insight for the
 * selected period. Filters are URL params (granularity + chat/user drill-down) so
 * a change re-queries server-side; the insight job's completions arrive live over
 * the `analytics` SSE topic.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parsed = metricsQuerySchema.safeParse({
    granularity: first(sp.granularity),
    chatId: first(sp.chatId),
    userId: first(sp.userId),
    count: first(sp.count),
  });
  const query = parsed.success ? parsed.data : metricsQuerySchema.parse({});
  const chatId = query.chatId ?? null;
  const userId = query.userId ?? null;
  const insightScope = chatId ? ("chat" as const) : ("global" as const);

  let data: AnalyticsData | null = null;
  let dbError: string | null = null;
  try {
    const [metrics, mood, insight, job, users, groups] = await Promise.all([
      getMetrics(query),
      getMoodTrendPoints({ chatId }),
      getPeriodInsightCard({ granularity: periodGranularityOf(query.granularity), scope: insightScope, chatId }),
      getAnalyticsJobInfo(),
      listUsers(),
      listGroups(),
    ]);
    data = {
      metrics,
      mood,
      insight,
      job,
      chats: [
        ...users.map((u) => ({ id: u.userId, label: `${formatKnownUserLabel(u)} · DM` })),
        ...groups.map((g) => ({ id: g.chatId, label: `${g.title ?? `Group ${g.chatId}`} · group` })),
      ],
      userOptions: users.map((u) => ({ id: u.userId, label: formatKnownUserLabel(u) })),
    };
  } catch (err) {
    dbError = err instanceof Error ? err.message : "The analytics data could not be read from the database.";
  }

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Traffic, model performance, mood, and health. Times use the operator timezone in Settings."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="analytics" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("analytics-insights")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {data ? (
        <>
          <AnalyticsFilters
            granularity={query.granularity}
            chatId={chatId}
            userId={userId}
            chats={data.chats}
            users={data.userOptions}
          />

          <SummaryTiles metrics={data.metrics} />
          <InsightCards insight={data.insight} />
          <AnalyticsCharts metrics={data.metrics} mood={data.mood} />
          <HealthPanel health={data.metrics.health} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ModelTable models={data.metrics.models} />
            <TopUsersPanel users={data.metrics.topUsers} />
          </div>

          <AnalyticsJobCard job={data.job} />
        </>
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The analytics data could not be read from the database."}
        />
      )}
    </>
  );
}
