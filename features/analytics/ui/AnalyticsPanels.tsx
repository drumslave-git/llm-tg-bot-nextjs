import {
  Activity,
  Gauge,
  Hash,
  Image as ImageIcon,
  MessageSquare,
  Sparkles,
  ThumbsDown,
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

import { formatCompact, formatMs, formatNumber, formatPercent } from "../format";
import type { AnalyticsMetrics, HealthSignals, ModelStat, PeriodInsight, UserStat } from "../types";

/** Badge tone for a mood score. */
function moodTone(score: number): BadgeTone {
  if (score >= 60) return "success";
  if (score >= 45) return "neutral";
  if (score >= 25) return "warning";
  return "danger";
}

/** The lead metric tiles: volume of messages, characters, users, media. */
export function SummaryTiles({ metrics }: { metrics: AnalyticsMetrics }) {
  const t = metrics.totals;
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
        label="Chars processed"
        value={formatCompact(t.charsProcessed)}
        icon={Hash}
        hint="Received from users"
      />
      <StatCard
        label="Chars generated"
        value={formatCompact(t.charsGenerated)}
        icon={Hash}
        hint="Written by the bot"
      />
      <StatCard
        label={metrics.scope === "user" ? "Media" : "Active users"}
        value={metrics.scope === "user" ? formatNumber(t.media) : formatNumber(t.activeUsers)}
        icon={metrics.scope === "user" ? ImageIcon : Users}
        hint={metrics.scope === "user" ? "Media in window" : `${formatNumber(t.media)} media items`}
      />
    </div>
  );
}

/** The LLM-derived cards: mood, word of the period, most-discussed topic. */
export function InsightCards({ insight }: { insight: PeriodInsight | null }) {
  if (!insight) {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Period insight</CardTitle>
            <CardDescription>Mood, word of the period, and top topic</CardDescription>
          </div>
          <Badge tone="neutral">Not computed yet</Badge>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">
            The nightly insight job scores mood and distils the word/topic of the period. Use
            &ldquo;Run now&rdquo; below to compute it for the first time.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-muted" aria-hidden />
              Mood
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-end gap-2">
            <span className="text-3xl font-semibold tabular-nums">{insight.moodScore}</span>
            <Badge tone={moodTone(insight.moodScore)} className="mb-1">
              {insight.moodLabel}
            </Badge>
          </div>
          <p className="text-xs text-faint">
            Weighted across {insight.sourceDays} day(s) · {formatNumber(insight.messageCount)} messages
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted" aria-hidden />
            Word of the period
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold break-words">{insight.wordOfPeriod}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted" aria-hidden />
            Most-discussed topic
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-medium break-words">{insight.topTopic}</p>
          <p className="mt-1 text-xs text-faint">
            computed <Timestamp iso={insight.computedAt} /> · {insight.model}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

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

/** Deterministic chat-health panel (no LLM): satisfaction, reliability, speed. */
export function HealthPanel({ health }: { health: HealthSignals }) {
  const scoreTone: BadgeTone =
    health.score === null
      ? "neutral"
      : health.score >= 70
        ? "success"
        : health.score >= 45
          ? "warning"
          : "danger";
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Chat health</CardTitle>
          <CardDescription>Deterministic signals over the selected window</CardDescription>
        </div>
        <Badge tone={scoreTone} dot>
          {health.score === null ? "No data" : `Health ${health.score}/100`}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
            hint="Model latency"
          />
          <HealthTile icon={Users} label="Active users" value={formatNumber(health.activeUsers)} />
          <HealthTile
            icon={ThumbsDown}
            label="Feedback"
            value={formatNumber(health.feedbackUp + health.feedbackDown)}
            hint="Reactions in window"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** Per-model speed + token volume (a table, not a chart — identity + magnitude). */
export function ModelTable({ models }: { models: ModelStat[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Model performance</CardTitle>
          <CardDescription>Speed and token volume by model, across all chats</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="text-sm text-muted">No LLM calls recorded in this window.</p>
        ) : (
          <Table minWidth={560}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell align="right">Calls</TableHeaderCell>
                <TableHeaderCell align="right">Avg latency</TableHeaderCell>
                <TableHeaderCell align="right">Tokens/s</TableHeaderCell>
                <TableHeaderCell align="right">Prompt</TableHeaderCell>
                <TableHeaderCell align="right">Completion</TableHeaderCell>
                <TableHeaderCell align="right">Total</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.model}>
                  <TableCell className="font-medium">{m.model}</TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatNumber(m.calls)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatMs(m.avgLatencyMs)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {m.tokensPerSec === null ? "—" : m.tokensPerSec}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatCompact(m.promptTokens)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatCompact(m.completionTokens)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {formatCompact(m.totalTokens)}
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

/** Most-active users in the window. */
export function TopUsersPanel({ users }: { users: UserStat[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Top users</CardTitle>
          <CardDescription>Most active senders in the window</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <p className="text-sm text-muted">No user messages in this window.</p>
        ) : (
          <Table minWidth={360}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell align="right">Messages</TableHeaderCell>
                <TableHeaderCell align="right">Characters</TableHeaderCell>
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
                    {formatCompact(u.chars)}
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
