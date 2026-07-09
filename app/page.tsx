import { PageHeader } from "@/components/PageHeader";
import { StatusCard, type StatusTone } from "@/components/StatusCard";
import { buildInfo } from "@/server/build-info";
import { envPresence } from "@/server/env";

// Read configuration at request time so a single built image reflects the
// runtime environment it is deployed into, not build-time values.
export const dynamic = "force-dynamic";

/**
 * Dashboard overview. Server Component: reads configuration presence directly
 * (no secrets exposed) so operators immediately see what is wired up. Live/DB
 * status cards are added as those foundations land.
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

  return (
    <>
      <PageHeader
        title="Overview"
        description={`llm-tg-bot dashboard — v${buildInfo.version}`}
      />
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Configuration
        </h2>
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
      </section>
    </>
  );
}
