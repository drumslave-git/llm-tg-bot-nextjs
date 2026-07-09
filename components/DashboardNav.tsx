import Link from "next/link";

/**
 * Persistent dashboard navigation. Feature pages are added here as they land;
 * items marked `soon` are placeholders for planned v1 features so the shell
 * reflects the intended shape without dead routes.
 */
const NAV_ITEMS: { href: string; label: string; soon?: boolean }[] = [
  { href: "/", label: "Overview" },
  { href: "/settings", label: "Settings", soon: true },
  { href: "/history", label: "History", soon: true },
  { href: "/debug", label: "Debug", soon: true },
];

export function DashboardNav() {
  return (
    <nav className="flex flex-col gap-1 p-4 text-sm">
      <div className="mb-3 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        llm-tg-bot
      </div>
      {NAV_ITEMS.map((item) =>
        item.soon ? (
          <span
            key={item.href}
            className="cursor-not-allowed rounded-md px-2 py-1.5 text-zinc-400 dark:text-zinc-600"
            title="Planned for v1"
          >
            {item.label}
          </span>
        ) : (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10"
          >
            {item.label}
          </Link>
        ),
      )}
    </nav>
  );
}
