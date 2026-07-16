"use client";

import {
  Activity,
  Cpu,
  Gauge,
  Image as ImageIcon,
  MessageSquare,
  Sparkles,
  ThumbsUp,
  Timer,
  Users,
} from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { featureLabel } from "@/lib/features";

import { formatCompact, formatMs, formatNumber, formatPercent } from "../format";
import {
  GRANULARITY_LABELS,
  type CardFilters,
  type HealthSignals,
  type ModelStat,
  type PeriodInsight,
  type RequestTypeStat,
  type TotalsPayload,
  type UserStat,
} from "../types";
import { CardBody, FilterableCard, type FilterOption } from "./FilterableCard";
import { useCardData } from "./useCardData";

/** Badge tone for a mood score. */
function moodTone(score: number): BadgeTone {
  if (score >= 60) return "success";
  if (score >= 45) return "neutral";
  if (score >= 25) return "warning";
  return "danger";
}

/* ------------------------------------------------------------------------- *
 * Filtered cards — each owns its own period and chat/user scope.
 * ------------------------------------------------------------------------- */

/**
 * The traffic tiles. The four tiles share one filter rather than carrying four:
 * they are one measurement of one window from four angles, and a filter bar per
 * tile would be larger than the tile it filtered.
 */
export function TrafficCard({ chats, users }: { chats: FilterOption[]; users: FilterOption[] }) {
  return (
    <FilterableCard
      title="Traffic"
      description="Volume of messages, tokens, and people"
      chats={chats}
      users={users}
    >
      {(filters) => <TrafficBody filters={filters} />}
    </FilterableCard>
  );
}

function TrafficBody({ filters }: { filters: CardFilters }) {
  const { data, error, loading } = useCardData<TotalsPayload>("/api/analytics/metrics", filters);
  return (
    <CardBody
      loading={loading}
      error={error}
      hasData={data != null}
      emptyMessage="No traffic in this period."
    >
      {data ? <TrafficTiles payload={data} /> : null}
    </CardBody>
  );
}

function TrafficTiles({ payload }: { payload: TotalsPayload }) {
  const t = payload.totals;
  const perUser = payload.scope === "user";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Messages"
        value={formatNumber(t.messages)}
        icon={MessageSquare}
        accent
        hint={`${formatNumber(t.humanMessages)} in · ${formatNumber(t.botMessages)} out`}
      />
      <StatCard
        label="Tokens processed"
        value={formatCompact(t.tokensProcessed)}
        icon={Cpu}
        hint="Prompt tokens in"
      />
      <StatCard
        label="Tokens generated"
        value={formatCompact(t.tokensGenerated)}
        icon={Cpu}
        hint="Completion tokens out"
      />
      <StatCard
        label={perUser ? "Media" : "Active users"}
        value={perUser ? formatNumber(t.media) : formatNumber(t.activeUsers)}
        icon={perUser ? ImageIcon : Users}
        hint={perUser ? "Media in window" : `${formatNumber(t.media)} media items`}
      />
    </div>
  );
}

/** Which stored insight field a card shows — the three cards differ only in this. */
type InsightKind = "mood" | "word" | "topic";

/**
 * One LLM-derived insight card (mood, word of the period, or top topic), with its
 * own filters. The three read the same stored roll-up, so they share everything but
 * the field they render.
 */
export function InsightCard({
  kind,
  chats,
  users,
}: {
  kind: InsightKind;
  chats: FilterOption[];
  users: FilterOption[];
}) {
  const title = kind === "mood" ? "Mood" : kind === "word" ? "Word of the period" : "Top topic";
  const description =
    kind === "mood"
      ? "Message-weighted conversation mood"
      : kind === "word"
        ? "The period distilled to one word"
        : "What was discussed most";
  return (
    <FilterableCard title={title} description={description} chats={chats} users={users}>
      {(filters) => <InsightBody kind={kind} filters={filters} />}
    </FilterableCard>
  );
}

function InsightBody({ kind, filters }: { kind: InsightKind; filters: CardFilters }) {
  // The insight roll-ups are stored per chat, never per user: they are scored from
  // a chat's whole conversation, so there is no per-person slice to read.
  const scope = filters.chatId ? "chat" : "global";
  const { data, error, loading } = useCardData<PeriodInsight | null>(
    "/api/analytics/insights",
    { ...filters, userId: null },
    { scope },
  );
  return (
    <CardBody
      loading={loading}
      error={error}
      hasData={data != null}
      emptyMessage="Not computed yet — the nightly insight job scores each finished day."
    >
      {data ? <InsightValue kind={kind} insight={data} /> : null}
    </CardBody>
  );
}

/**
 * Names the exact period an insight covers — "Day 2026-07-15", not "the day".
 *
 * Insights only ever cover **finished** days, so the newest day bucket is normally
 * yesterday. A card headed "Mood" over a period called "the day" reads as *today's*
 * mood, which it never is; naming the bucket is the difference between a stale
 * number and a dated one.
 */
function periodLabel(insight: PeriodInsight): string {
  return insight.granularity === "all"
    ? "All time"
    : `${GRANULARITY_LABELS[insight.granularity]} ${insight.bucket}`;
}

