import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    /** Telegram Bot API token (from @BotFather). Secret — never returned in plaintext. */
    telegramBotToken: text("telegram_bot_token"),
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

export type TraceRow = typeof traces.$inferSelect;
export type TraceInsert = typeof traces.$inferInsert;
export type TraceEventRow = typeof traceEvents.$inferSelect;
export type TraceEventInsert = typeof traceEvents.$inferInsert;
