import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { DashboardNav } from "@/components/DashboardNav";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="flex min-h-screen">
          <aside className="w-56 shrink-0 border-r border-black/10 dark:border-white/10">
            <DashboardNav />
          </aside>
          <main className="flex-1 p-6">
            <div className="mx-auto max-w-5xl space-y-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