function InsightValue({ kind, insight }: { kind: InsightKind; insight: PeriodInsight }) {
  if (kind === "mood") {
    return (
      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Gauge className="mb-1.5 h-4 w-4 text-muted" aria-hidden />
          <span className="text-3xl font-semibold tabular-nums">{insight.moodScore}</span>
          <Badge tone={moodTone(insight.moodScore)} className="mb-1">
            {insight.moodLabel}
          </Badge>
        </div>
        <p className="text-xs text-faint">
          {periodLabel(insight)} · weighted across {insight.sourceDays} day(s) ·{" "}
          {formatNumber(insight.messageCount)} messages
        </p>
      </div>
    );
  }

  const value = kind === "word" ? insight.wordOfPeriod : insight.topTopic;
  const Icon = kind === "word" ? Sparkles : MessageSquare;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <p className={kind === "word" ? "text-2xl font-semibold break-words" : "text-lg font-medium break-words"}>
          {value}
        </p>
      </div>
      <p className="text-xs text-faint">
        {periodLabel(insight)} · computed <Timestamp iso={insight.computedAt} /> · {insight.model}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * System cards — the bot itself, over all history. No filters by design.
 * ------------------------------------------------------------------------- */

/** One deterministic health sub-signal tile. */
function HealthTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Gauge;
  tone?: BadgeTone;
}) {
  const toneText: Record<BadgeTone, string> = {
    neutral: "text-foreground",
    primary: "text-primary",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    info: "text-info",
  };
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneText[tone]}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-faint">{hint}</div> : null}
    </div>
  );
}

/**
 * Bot health: three deterministic measurements over all history.
 *
 * There is no composite score badge. Averaging satisfaction, reliability, and speed
 * into one "health" number required weights nobody chose, and the result was an
 * opinion wearing the clothes of a measurement.
 */
export function BotHealthPanel({ health }: { health: HealthSignals }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Bot health</CardTitle>
          <CardDescription>Deterministic signals across all history</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <HealthTile
            icon={ThumbsUp}
            label="Satisfaction"
            value={health.satisfaction === null ? "—" : formatPercent(health.satisfaction)}
            hint={`${health.feedbackUp} up · ${health.feedbackDown} down`}
            tone={health.satisfaction === null ? "neutral" : health.satisfaction >= 0.6 ? "success" : "warning"}
          />
          <HealthTile
            icon={Activity}
            label="Error rate"
            value={health.errorRate === null ? "—" : formatPercent(health.errorRate)}
            hint={`${health.botErrors}/${health.botTraces} replies`}
            tone={health.errorRate === null ? "neutral" : health.errorRate <= 0.05 ? "success" : "danger"}
          />
          <HealthTile
            icon={Timer}
            label="Avg reply"
            value={health.avgReplyLatencyMs === null ? "—" : formatMs(health.avgReplyLatencyMs)}
            hint="Model latency, reply calls only"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** A request type's human name: the feature it belongs to, plus what it did. */
function requestTypeLabel(r: RequestTypeStat): string {
  return `${featureLabel(r.feature)} · ${r.action}`;
}

/**
 * Model performance, broken down by request type.
 *
 * Latency is reported per request type, never per model: one model serves image
 * descriptions, tool-looping replies, and one-line auxiliary prompts, and a single
 * average over that mix tracks the mix rather than the model. Each type carries a
 * median and a p95 alongside the mean, because a mean alone hides the tail.
 */
export function ModelTable({ models }: { models: ModelStat[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Model performance</CardTitle>
          <CardDescription>
            Speed and token volume by model and request type, all history, all chats
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="text-sm text-muted">No LLM calls recorded yet.</p>
        ) : (
          <Table minWidth={720}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Model / request type</TableHeaderCell>
                <TableHeaderCell align="right">Calls</TableHeaderCell>
                <TableHeaderCell align="right">Avg</TableHeaderCell>
                <TableHeaderCell align="right">p50</TableHeaderCell>
                <TableHeaderCell align="right">p95</TableHeaderCell>
                <TableHeaderCell align="right">Tokens/s</TableHeaderCell>
                <TableHeaderCell align="right">Prompt</TableHeaderCell>
                <TableHeaderCell align="right">Completion</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {models.map((m) => [
                <TableRow key={m.model}>
                  <TableCell className="font-medium">{m.model}</TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatNumber(m.calls)}
                  </TableCell>
                  {/* A model-wide latency mean would average unlike request types. */}
                  <TableCell align="right" className="text-faint">
                    —
                  </TableCell>
                  <TableCell align="right" className="text-faint">
                    —
                  </TableCell>
                  <TableCell align="right" className="text-faint">
                    —
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {m.tokensPerSec ?? "—"}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatCompact(m.promptTokens)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatCompact(m.completionTokens)}
                  </TableCell>
                </TableRow>,
                ...m.requestTypes.map((r) => (
                  <TableRow key={`${m.model}:${r.feature}:${r.action}`}>
                    <TableCell className="pl-8 text-muted">{requestTypeLabel(r)}</TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {formatNumber(r.calls)}
                    </TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {formatMs(r.avgLatencyMs)}
                    </TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {r.latencyP50 === null ? "—" : formatMs(r.latencyP50)}
                    </TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {r.latencyP95 === null ? "—" : formatMs(r.latencyP95)}
                    </TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {r.tokensPerSec ?? "—"}
                    </TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {formatCompact(r.promptTokens)}
                    </TableCell>
                    <TableCell align="right" className="tabular-nums">
                      {formatCompact(r.completionTokens)}
                    </TableCell>
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** The most active people, across all history. */
export function TopUsersPanel({ users }: { users: UserStat[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Top users</CardTitle>
          <CardDescription>Most active senders across all history</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <p className="text-sm text-muted">No messages recorded yet.</p>
        ) : (
          <Table minWidth={360}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell align="right">Messages</TableHeaderCell>
                <TableHeaderCell align="right">Tokens</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.userId}>
                  <TableCell className="font-medium">{u.label}</TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatNumber(u.messages)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatCompact(u.tokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
