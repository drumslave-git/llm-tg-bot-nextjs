import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { getAnalyticsJobInfo } from "@/features/analytics/server/scheduler";
import { getSystemStats } from "@/features/analytics/server/metrics";
import type { AnalyticsJobInfo, SystemStats } from "@/features/analytics/types";
import { MOOD_COLORS, SeriesCard } from "@/features/analytics/ui/AnalyticsCharts";
import { AnalyticsJobCard } from "@/features/analytics/ui/AnalyticsJobCard";
import {
  BotHealthPanel,
  InsightCard,
  ModelTable,
  TopUsersPanel,
  TrafficCard,
} from "@/features/analytics/ui/AnalyticsPanels";
import type { FilterOption } from "@/features/analytics/ui/FilterableCard";
import { RegenerateCard } from "@/features/analytics/ui/RegenerateCard";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { listGroups } from "@/features/known-groups/server/service";
import { listUsers } from "@/features/known-users/server/service";
import { featureDebugHref } from "@/lib/features";

// Every metric is read live from the database at request time.
export const dynamic = "force-dynamic";

interface AnalyticsData {
  system: SystemStats;
  job: AnalyticsJobInfo;
  chats: FilterOption[];
  userOptions: FilterOption[];
}

/**
 * Analytics dashboard.
 *
 * There is no page-level filter: every card carries its own period and chat/user
 * scope and fetches itself, so you can hold this week's mood next to the year's
 * token trend. This Server Component supplies only what is shared — the filter
 * option lists — plus the cards that take no filters at all (bot health, model
 * performance, top users), which describe the bot itself over all history and are
 * rendered here directly.
 */
export default async function AnalyticsPage() {
  let data: AnalyticsData | null = null;
  let dbError: string | null = null;
  try {
    const [system, job, users, groups] = await Promise.all([
      getSystemStats(),
      getAnalyticsJobInfo(),
      listUsers(),
      listGroups(),
    ]);
    data = {
      system,
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
        description="Traffic, model performance, mood, and health. Each card carries its own filters. Times use the operator timezone in Settings."
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
          <TrafficCard chats={data.chats} users={data.userOptions} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <InsightCard kind="mood" chats={data.chats} users={data.userOptions} />
            <InsightCard kind="word" chats={data.chats} users={data.userOptions} />
            <InsightCard kind="topic" chats={data.chats} users={data.userOptions} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <SeriesCard
              section="volume"
              title="Message volume"
              description="Messages per period"
              chats={data.chats}
              users={data.userOptions}
            />
            <SeriesCard
              section="tokens"
              title="Tokens"
              description="Processed (prompt) vs generated (completion)"
              chats={data.chats}
              users={data.userOptions}
              area
            />
            <SeriesCard
              section="users"
              title="Users"
              description="Active and newly-seen users"
              chats={data.chats}
              users={data.userOptions}
            />
            <SeriesCard
              section="mood"
              title="Mood trend"
              description="Conversation mood (0–100) per period, from the insight job"
              chats={data.chats}
              users={data.userOptions}
              area
              colors={MOOD_COLORS}
              emptyMessage="No mood data yet — the nightly insight job scores each finished day. Run it from the card below to populate this."
            />
          </div>

          <BotHealthPanel health={data.system.health} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ModelTable models={data.system.models} />
            <TopUsersPanel users={data.system.topUsers} />
          </div>

          <AnalyticsJobCard job={data.job} />
          <RegenerateCard job={data.job} />
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
