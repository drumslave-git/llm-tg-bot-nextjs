"use client";

import { useState, type ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SegmentedControl,
  Select,
  Spinner,
  type SegmentedOption,
} from "@/components/ui";

import { GRANULARITIES, GRANULARITY_LABELS, type CardFilters, type Granularity } from "../types";

/**
 * The dashboard's one filtered-card shell.
 *
 * Every analytics card carries its own period and chat/user scope — there is no
 * page-level filter — so this owns that whole contract in one place: the controls,
 * the per-card state, the loading and error affordances, and the layout that keeps
 * a header readable once three controls sit in it. A card supplies its title and
 * how to render its data; nothing else.
 *
 * Cards that describe the *bot* rather than a slice of conversation (bot health,
 * model performance, top users) take no filters at all and are plain server-
 * rendered `Card`s — they deliberately do not use this.
 */

/** A selectable chat or user for the drill-down filter. */
export interface FilterOption {
  id: string;
  label: string;
}

const PERIOD_OPTIONS: SegmentedOption<Granularity>[] = GRANULARITIES.map((g) => ({
  value: g,
  label: GRANULARITY_LABELS[g],
}));

export const DEFAULT_CARD_FILTERS: CardFilters = { granularity: "day", chatId: null, userId: null };

export function FilterableCard({
  title,
  description,
  chats,
  users,
  defaultFilters = DEFAULT_CARD_FILTERS,
  children,
}: {
  title: string;
  description?: string;
  chats: FilterOption[];
  users: FilterOption[];
  /** Starting filters — e.g. the mood cards open on the week, not the day. */
  defaultFilters?: CardFilters;
  /** Renders the card body for the current filters. */
  children: (filters: CardFilters) => ReactNode;
}) {
  const [filters, setFilters] = useState<CardFilters>(defaultFilters);

  // Chat and user are mutually exclusive scopes: a chat is a conversation, a user
  // is a person across conversations, and intersecting them answers a question
  // nobody asked. Choosing one clears the other.
  function setChat(chatId: string | null) {
    setFilters((f) => ({ ...f, chatId, userId: null }));
  }
  function setUser(userId: string | null) {
    setFilters((f) => ({ ...f, userId, chatId: null }));
  }

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            ariaLabel={`Period for ${title}`}
            options={PERIOD_OPTIONS}
            value={filters.granularity}
            onChange={(granularity) => setFilters((f) => ({ ...f, granularity }))}
          />
          <Select
            aria-label={`Chat for ${title}`}
            className="h-8 w-auto min-w-32 max-w-44 text-xs"
            value={filters.chatId ?? ""}
            onChange={(e) => setChat(e.target.value || null)}
          >
            <option value="">All chats</option>
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label={`User for ${title}`}
            className="h-8 w-auto min-w-32 max-w-44 text-xs"
            value={filters.userId ?? ""}
            onChange={(e) => setUser(e.target.value || null)}
          >
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardContent>{children(filters)}</CardContent>
    </Card>
  );
}

/**
 * The shared body states for a card that fetches. Kept here so a slow query, a
 * failed one, and an empty one look the same on every card.
 */
export function CardBody({
  loading,
  error,
  hasData,
  emptyMessage,
  children,
}: {
  loading: boolean;
  error: string | null;
  hasData: boolean;
  emptyMessage: string;
  children: ReactNode;
}) {
  if (error) return <p className="py-8 text-center text-sm text-danger">{error}</p>;
  if (!hasData) {
    return loading ? (
      <div className="flex justify-center py-8" aria-label="Loading">
        <Spinner />
      </div>
    ) : (
      <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
    );
  }
  // Data is already on screen: dim it rather than replacing it, so changing period
  // never blanks the card.
  return <div className={loading ? "opacity-60 transition-opacity" : undefined}>{children}</div>;
}
