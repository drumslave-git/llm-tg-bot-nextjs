import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { LlmUsage, Trace } from "@/lib/trace";

/**
 * Drizzle schema — single source of truth for the database structure.
 *
 * Migrations are generated from this file with `npm run db:generate` (SQL under
 * `db/migrations/`) and applied with `npm run db:migrate` and at server startup.
 * Only shared, cross-feature tables live here; feature-owned tables are added
 * alongside their feature.
 *
 * Ids are generated in application code (`crypto.randomUUID()`), so no
 * database extensions are required.
 */

/** One traced action (e.g. handling a single Telegram message). */
export const traces = pgTable(
  "traces",
  {
    id: text("id").primaryKey(),
    feature: text("feature").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    triggerKind: text("trigger_kind").notNull(),
    triggerActor: text("trigger_actor"),
    correlationId: text("correlation_id"),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    error: jsonb("error").$type<NonNullable<Trace["error"]>>(),
    relatedIds: jsonb("related_ids").$type<Record<string, string[]>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("traces_feature_started_idx").on(t.feature, t.startedAt.desc()),
    index("traces_correlation_idx").on(t.correlationId),
  ],
);

/** Ordered steps within a trace. */
export const traceEvents = pgTable(
  "trace_events",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    type: text("type").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"),
    usage: jsonb("usage").$type<LlmUsage>(),
  },
  (t) => [index("trace_events_trace_seq_idx").on(t.traceId, t.seq)],
);

/**
 * Application settings. A single, typed row (`id = 'singleton'`) holding the
 * operator-configurable, DB-backed configuration (entered via the dashboard,
 * not env vars). New settings are added as typed columns (with a default) plus a
 * migration — the repository always reads/writes the one row.
 */
