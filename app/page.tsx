import { Activity, Database, MessageSquare, Search, Zap } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { StatusCard, type StatusTone } from "@/components/StatusCard";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatCard,
} from "@/components/ui";
import { buildInfo } from "@/server/build-info";
import { envPresence } from "@/server/env";

// Read configuration at request time so a single built image reflects the
// runtime environment it is deployed into, not build-time values.
export const dynamic = "force-dynamic";

/**
 * Dashboard overview. Server Component: reads configuration presence directly
 * (no secrets exposed) so operators immediately see what is wired up. Doubles as
 * the first live reference of the shared UI kit.
 */
export default function OverviewPage() {
  const presence = envPresence();

  const configured = (present: boolean): { tone: StatusTone; value: string } =>
    present
      ? { tone: "ok", value: "Configured" }
      : { tone: "warn", value: "Not set" };

  const cards: { label: string; present: boolean; hint: string }[] = [
    { label: "Telegram token", present: presence.BOT_TOKEN, hint: "BOT_TOKEN" },
    { label: "LLM endpoint", present: presence.LLM_BASE_URL, hint: "LLM_BASE_URL" },
    { label: "Database", present: presence.DATABASE_URL, hint: "DATABASE_URL" },
    { label: "Web search", present: presence.TAVILY_API_KEY, hint: "TAVILY_API_KEY" },
  ];

  const ready = cards.filter((c) => c.present).length;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`llm-tg-bot dashboard — v${buildInfo.version}`}
        actions={
          <Button leftIcon={<Zap className="h-4 w-4" />}>Send test message</Button>
        }
      />

      {/* Headline metrics — placeholder values until persistence lands. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Setup progress"
          value={`${ready}/${cards.length}`}
          icon={Activity}
          hint="Configured capabilities"
          accent
        />
        <StatCard label="Messages today" value="0" icon={MessageSquare} hint="No traffic yet" />
        <StatCard label="LLM calls" value="0" icon={Zap} hint="Awaiting first turn" />
        <StatCard label="Searches" value="0" icon={Search} hint="Tavily idle" />
      </div>

      {/* Configuration status */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>
              Capability wiring detected from the runtime environment.
            </CardDescription>
          </div>
          <Badge tone={ready === cards.length ? "success" : "warning"} dot>
            {ready === cards.length ? "All set" : "Incomplete"}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((card) => {
              const state = configured(card.present);
              return (
                <StatusCard
                  key={card.label}
                  label={card.label}
                  value={state.value}
                  tone={state.tone}
                  hint={card.hint}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Recent activity — empty until history/traces exist. */}
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Database}
            title="No activity recorded yet"
            description="Once the bot starts handling messages, traces and events will appear here."
            action={<Button variant="outline" size="sm">View debug traces</Button>}
          />
        </CardContent>
      </Card>
    </>
  );
}
