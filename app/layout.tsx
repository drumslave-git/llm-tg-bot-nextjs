import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppShell } from "@/components/layout/AppShell";
import { ThemeScript } from "@/components/theme/theme-script";
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const readiness = await getConfigReadiness();

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
        <AppShell botStatus={readiness}>{children}</AppShell>
      </body>
    </html>
  );
}
