import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppShell } from "@/components/layout/AppShell";
import { ThemeScript } from "@/components/theme/theme-script";
import { TimezoneProvider } from "@/components/time/TimezoneProvider";
import { getTimezone } from "@/features/settings/server/service";
import { getConfigReadiness } from "@/server/status";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "llm-tg-bot",
  description: "Telegram LLM bot control dashboard",
};

// This is a live, DB-backed dashboard: every page already opts into dynamic
// rendering, and the layout reads settings (timezone, config readiness) from the
// database on each request. Declaring it here covers the whole tree — including
// Next's built-in /_not-found, which has no page.tsx of its own — so nothing is
// statically prerendered at build time, when DATABASE_URL is intentionally absent.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const readiness = await getConfigReadiness();
  // Every dashboard timestamp renders in this zone. Falls back to UTC when the
  // database is unreachable — the shell still renders its "database unavailable"
  // state rather than erroring on a formatting concern.
  const timezone = await getTimezone().catch(() => "UTC");

  return (
    <html
      lang="en"
      // Dark-first default; ThemeScript reconciles with the persisted choice
      // before hydration to prevent a flash.
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full">
        <TimezoneProvider timezone={timezone}>
          <AppShell botStatus={readiness}>{children}</AppShell>
        </TimezoneProvider>
      </body>
    </html>
  );
}
