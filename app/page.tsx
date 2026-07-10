import { Bug, Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";

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
} from "@/components/ui";
import { buildInfo } from "@/server/build-info";
import { getSystemStatus } from "@/server/status";

// Probe real state at request time (DB query + LLM endpoint call), so the
// overview reflects what actually works, not build-time or env-presence guesses.
export const dynamic = "force-dynamic";

interface StatusItem {
  label: string;
  tone: StatusTone;
  value: string;
  hint: string;
}

/**
 * Dashboard overview. Server Component: reads live {@link getSystemStatus} — a
 * real `SELECT 1` and a real `/v1/models` probe — so operators see honest state.
 */
export default async function OverviewPage() {
  const status = await getSystemStatus();

  const llmItem: StatusItem =
    status.llm.state === "connected"
      ? {
          label: "LLM endpoint",
          tone: "ok",
          value: "Connected",
          hint: `${status.llm.modelCount ?? 0} models available`,
        }
      : status.llm.state === "error"
        ? { label: "LLM endpoint", tone: "error", value: "Unreachable", hint: status.llm.detail }
        : { label: "LLM endpoint", tone: "warn", value: "Not configured", hint: status.llm.detail };

  const items: StatusItem[] = [
    {
      label: "Database",
      tone: status.db.connected ? "ok" : "error",
      value: status.db.connected ? "Connected" : "Unavailable",
      hint: status.db.detail,
    },
    llmItem,
    {
      label: "Model",
      tone: status.model.selected ? "ok" : "warn",
      value: status.model.selected ? "Selected" : "None",
      hint: status.model.detail,
    },
    {
      label: "Telegram bot",
      tone: "neutral",
      value: "Not built",
      hint: "Bot messaging — priority 1",
    },
  ];

  const operational = status.db.connected && status.llm.state === "connected" && status.model.selected;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`llm-tg-bot dashboard — v${buildInfo.version}`}
        actions={
          <Button asChild variant="outline" leftIcon={<SettingsIcon className="h-4 w-4" />}>
            <Link href="/settings">Settings</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>System status</CardTitle>
            <CardDescription>Live checks against the database and the configured LLM endpoint.</CardDescription>
          </div>
          <Badge tone={operational ? "success" : "warning"} dot>
            {operational ? "Operational" : "Setup needed"}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {items.map((item) => (
              <StatusCard
                key={item.label}
                label={item.label}
                value={item.value}
                tone={item.tone}
                hint={item.hint}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Bug}
            title="No trace viewer yet"
            description="Settings changes and connection tests are already recorded as traces; a Debug page to browse them is coming next."
          />
        </CardContent>
      </Card>
    </>
  );
}
