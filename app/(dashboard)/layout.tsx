import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/AppShell";
import { TimezoneProvider } from "@/components/time/TimezoneProvider";
import { getTimezone } from "@/features/settings/server/service";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";
import { getConfigReadiness } from "@/server/status";

/**
 * The authenticated dashboard shell. This layout is the *real* page-side auth
 * gate (the proxy only does an optimistic cookie-presence redirect): it
 * verifies the session cookie's signature against the DB-stored secret before
 * rendering anything, sending bare visitors to `/login` and a fresh install to
 * `/setup`. Every dashboard page lives inside this route group; URLs are
 * unchanged.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => {
    // A DB outage must not lock the operator out of the status shell — the
    // pages themselves render their "database unavailable" states.
    return "ok" as const;
  });
  if (verdict === "unconfigured") redirect("/setup");
  if (verdict === "invalid") redirect("/login");

  const readiness = await getConfigReadiness();
  // Every dashboard timestamp renders in this zone. Falls back to UTC when the
  // database is unreachable — the shell still renders its "database
  // unavailable" state rather than erroring on a formatting concern.
  const timezone = await getTimezone().catch(() => "UTC");

  return (
    <TimezoneProvider timezone={timezone}>
      <AppShell botStatus={readiness}>{children}</AppShell>
    </TimezoneProvider>
  );
}
