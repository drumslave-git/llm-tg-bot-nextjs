"use client";

import { Bell, LogOut, Menu, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

/** Sticky dashboard top bar: mobile menu trigger, global search, and actions. */
export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="relative hidden max-w-sm flex-1 sm:block">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
        <Input
          type="search"
          placeholder="Search…"
          className="h-9 pl-9"
          aria-label="Search"
        />
      </div>

      <div className="flex flex-1 items-center justify-end gap-1">
        <ThemeToggle />
        <Button variant="ghost" size="icon" aria-label="Notifications">
          <Bell className="h-4.5 w-4.5" />
        </Button>
        <SignOutButton />
        <div className="ml-2">
          <Avatar name="Operator" size="sm" />
        </div>
      </div>
    </header>
  );
}

/** Ends the operator session (expires the cookie) and returns to /login. */
function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  }
  return (
    <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
      <LogOut className="h-4.5 w-4.5" />
    </Button>
  );
}
