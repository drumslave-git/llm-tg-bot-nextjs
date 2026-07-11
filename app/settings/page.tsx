import { Database } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@/components/ui";
import { getSettings, listAvailableModels } from "@/features/settings/server/service";
import type { Settings } from "@/features/settings/server/schema";
import { SettingsForm } from "@/features/settings/ui/SettingsForm";

// Settings are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Settings dashboard page. Server Component: actually reads settings from the DB
 * for the initial render. If that read fails (DB unset/unreachable), it shows the
 * real error instead of a misleading "looks fine" — a genuine probe, not an
 * env-presence guess.
 */
export default async function SettingsPage() {
  let settings: Settings | null = null;
  let initialModels: string[] = [];
  let dbError: string | null = null;
  try {
    settings = await getSettings();
    // Preload the endpoint's models so the dropdown is populated on open.
    initialModels = await listAvailableModels();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read settings from the database";
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Connect an OpenAI-compatible LLM endpoint and choose the model."
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>LLM connection</CardTitle>
            <CardDescription>
              Stored in the database and used for every reply. Changes are recorded as a trace.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {settings ? (
            <SettingsForm initial={settings} initialModels={initialModels} />
          ) : (
            <EmptyState
              icon={Database}
              title="Database unavailable"
              description={dbError ?? "The settings database could not be reached."}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
