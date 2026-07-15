"use client";

import type { EChartsOption } from "echarts";
import dynamic from "next/dynamic";
import { useCallback } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

import { formatCompact } from "../format";
import type { AnalyticsMetrics, Granularity, MoodPoint } from "../types";
import { STATUS, type ChartTheme } from "./chart-theme";

// The chart is canvas-bound (ECharts): load it client-only so ECharts never
// enters the server render. Reserves the height to avoid layout shift.
const Chart = dynamic(() => import("./Chart").then((m) => m.Chart), {
  ssr: false,
  loading: () => <div style={{ height: 260 }} aria-hidden />,
});

/** Shorten a bucket key for an axis tick, per granularity. */
function shortBucket(label: string, granularity: Granularity): string {
  switch (granularity) {
    case "day":
    case "week":
      // "2026-07-15" → "07-15"
      return label.slice(5);
    case "month":
      return label; // "2026-07"
    case "all":
      return "All time";
  }
}

interface SeriesSpec {
  name: string;
  data: number[];
  slot?: number;
  color?: string;
}

/** Shared line-chart option builder themed from the resolved palette. */
function lineOption(
  theme: ChartTheme,
  input: { buckets: string[]; granularity: Granularity; series: SeriesSpec[]; yMax?: number; area?: boolean },
): EChartsOption {
  const multi = input.series.length > 1;
  return {
    grid: { left: 8, right: 16, top: multi ? 34 : 12, bottom: 4, containLabel: true },
    color: input.series.map((s, i) => s.color ?? theme.series[s.slot ?? i]),
    legend: multi
      ? { show: true, top: 0, left: 0, itemWidth: 12, itemHeight: 4, textStyle: { color: theme.secondary, fontSize: 12 } }
      : undefined,
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.grid,
      textStyle: { color: theme.ink, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: theme.baseline } },
    },
    xAxis: {
      type: "category",
      data: input.buckets.map((b) => shortBucket(b, input.granularity)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.baseline } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      max: input.yMax,
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => formatCompact(v) },
    },
    series: input.series.map((s) => ({
      name: s.name,
      type: "line" as const,
      data: s.data,
      smooth: false,
      showSymbol: input.buckets.length <= 1,
      lineStyle: { width: 2 },
      areaStyle: input.area ? { opacity: 0.12 } : undefined,
    })),
  };
}

/** One titled chart card whose option is rebuilt from the theme. */
function LineChartCard({
  title,
  description,
  buckets,
  granularity,
  series,
  yMax,
  area,
}: {
  title: string;
  description?: string;
  buckets: string[];
  granularity: Granularity;
  series: SeriesSpec[];
  yMax?: number;
  area?: boolean;
}) {
  const build = useCallback(
    (theme: ChartTheme) => lineOption(theme, { buckets, granularity, series, yMax, area }),
    [buckets, granularity, series, yMax, area],
  );
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent>
        <Chart buildOption={build} ariaLabel={title} />
      </CardContent>
    </Card>
  );
}

/**
 * The chart grid: message volume, token volume, user activity, and the mood trend.
 * All series keep a single y-scale (never dual-axis) and share the period axis.
 */
export function AnalyticsCharts({ metrics, mood }: { metrics: AnalyticsMetrics; mood: MoodPoint[] }) {
  const { buckets, granularity } = metrics;
  const perUser = metrics.scope === "user";

  const userSeries: SeriesSpec[] = [{ name: "Active users", data: metrics.users.active, slot: 0 }];
  if (metrics.users.new) userSeries.push({ name: "New users", data: metrics.users.new, slot: 1 });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <LineChartCard
        title="Message volume"
        description={perUser ? "This user's messages per period" : "Messages per period"}
        buckets={buckets}
        granularity={granularity}
        series={[
          { name: "From users", data: metrics.volume.human, slot: 0 },
          { name: "Bot replies", data: metrics.volume.bot, slot: 1 },
        ]}
      />
      <LineChartCard
        title="Tokens"
        description="Processed (prompt) vs generated (completion)"
        buckets={buckets}
        granularity={granularity}
        series={[
          { name: "Processed", data: metrics.tokens.processed, slot: 0 },
          { name: "Generated", data: metrics.tokens.generated, slot: 1 },
        ]}
        area
      />
      <LineChartCard
        title="Users"
        description={perUser ? "Activity for the selected user" : "Active and newly-seen users"}
        buckets={buckets}
        granularity={granularity}
        series={userSeries}
      />
      {mood.length > 0 ? (
        <LineChartCard
          title="Mood trend"
          description="Conversation mood (0–100) per period, from the insight job"
          buckets={mood.map((p) => p.bucket)}
          granularity={granularity}
          series={[{ name: "Mood", data: mood.map((p) => p.moodScore), color: STATUS.good }]}
          yMax={100}
          area
        />
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Mood trend</CardTitle>
              <CardDescription>Conversation mood (0–100) per period</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="py-10 text-center text-sm text-muted">
              No mood data yet — the nightly insight job scores each finished day. Run it from the card
              below to populate this.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
