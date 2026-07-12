import type { ChatMessage } from "@/server/llm/client";
import type { ChatMessageRecord } from "./repository";

/**
 * Pure helpers for turning stored history rows into LLM prior turns and for the
 * "current day" window boundary. No DB or secrets, so they are unit-testable in
 * isolation.
 *
 * History is injected as structured prior turns (real `user`/`assistant`
 * messages placed between the system prompt and the current message), which
 * keeps the system prompt byte-stable across turns (cache-friendly) and matches
 * the idiomatic chat-completions shape. In a group chat, each human turn is
 * prefixed with the sender's label so speaker identity survives the flattening
 * into a single `user` role.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start of the UTC day containing `now`. The recent-history window is scoped to
 * "today" by this boundary. UTC is used for a deterministic, timezone-free
 * definition of "day"; a per-operator timezone can be layered on later.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

/**
 * Render one stored row as an LLM prior turn. Assistant rows become `assistant`
 * messages; everything else becomes a `user` message. In a group, a resolved
 * speaker label (from `speakerLabels`, keyed by Telegram user id) is prefixed to
 * human turns as `Label: content`; private chats and assistant turns are left
 * unprefixed.
 */
export function toPriorTurn(
  record: ChatMessageRecord,
  options: { isGroup: boolean; speakerLabels?: ReadonlyMap<string, string> },
): ChatMessage {
  if (record.role === "assistant") {
    return { role: "assistant", content: record.content };
  }
  const label =
    options.isGroup && record.userId ? options.speakerLabels?.get(record.userId) : undefined;
  const content = label ? `${label}: ${record.content}` : record.content;
  return { role: "user", content };
}

/** Distinct non-null sender ids across a set of rows (for batch label lookup). */
export function collectUserIds(records: readonly ChatMessageRecord[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.userId) ids.add(record.userId);
  }
  return [...ids];
}