export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().default("singleton"),
    /** Base URL of the OpenAI-compatible LLM endpoint (e.g. `.../v1`). */
    llmBaseUrl: text("llm_base_url"),
    /** Optional API key for the LLM endpoint. Secret — never returned in plaintext. */
    llmApiKey: text("llm_api_key"),
    /** Selected chat model id (from the endpoint's `/v1/models`). */
    model: text("model"),
    /**
     * The active personality (persona), chosen from the personalities list. Its
     * prompt is composed into the base system prompt on every reply. Null means
     * base prompt only. Cleared automatically (FK `on delete set null`) if the
     * referenced personality is deleted.
     */
    activePersonalityId: text("active_personality_id").references(() => personalities.id, {
      onDelete: "set null",
    }),
    /** Telegram Bot API token (from @BotFather). Secret — never returned in plaintext. */
    telegramBotToken: text("telegram_bot_token"),
    /** Tavily API key for the web-search MCP tool. Secret — never returned in plaintext. */
    tavilyApiKey: text("tavily_api_key"),
    /** Bot owner's Telegram @username (normalized: lowercase, no leading `@`). */
    ownerUsername: text("owner_username"),
    /**
     * Owner's numeric Telegram user id, resolved and persisted the first time the
     * configured @username messages the bot (Telegram has no lookup by username).
     */
    ownerUserId: text("owner_user_id"),
    /**
     * Maintenance mode. When on, only the owner can trigger LLM replies, and in
     * groups the owner must @mention the bot directly.
     */
    maintenanceModeEnabled: boolean("maintenance_mode_enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type SettingsRow = typeof settings.$inferSelect;
export type SettingsInsert = typeof settings.$inferInsert;

/**
 * Named personalities (personas). Each holds a prompt appended to the base system
 * prompt; the operator manages them on the Personalities page and picks the
 * active one (`settings.active_personality_id`). Names are unique
 * case-insensitively (enforced in the service). Ids are app-generated UUIDs.
 */
export const personalities = pgTable(
  "personalities",
  {
    id: text("id").primaryKey(),
    /** Display name (unique case-insensitively). */
    name: text("name").notNull(),
    /** Persona instructions appended to the base system prompt. */
    prompt: text("prompt").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("personalities_name_idx").on(t.name)],
);

export type PersonalityRow = typeof personalities.$inferSelect;
export type PersonalityInsert = typeof personalities.$inferInsert;

/**
 * Every Telegram user who has messaged the bot. Upserted (by numeric `user_id`)
 * on each incoming message so the operator can see who talks to the bot and pick
 * the owner from a concrete list. Telegram profile fields (`username`, names) are
 * refreshed on every message; `aliases` is operator-curated and never overwritten
 * by the passive upsert.
 */
export const knownUsers = pgTable(
  "known_users",
  {
    /** Numeric Telegram user id, as a string (ids exceed 2^53 safety). */
    userId: text("user_id").primaryKey(),
    /** Telegram @username (normalized: lowercase, no `@`), or null. */
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Operator-curated alternate names/nicknames. */
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("known_users_username_idx").on(t.username)],
);

export type KnownUserRow = typeof knownUsers.$inferSelect;
export type KnownUserInsert = typeof knownUsers.$inferInsert;

/**
 * Every Telegram group/supergroup the bot participates in. Upserted (by numeric
 * `chat_id`) on each incoming group message so the operator can see which groups
 * the bot is in. Telegram profile fields (`title`, `type`) are refreshed on every
 * message; `notes` is operator-curated (a free-text description of the group) and
 * never overwritten by the passive upsert. Mirrors {@link knownUsers}.
 */
export const knownGroups = pgTable("known_groups", {
  /** Numeric Telegram chat id, as a string (supergroup ids exceed 2^31). */
  chatId: text("chat_id").primaryKey(),
  /** Group title, refreshed on every message. */
  title: text("title"),
  /** Telegram chat type (`group` or `supergroup`). */
  type: text("type"),
  /** Operator-curated free-text description of the group. */
  notes: text("notes"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnownGroupRow = typeof knownGroups.$inferSelect;
export type KnownGroupInsert = typeof knownGroups.$inferInsert;

/**
 * Group ↔ user membership: which known users have been seen in which known
 * group. A row is recorded (and `last_seen_at` refreshed) whenever a user sends a
 * message in a group, so the roster of a group's participants is available for
 * context injection and the dashboard. The pair `(chat_id, user_id)` is unique.
 */
export const groupMembers = pgTable(
  "group_members",
  {
    /** The group the user was seen in. */
    chatId: text("chat_id")
      .notNull()
      .references(() => knownGroups.chatId, { onDelete: "cascade" }),
    /** The known user seen in the group. */
    userId: text("user_id")
      .notNull()
      .references(() => knownUsers.userId, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index("group_members_chat_idx").on(t.chatId),
    index("group_members_user_idx").on(t.userId),
  ],
);

export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type GroupMemberInsert = typeof groupMembers.$inferInsert;

/**
 * A 1:1 mirror of the Telegram conversation: every human message and every bot
 * reply, keyed by chat. Rows are captured passively on each incoming message (so
 * un-addressed group chatter is kept for context) and injected as prior turns
 * into the LLM request for the current day.
 *
 * This is an append-only log, so its primary key is a monotonic identity `id`
 * (extension-free, gives natural insertion order) rather than the app-UUID
 * convention used by entity tables. Uniqueness is on `(chat_id, telegram_message_id)`
 * so `edited_message` updates locate and rewrite the exact stored row.
 *
 * Note: Telegram's Bot API delivers `message` and `edited_message` but has no
 * deletion update for ordinary chats — a bot cannot observe user-initiated
 * deletions there. `deleted_at` exists so the mirror can represent deletions we
 * *can* know about (the bot's own deletions, or Business-connection delete
 * events); it is not populated by ordinary user deletions.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    /** Monotonic insertion order + PK. Append-only log — identity, not a UUID. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id, as a string (supergroup ids exceed 2^31). */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` within the chat (unique per chat). */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** `user` (a human) or `assistant` (the bot's reply). */
    role: text("role").notNull(),
    /** Sender's numeric Telegram user id for `user` rows; null for `assistant`. */
    userId: text("user_id"),
    /** Full message text (or media caption). */
    content: text("content").notNull(),
    /** Telegram `message_id` this message replied to, or null when not a reply. */
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }),
    /** When the message existed in Telegram (`message.date`) — the mirror's clock. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Set when a later `edited_message` update rewrote the content. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Set when the message is known to be deleted (see table note). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** When we captured the row (may differ from `sent_at`). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_messages_chat_msg_idx").on(t.chatId, t.telegramMessageId),
    index("chat_messages_chat_sent_idx").on(t.chatId, t.sentAt),
  ],
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessageInsert = typeof chatMessages.$inferInsert;

/**
 * Visual media attached to a Telegram message (photo, sticker, image document,
 * animation/video frame). One row per media-bearing message, keyed the same way
 * as {@link chatMessages} so the two join on `(chat_id, telegram_message_id)`.
 *
 * Lifecycle:
 *  - On ingestion the normalized image is stored as base64 (`data_base64`) with
 *    `status = 'pending'` — the raw bytes the vision model reads.
 *  - Once described (immediately for the addressed turn, later via the vision
 *    backfill job for the rest) the model's text description is written to
 *    `description`, `data_base64` is cleared, and `status = 'described'`. This
 *    keeps long-term history token-light: past turns carry a text description,
 *    not a megabyte of base64.
 *  - Media that cannot be loaded/decoded is `status = 'unavailable'` (no bytes,
 *    an operator-visible reason), so it is neither re-attempted nor lost.
 *
 * Ids are app-generated UUIDs (entity convention).
 */
export const messageMedia = pgTable(
  "message_media",
  {
    id: text("id").primaryKey(),
    /** Telegram chat id, as a string (matches `chat_messages.chat_id`). */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` the media is attached to. */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** Media kind: `photo` | `sticker` | `image_document` | `animation` | `video`. */
    kind: text("kind").notNull(),
    /** Telegram `file_id` — lets the backfill job re-download bytes if needed. */
    fileId: text("file_id").notNull(),
    /** Telegram `file_unique_id` (stable across bots), or null. */
    fileUniqueId: text("file_unique_id"),
    /** Mime hint of the stored image (always `image/jpeg` after normalization). */
    mimeType: text("mime_type"),
    /** Normalized JPEG as base64; null once described (bytes dropped) or unavailable. */
    dataBase64: text("data_base64"),
    /**
     * For a video/GIF: the normalized JPEG frames sampled from the clip, in
     * chronological order, as base64 — sent to the model as an ordered image
     * sequence. Null for a single still image (uses `data_base64`) and dropped
     * once described. `data_base64` holds the first frame for the dashboard preview.
     */
    framesBase64: jsonb("frames_base64").$type<string[]>(),
    /** Extra hint for the describer (e.g. a sticker's emoji), or null. */
    visionHint: text("vision_hint"),
    /** The vision model's text description; null until described. */
    description: text("description"),
    /** `pending` (bytes stored, awaiting description) | `described` | `unavailable`. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a description was produced and the bytes were dropped. */
    describedAt: timestamp("described_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("message_media_chat_msg_idx").on(t.chatId, t.telegramMessageId),
    // Backfill (priority 8) scans for pending rows oldest-first.
    index("message_media_status_idx").on(t.status, t.createdAt),
  ],
);

export type MessageMediaRow = typeof messageMedia.$inferSelect;
export type MessageMediaInsert = typeof messageMedia.$inferInsert;

export type TraceRow = typeof traces.$inferSelect;
export type TraceInsert = typeof traces.$inferInsert;
export type TraceEventRow = typeof traceEvents.$inferSelect;
export type TraceEventInsert = typeof traceEvents.$inferInsert;
