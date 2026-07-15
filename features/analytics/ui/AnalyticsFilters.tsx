"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Label, Select } from "@/components/ui";

import { GRANULARITIES, GRANULARITY_LABELS, type Granularity } from "../types";

/** A selectable chat or user for the drill-down filter. */
export interface FilterOption {
  id: string;
  label: string;
}

/**
 * Filter bar for the analytics dashboard. URL-driven (the page is a Server
 * Component that reads `searchParams` and re-queries), so a change navigates
 * rather than duplicating data on the client — the same SSR-first pattern the
 * other dashboard pages use. Chat and user are mutually exclusive scopes.
 */
export function AnalyticsFilters({
  granularity,
  chatId,
  userId,
  chats,
  users,
}: {
  granularity: Granularity;
  chatId: string | null;
  userId: string | null;
  chats: FilterOption[];
  users: FilterOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function navigate(next: { granularity?: Granularity; chatId?: string | null; userId?: string | null }) {
    const params = new URLSearchParams();
    const g = next.granularity ?? granularity;
    if (g !== "day") params.set("granularity", g);
    // chat and user are mutually exclusive; a new choice clears the other.
    const nextChat = next.chatId !== undefined ? next.chatId : next.userId !== undefined ? null : chatId;
    const nextUser = next.userId !== undefined ? next.userId : next.chatId !== undefined ? null : userId;
    if (nextChat) params.set("chatId", nextChat);
    if (nextUser) params.set("userId", nextUser);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/analytics?${qs}` : "/analytics"));
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="space-y-1">
        <Label htmlFor="an-granularity">Period</Label>
        <Select
          id="an-granularity"
          value={granularity}
          onChange={(e) => navigate({ granularity: e.target.value as Granularity })}
        >
          {GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {GRANULARITY_LABELS[g]}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="an-chat">Chat</Label>
        <Select
          id="an-chat"
          value={chatId ?? ""}
          onChange={(e) => navigate({ chatId: e.target.value || null })}
        >
          <option value="">All chats</option>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="an-user">User</Label>
        <Select
          id="an-user"
          value={userId ?? ""}
          onChange={(e) => navigate({ userId: e.target.value || null })}
        >
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
