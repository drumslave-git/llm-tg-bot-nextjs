# Next.js Rewrite Progress

Use this file as the working progress ledger for agents. Update it before and after substantial work.

Status values:

- `todo`
- `in-progress`
- `blocked`
- `done`
- `deferred`

## Current Summary

Status: in-progress
Owner: agent/2026-07-09
Last updated: 2026-07-09
Proof: `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (21 unit), `npm run test:integration` ✓ (7, real Postgres via Testcontainers), `npm run build` ✓, `npm run db:migrate` ✓ (drizzle-kit applies migrations to a fresh DB)
Next: Phase 3 settings (DB-backed) using Drizzle + `server/http.ts`, then define acceptance criteria for priority 1 (bot messaging text receive/reply)

### Session log

- 2026-07-09: Completed Phase 1 foundation. Established folder boundaries
  (`app/`, `components/`, `features/`, `server/`, `db/`, `lib/`, `test/`), added
  `typecheck`/`test` scripts + Node engine, and built the first shared
  infrastructure: API error shape (`lib/api-error.ts`), trace contract
  (`lib/trace.ts`), server-only env access with `_FILE` secret support
  (`server/env.ts`), shared Route Handler wrapper (`server/http.ts`), a health
  Route Handler, the dashboard shell (layout + nav + overview + status cards),
  and a Vitest harness. Dependencies added intentionally: `zod`, `server-only`,
  `vitest`. Deferred to their phases: `pg` (Phase 2), `grammy` (Phase 4),
  `openai` (Phase 5), `playwright`/`sharp` (later features).
- 2026-07-09: Completed Phase 2 persistence foundation on **Drizzle ORM +
  migrations** (per user decision). DB layer in `db/`: Drizzle schema
  (`schema.ts`), pooled Drizzle handle (`pool.ts` + `drizzle.ts`, `getDb()`),
  and generated SQL migrations (`db/migrations/0000_init.sql`). Shared trace
  persistence + recorder in `server/trace/` (`repository.ts` via Drizzle query
  builder; `recorder.ts` with `startTrace().event()/succeed()/skip()/fail()`).
  Migrations run only via drizzle's own tools: `npm run db:migrate`
  (drizzle-kit) — which the Docker entrypoint will call before `next start` at
  deploy — and drizzle's programmatic migrator inline in the test helper. No
  in-app/instrumentation auto-migration. Tests: unit suite (21) stays
  Docker-free; DB integration suite (7) runs against real Postgres via
  **Testcontainers** (`test/db.ts`, `*.integration.test.ts`,
  `vitest.integration.config.ts`). Deps: `drizzle-orm`, `pg`; dev: `drizzle-kit`,
  `@testcontainers/postgresql`, `@next/env`, `@types/pg`. Removed `pg-mem`.

## Phase Progress

| Phase | Status | Proof | Next |
| --- | --- | --- | --- |
| Phase 0: Product and Behavior Inventory | todo | none | Define v1 must-have/nice/drop list |
| Phase 1: Next.js Foundation | done | lint/typecheck/test/build all pass; folders + scripts + shared infra in place | Documented in README "Repository Layout" |
| Phase 2: Data Model and Persistence | in-progress | Drizzle schema + migrations + trace repository/recorder; unit 21 + integration 7 (Testcontainers); `db:migrate` verified | Add feature tables (chats/messages/settings) with their features |
| Phase 3: Configuration and Settings | todo | none | Define env/settings schemas |
| Phase 4: Telegram Bot Interface | todo | none | Decide webhook-first bot intake design |
| Phase 5: LLM Conversation Core | todo | none | Design provider and conversation service |
| Phase 6: Dashboard Shell | todo | none | Build shared dashboard primitives |
| Phase 7: Realtime and Status Updates | todo | none | Choose polling/SSE per live status need |
| Phase 8: Background Work Design | todo | none | Choose operating model per job |
| Phase 9: Feature Recreation | todo | none | Start features in priority order |
| Phase 10: Testing Strategy | todo | none | Configure unit/route/dashboard tests |
| Phase 11: Docker and Self-Hosting | todo | none | Draft standard Next Dockerfile |
| Phase 12: Cutover | todo | none | Prepare backup and rollback checklist |

## Feature Progress

This is the authoritative implementation order. Each feature is not done until it has acceptance criteria, shared-pattern implementation, Debug page, trace recording, log/trace download, and tests.

Features not listed here are not v1 by default. Add any additional feature to this table with explicit priority and dependencies before implementation.

| Priority | Feature | Status | Acceptance Criteria | Debug Page | Trace/Log Download | Tests | Dependencies | Next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Bot messaging: text receive/reply | todo | missing | no | no | no | settings, health, Telegram intake, LLM provider, shared traces | Decide webhook-first intake design |
| 2 | System and personality prompts | todo | missing | no | no | no | settings, LLM provider | Define prompt schema and composition |
| 3 | History feature | todo | missing | no | no | no | bot messaging, shared traces, DB schema | Design messages/history schema |
| 4 | MCP tools basic support | todo | missing | no | no | no | LLM core, shared traces | Design tool registry and tool-call loop |
| 5 | Search MCP tool | todo | missing | no | no | no | MCP basic support | Define Tavily/search boundary |
| 6 | Visit/read link MCP tool | todo | missing | no | no | no | MCP basic support | Define fetch/read/SSRF policy |
| 7 | Bot messaging: vision | todo | missing | no | no | no | bot messaging, media schema, LLM provider | Define media intake and vision context |
| 8 | Vision backfill background job | todo | missing | no | no | no | bot vision, background job model | Define backfill locking/status model |
| 9 | Mood feature | todo | missing | no | no | no | prompts, history, settings | Define mood state and prompt injection |
| 10 | Scheduled tasks feature | todo | missing | no | no | no | background job model, bot messaging | Define task scheduler operating model |
| 11 | Memory feature | todo | missing | no | no | no | history, prompts, background job model | Define memory scope and extraction flow |
| 12 | Image generation | todo | missing | no | no | no | settings, LLM/tool provider, shared traces | Define image provider boundary |
| 13 | Browser agent feature | todo | missing | no | no | no | background job model, link/browser policies, shared artifacts | Decide v1 scope and operating model |

## Foundation Progress

Foundation work supports features but is not a substitute for feature completion.

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Settings and health | in-progress | `server/env.ts` (zod + `_FILE` secrets, tested), `/api/health` route | Add DB-backed settings schema + Route Handlers (Phase 3) |
| LLM provider core | todo | none | Design provider client and error handling |
| Telegram intake foundation | todo | none | Decide webhook-first route shape |
| Dashboard overview | in-progress | `app/page.tsx` overview with config status cards, layout shell + nav | Add live/DB status once persistence lands |
| Debug traces and LLM usage | in-progress | `lib/trace.ts` types + `server/trace` recorder/repository on Drizzle, tested | Add Debug UI + trace-context in Route Handler wrapper |

## Shared Infrastructure Progress

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Shared Route Handler wrapper | done | `server/http.ts` (`defineRoute`, `ok`, `parseJson`, `parseQuery`, `toApiError`) + tests | Add trace-context integration when recorder lands |
| Shared error shape | done | `lib/api-error.ts` (`ApiError`, code→status map, envelope) + tests | — |
| Shared trace schema | done | `lib/trace.ts` types + `db/schema.ts` tables + `server/trace` repository/recorder, tested | Wire recorder into features as they land |
| Shared log/trace export | in-progress | `traceBundleSchema` + `getTrace`/`listTraces` queries | Implement export Route Handler + download button (needs debug UI) |
| Shared dashboard layout | done | `app/layout.tsx` shell + `components/DashboardNav.tsx` | Add active-route highlight + real feature links |
| Shared form components | todo | none | Define field/error pattern |
| Shared table/filter components | todo | none | Define pagination/filter API |
| Shared debug components | todo | none | Define trace list/detail/download UI |
| Shared status components | in-progress | `components/StatusCard.tsx`, `components/PageHeader.tsx` | Add badges + loading/empty/error states |
| Test harness | done | Vitest unit config (21) + Testcontainers integration config (7); `server-only` alias stub | Add Route Handler + dashboard smoke tests per feature |

## Decision Notes

Per user preference, decisions are made by asking the user directly, not by
writing `docs/decisions/*.md`. This table is the lightweight record.

| Topic | Status | Decided by | Decision |
| --- | --- | --- | --- |
| ORM / persistence | done | user | Drizzle ORM + drizzle-kit migrations |
| Migration workflow | done | user | `generate` committed SQL files; applied via `drizzle-kit migrate` (`npm run db:migrate`), run by the Docker entrypoint before `next start`. No in-app auto-migration (instrumentation approach rejected as non-standard). |
| DB test strategy | done | user | Real Postgres via Testcontainers (integration suite) |
| MVP data import | done | agent default | Out of scope for v1 (fresh DB) — reconfirm with user if import is needed before cutover |
| Telegram webhook vs polling | todo | — | undecided |
| Realtime polling vs SSE vs WebSocket | todo | — | undecided |
| Background job operating model | todo | — | undecided |

## Blockers

No blockers recorded.

## Next Agent Notes

- Read `NEXTJS_REWRITE_PLAN.md` first.
- Confirm v1 scope before implementation.
- Do not copy MVP modules by default.
- Keep shared patterns ahead of feature-specific code.

### Current state (2026-07-09)

- Phases 1 and 2 done/verified: `npm run lint`, `npm run typecheck`,
  `npm run test` (21 unit), `npm run test:integration` (7, Testcontainers),
  `npm run build`, and `npm run db:migrate` all pass. Health route smoke-tested
  live.
- Persistence is **Drizzle ORM**. Schema in `db/schema.ts`; migrations in
  `db/migrations/` (`npm run db:generate` after schema changes). Drizzle handle
  via `getDb()`; migrations applied with `npm run db:migrate` (drizzle-kit) —
  the Docker entrypoint will run this before `next start`. No in-app
  auto-migration.
- Shared infra ready to build on: `lib/api-error.ts`, `lib/trace.ts`,
  `server/env.ts`, `server/http.ts`, `db/*`, `server/trace/*` (recorder +
  repository), dashboard shell + components.
- Trace recording pattern for features: `const t = await startTrace({feature,
  action, trigger, inputSummary}); await t.event({...}); await t.succeed({...})`
  (or `t.fail(err)` / `t.skip(reason)`). Defaults to `getDb()`; inject a
  `DrizzleDb` in tests.

### Next best task

- Phase 3 settings (DB-backed): add a `settings` table to `db/schema.ts` (then
  `npm run db:generate`), a zod-validated settings service + repository,
  `app/api/settings` Route Handlers using `defineRoute`, and a settings
  dashboard page. Record settings writes via the trace recorder.
- Then define acceptance criteria for feature priority 1 (bot text receive/reply).

### Testing DB work

- DB tests are integration tests against real Postgres via Testcontainers
  (Docker required). Name them `*.integration.test.ts`; start a container per
  file with `startTestDb()` from `test/db.ts` (`beforeAll`), `truncate()`
  between tests, `stop()` in `afterAll`. Run with `npm run test:integration`.
- `npm run test` (unit) excludes integration tests and needs no Docker.
- After changing `db/schema.ts`, run `npm run db:generate` and commit the new
  `db/migrations/*.sql`. Integration tests apply migrations, so a missing
  migration will surface there.

### Known pitfalls

- The Bash tool's working directory persists across calls. Do not leave `cwd`
  inside `node_modules`: an earlier `cd` into a docs folder caused `npm install`
  to walk up and install into `node_modules/next/`. Always `cd` back to the repo
  root (or use absolute paths) before running `npm install`.
- `server-only` throws when imported outside an RSC bundle, which breaks Vitest.
  It is aliased to `test/stubs/empty.ts` in `vitest.config.ts`; keep that alias
  when adding tests for server modules.
- Stale `.next/types` can fail `tsc` after routes change. `rm -rf .next` and
  rebuild (or run `next typegen`) to regenerate route types before typecheck.

### Commands that passed

- `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`
