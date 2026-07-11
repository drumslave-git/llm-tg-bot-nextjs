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
Owner: agent/2026-07-11
Last updated: 2026-07-11
Proof: `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (45 unit), `npm run test:integration` ✓ (15, real Postgres via Testcontainers), `npm run build` ✓ (0 warnings), `npm run db:migrate` ✓. Priority-1 **bot messaging (text receive/reply)** vertical slice is built and verified live: in-process long-polling bot (grammy) started from `instrumentation.ts`, controllable from the Overview; DB-backed bot token; deterministic addressing; LLM `chatCompletion`; traced replies. Verified live against the running dev server: autostart with no token logs a graceful "not started", Overview shows Telegram "Error — No Telegram bot token configured" with a Start control, `POST /api/telegram/bot` → 200, Settings renders the masked bot-token field; DB/LLM/model still real-probed (13 models, `gemma4:12B`).
Next: Feature 1 remains **in-progress** — still needs the shared Debug UI (trace list/detail + JSON download) to meet the feature contract, and an end-to-end run against a real bot token (operator-supplied). Then priority 2 (system/personality prompts).

### Session log

- 2026-07-11 (follow-up): **Bot-messaging UX polish + typing indicator.**
  - **Typing indicator**: added a `startTyping` collaborator to
    `BotMessagingDeps` — the service starts it the moment a message is addressed
    and stops it in a `finally` (covers success and error paths). The bot-manager
    implements it via `ctx.replyWithChatAction("typing")`, refreshed every 4.5s
    (Telegram expires the action after ~5s) and forum-thread-aware. Only visible
    in a Telegram client (not the dashboard); service tests assert it starts on an
    addressed message, stops when settled, and is never started for ignored ones.
  - **Settings UX fixes** (reported by user): (1) model dropdown was empty until
    "Test connection" — the page now preloads the endpoint's models server-side
    (`listAvailableModels`, best-effort 5s, never throws) and passes them to the
    form; (2) after Save the masked "configured" placeholder was stale until a
    re-nav — added `router.refresh()` after a successful save.
  - **Overview bot card fix**: the bot-manager treated "no token" as an `error`
    state, so a stale error persisted after saving a token. Changed no-token to a
    plain `stopped` state; the Overview now derives the card from DB token
    presence (Running / Stopped-ready / Not-configured), and `BotControl` disables
    Start (with a hint) until a token is saved. Verified live: models populate on
    open; a saved token autostarts the bot (shown Running `@…`).
  - Checks: lint ✓, typecheck ✓, unit 45 ✓, build ✓ (0 warnings).
- 2026-07-11: **Priority-1 feature — bot messaging: text receive/reply (vertical
  slice).** Decided the two open Phase-4 architecture questions with the user:
  Telegram intake is **long polling, in-process** (started from
  `instrumentation.ts`), **not** a separate worker (single self-hosted container,
  I/O-bound work — the event loop already gives concurrency; a worker/thread buys
  nothing here and is a contained change later if multi-replica/CPU-bound needs
  arise). Poller lifecycle: **autostart on boot** (fails gracefully with no
  token) **+ dashboard Start/Stop** controls, behind a `globalThis` bot-manager
  singleton (Telegram allows exactly one `getUpdates` consumer per token).
  - **Acceptance criteria (v1):** (1) operator sets LLM connection+model and a
    Telegram bot token in DB Settings; (2) poller runs in-process, autostarts,
    and is Start/Stop-controllable from the Overview with live status; (3) bot
    receives text via long polling; (4) addressing — private always; group only
    on @mention / reply-to-bot / `/cmd@bot`; un-addressed group chatter ignored;
    (5) ignores other bots, empty messages, (media deferred); (6) generates a
    reply via LLM `chatCompletion` using the configured model + a minimal default
    system prompt; (7) delivers the reply (plain text, quoted, 4096-char capped);
    (8) every handled message is traced (input→llm_request→llm_response w/ usage
    →output, or fail); (9) provider/config errors are caught, traced, and a
    fallback reply is sent. All met **except** the shared Debug page + trace
    download (feature-contract items, deferred below) and a live run with a real
    token.
  - **Files:** settings gained a secret `telegram_bot_token` column (migration
    `0002_lethal_logan.sql`) — schema/repository/service (masked as
    `telegramBotTokenConfigured`, redacted from traces) + `SettingsForm` field +
    server-only `getTelegramBotToken`/`getLlmRuntime` accessors. `server/llm/client.ts`
    gained `chatCompletion` (reply text + normalized usage + latency, shared
    `ApiError` mapping, empty-response → 503). New feature `features/bot-messaging/`:
    `server/addressing.ts` (pure, deterministic), `server/reply.ts` (plain-text
    format + truncate), `server/service.ts` (`handleIncomingMessage` — policy,
    trace, injected collaborators), `ui/BotControl.tsx`. Runtime:
    `server/telegram/bot-manager.ts` (singleton lifecycle: start/stop/status,
    reads token+LLM config from DB, wires grammy→service, `bot.catch`),
    `server/telegram/register-node.ts` (Node-only autostart + SIGTERM/SIGINT
    graceful stop), `instrumentation.ts` (dynamically imports register-node only
    on the Node runtime — keeps Node `process` APIs out of Edge analysis, so 0
    build warnings). API `app/api/telegram/bot` (`GET` status, `POST start|stop`).
    Overview rebuilt to show real bot status + control. Deps added: `grammy`,
    `@grammyjs/types`.
  - **Tests:** `addressing.test.ts` (10 — private/mention/reply/command/negatives),
    `service.test.ts` (5 — ignore paths, reply+trace, error→fallback; trace
    recorder mocked), `client.test.ts` (+2 — usage mapping, empty-response error),
    settings integration (+1 — bot-token masking + server-only retrieval).
  - **Deferred (feature-1 not `done` until):** shared Debug UI (trace
    list/detail/JSON viewer + download); markdown/HTML reply rendering (v1 is
    plain text); the MVP's LLM "analyzer" addressing fallback for
    other-language/name references in groups (costs an LLM call per group msg);
    media/vision intake (priority 7); grammy runner for concurrent update
    handling (built-in polling is sequential — fine for v1). Owner + maintenance
    mode also still pending (owner deferred to this phase originally — resolve
    with prompts/owner work).
  - Checks: lint ✓, typecheck ✓, unit 45 ✓, integration 15 ✓, build ✓ (0
    warnings), db:migrate ✓. Verified live in-browser (see Current Summary).
- 2026-07-10: **Re-validated `NEXTJS_REWRITE_PLAN.md` against the repo and the
  decision log; aligned it.** Drift fixed: (1) Phase 3 rewritten from the
  env-var config design onto the decided DB-backed Settings direction
  (bootstrap-only env, secrets write-only, real-probe status — memories
  `config-in-db-not-env`, `verify-real-state-not-env-presence`); (2) the
  standard feature contract now matches the implemented shape
  (`features/<f>/server` + `ui`, thin `app/api/**` handlers via `defineRoute`,
  shared `lib/api-error`/`server/trace` instead of per-feature
  `errors.ts`/`trace.ts`, colocated tests; `features/settings` named the
  reference); (3) every "write a design note in `docs/decisions/`" requirement
  replaced with the decided ask-the-user + Decision Notes table process
  (AGENTS.md updated to match; empty `docs/` dir removed); (4) decided items
  annotated inline in Phase 2 (Drizzle, committed SQL migrations,
  Testcontainers, fresh-DB/no-MVP-import). Also rewrote `.env.example` to the
  bootstrap-only contract — it still claimed `BOT_TOKEN`/`LLM_BASE_URL` were
  "Required" although only `DATABASE_URL` is consumed (`db/pool.ts`).
  Doc-only change (plus deleting the empty dir); no code touched. Known
  leftover: `server/env.ts` still declares superseded `LLM_*` /
  `EMBEDDING_*` / `IMAGE_GENERATION_*` / `TAVILY_API_KEY` keys — trim when a
  feature decision settles each, or as cleanup.
- 2026-07-10: **Reworked `/api/health` into a real readiness probe** and deleted
  the last env-presence code. `server/status.ts` gained `getHealth()` (gated on a
  real `SELECT 1`; DB-stored config presence as informational, **not** a readiness
  gate; no live LLM probe so healthchecks stay fast). `app/api/health/route.ts`
  now returns `200`/`503` by real DB reachability with `checks.database` +
  `checks.configuration`. Removed `envPresence()` (dead) from `server/env.ts` and
  its test. Added `server/status.integration.test.ts` (health ready path + config
  presence; system-status unconfigured path). Threaded an optional `db` param
  through `getSystemStatus`/`getConfigReadiness`/`getHealth` for testability.
  Checks: lint ✓, typecheck ✓, unit 28 ✓, integration 14 ✓, build ✓. Verified
  live: `GET /api/health` → 200 `{status:"ok", checks.database.ok:true,
  configuration.configured:true}`. `envPresence` is gone; `server/env.ts` still
  holds the env *contract* (DATABASE_URL etc.) — which keys stay env vs move to DB
  is a per-feature decision.
- 2026-07-10: **Reworked the Overview + shell off env presence onto real probes.**
  New `server/status.ts`: `getSystemStatus()` runs a real `SELECT 1` and a real
  `/v1/models` call (5s timeout) against the DB-saved LLM settings — never env
  presence. `app/page.tsx` rebuilt onto it (Database / LLM endpoint / Model /
  Telegram status cards; dropped the fabricated metric StatCards and the
  non-functional "Send test message" button; header links to Settings). Sidebar
  "Bot status" card was hardcoded "Setup needed / Connect a Telegram token" —
  now fed real, cheap DB-only readiness (`getConfigReadiness()`, no per-page LLM
  probe) threaded `layout.tsx → AppShell → Sidebar`; shows Configured/Setup
  needed and points to Overview for live status. Verified live: overview shows DB
  Connected, LLM Connected "13 models available", model `gemma4:12B`, Telegram
  "Not built"; sidebar "Configured". Checks: lint ✓, typecheck ✓, unit 29 ✓,
  build ✓. Note: `server/env.ts` `envPresence()` is now used only by
  `/api/health` (a liveness endpoint) — revisit if health should probe real
  state too.
- 2026-07-10: **Phase 3 — DB-backed LLM-connection settings** (first `features/`
  module). Major direction change from the user: **configuration moves out of env
  vars into DB-backed Settings entered via the dashboard** (bootstrap-only
  `DATABASE_URL` stays in env). See memory `config-in-db-not-env`. Grounded the
  design in the MVP reference (`../ollama-tg-bot`) after a first attempt shipped
  invented fields — corrected per user feedback (memories
  `no-placeholders-ask-instead`, `verify-real-state-not-env-presence`): dropped a
  fabricated "context message limit" and the free-text model input; the model is
  now a **select populated from the endpoint's `/v1/models`**, and config status
  is a **real probe**, never env presence.
  - Storage (user decision): **typed columns, single row** (`settings`,
    `id='singleton'` check constraint). v1 columns: `llm_base_url`,
    `llm_api_key` (secret), `model`. Migration `0001_equal_guardian.sql`
    (regenerated; the earlier invented migration was reverted and the dev DB
    reset).
  - Shared provider client `server/llm/client.ts` (server-only, `openai` dep):
    `toOpenAiBaseUrl` normalization + `listModels` (doubles as the health probe;
    clean `ApiError` mapping for timeout/connection/4xx). Connection is passed
    in (from DB settings), not read from env.
  - Feature `features/settings/server/`: `schema.ts` (zod; API key write-only —
    client shape exposes only `apiKeyConfigured`), `repository.ts` (typed Drizzle
    upsert; record includes the raw key, never returned), `service.ts`
    (`getSettings` masks the key; `updateSettings` + `testConnection` each record
    a trace; the key value is redacted from trace data). Routes:
    `app/api/settings` (`GET`/`PATCH`) + `app/api/settings/test-connection`
    (`POST`). Page `app/settings/page.tsx` actually queries the DB and shows the
    real error on failure (no env-presence gate). Client
    `features/settings/ui/SettingsForm.tsx`: URL + optional masked key → Test
    connection → model select from the endpoint → Save.
  - Tests: unit `features/settings/server/schema.test.ts` +
    `server/llm/client.test.ts`; integration
    `settings.integration.test.ts` (defaults, partial-merge, **key masking +
    trace redaction**, single-row invariant).
  - Checks: lint ✓, typecheck ✓, unit 29 ✓, integration 12 ✓, build ✓,
    `db:migrate` ✓. Verified live against a real endpoint: 13 models listed,
    model saved + persisted, key masked; unreachable host → 503, auth-required
    host → 400 with the provider message. Owner deferred to the Telegram phase.
    No Debug page yet — settings is a foundation area; traces surface once the
    shared Debug UI lands.
- 2026-07-10: Built the shared **UI kit** (dark-first, light supported) as the
  design foundation before feature migration. Token system in `app/globals.css`
  (semantic CSS vars → Tailwind v4 `@theme inline`, class-based `.dark`, custom
  scrollbars) so components consume semantic tokens (`bg-surface`, `text-muted`,
  `bg-primary`, …) instead of `dark:` duplication. Primitives in
  `components/ui/` (barrel `index.ts`): `Button` (variants/sizes + `asChild` via
  a minimal `Slot`), `Card` (+ Header/Title/Description/Content/Footer/Action),
  `Badge`, `Avatar`, `Progress`, `Separator`, form set (`Input`, `Textarea`,
  `Select`, `Label`, `Field`, `Switch`, `Checkbox` — CSS-peer, no client JS),
  `StatCard`, `EmptyState`, `Skeleton`/`Spinner`. `lib/cn.ts` (clsx +
  tailwind-merge). Responsive app frame in `components/layout/`: `AppShell`
  (fixed desktop rail + mobile off-canvas drawer w/ Escape + backdrop close),
  config-driven `Sidebar` (grouped nav, active state, `soon` markers, status
  card), `Topbar` (search + theme toggle + actions). Theme: `components/theme/`
  `ThemeToggle` (useSyncExternalStore over the DOM class) + pre-hydration
  `ThemeScript`. Refactored `app/layout.tsx`, `app/page.tsx` (live kit
  reference), `PageHeader`, `StatusCard` onto the kit; removed superseded
  `DashboardNav`. Deps added intentionally: `clsx`, `tailwind-merge`,
  `lucide-react`. Fixed two bugs found during in-browser verification: (1)
  `Button asChild` wrapped children in a fragment, breaking `Slot`'s single-child
  requirement; (2) the mobile drawer stayed pinned at its from-value under
  `prefers-reduced-motion` — added `motion-reduce:transition-none` (a11y-correct
  and resolves it). Verified live: tokens resolve (dark `#08080c` / light
  `#f6f6f8`, primary `#7c5cff`), theme toggle flips `.dark`, sidebar hides on
  mobile, drawer opens/closes. Checks: lint ✓, typecheck ✓, test ✓ (21), build ✓.
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

- 2026-07-09: Dockerized the app (Phase 11 brought forward so it can actually
  run). Multi-stage `Dockerfile` (deps → builder → runner, non-root) + `.dockerignore`
  + `docker-compose.yml` (app + `pgvector/pgvector:pg17` db, healthchecks, Postgres
  data bind-mounted to `./data/pg` via `PG_DATA_DIR`). Entrypoint runs migrations
  then serves — no in-app
  auto-migration. Moved `drizzle-kit` + `@next/env` to `dependencies` (runtime
  migrate needs them in the pruned image). Used `npm install` (not `npm ci`) in
  the build because the Windows-generated lockfile lacks Linux/musl optional
  native deps. Verified: `docker compose up` applies migrations, creates tables,
  serves dashboard + `/api/health` (DATABASE_URL true).
- 2026-07-09: Slimmed the image 1.76GB → **423MB** via Next `output: 'standalone'`.
  Because standalone excludes the drizzle-kit CLI toolchain, the container applies
  migrations with drizzle's **programmatic migrator** (`docker/migrate/migrate.mjs`,
  isolated `drizzle-orm`+`pg` deps) — drizzle-kit stays a dev-only tool for
  `db:generate`/`db:migrate` locally. Moved `drizzle-kit`+`@next/env` back to
  devDependencies. Entrypoint: `node migrate/migrate.mjs && node server.js`.
  Fixed a healthcheck that failed on IPv6 `localhost` (standalone binds IPv4
  `0.0.0.0`; use `127.0.0.1`). Re-verified on a fresh DB volume.

## Phase Progress

| Phase | Status | Proof | Next |
| --- | --- | --- | --- |
| Phase 0: Product and Behavior Inventory | todo | none | Define v1 must-have/nice/drop list |
| Phase 1: Next.js Foundation | done | lint/typecheck/test/build all pass; folders + scripts + shared infra in place | Documented in README "Repository Layout" |
| Phase 2: Data Model and Persistence | in-progress | Drizzle schema + migrations + trace repository/recorder + `settings` table; unit 27 + integration 11 (Testcontainers); `db:migrate` verified | Add feature tables (chats/messages) with their features |
| Phase 3: Configuration and Settings | in-progress | Config moved env→DB (user direction). DB-backed LLM-connection settings (`features/settings/*`, typed columns: base URL/API key/model), `openai` provider client (`server/llm/client.ts`), `GET`/`PATCH` `app/api/settings` + `POST /test-connection` (real `/v1/models` probe); key masked + trace-redacted; verified live. Overview/shell/health reworked onto real probes. Plan Phase 3 realigned to this direction | Add model params/prompts with their features; surface traces in shared Debug UI |
| Phase 4: Telegram Bot Interface | in-progress | In-process long-polling bot (grammy) via `instrumentation.ts` + `server/telegram/bot-manager.ts` singleton; DB-backed token; deterministic addressing; Start/Stop API + Overview control; verified live (graceful no-token autostart, control 200). lint/typecheck/test/build ✓ | Add maintenance mode + owner checks; shared Debug UI for message traces |
| Phase 5: LLM Conversation Core | todo | none | Design provider and conversation service |
| Phase 6: Dashboard Shell | in-progress | UI kit + responsive AppShell (sidebar/drawer/topbar) built and refactored overview onto it; lint/typecheck/test/build ✓, verified live in-browser | Add feature routes/pages + shared table/debug components as features land |
| Phase 7: Realtime and Status Updates | todo | none | Choose polling/SSE per live status need |
| Phase 8: Background Work Design | todo | none | Choose operating model per job |
| Phase 9: Feature Recreation | todo | none | Start features in priority order |
| Phase 10: Testing Strategy | todo | none | Configure unit/route/dashboard tests |
| Phase 11: Docker and Self-Hosting | in-progress | Multi-stage Dockerfile (Next standalone) + docker-compose (app + pgvector db); **423MB** image; entrypoint applies migrations (drizzle programmatic migrator) then serves; migrations + `/api/health` + dashboard verified in-container on a fresh volume | Add Traefik/secrets/downloads volume when needed |
| Phase 12: Cutover | todo | none | Prepare backup and rollback checklist |

## Feature Progress

This is the authoritative implementation order. Each feature is not done until it has acceptance criteria, shared-pattern implementation, Debug page, trace recording, log/trace download, and tests.

Features not listed here are not v1 by default. Add any additional feature to this table with explicit priority and dependencies before implementation.

| Priority | Feature | Status | Acceptance Criteria | Debug Page | Trace/Log Download | Tests | Dependencies | Next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Bot messaging: text receive/reply | in-progress | defined (see 2026-07-11 log) | no | no | yes (addressing, service, chatCompletion, token masking) | settings, health, Telegram intake, LLM provider, shared traces | Build shared Debug UI + trace download; live run with a real token; add maintenance/owner |
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
| Settings and health | in-progress | DB-backed LLM-connection settings (`features/settings/*`) with `GET`/`PATCH` + `test-connection` real probe, key masking + trace redaction, unit + integration tests. Config source is the DB, not env (`config-in-db-not-env`); Overview + `/api/health` probe real state | Extend settings columns per feature |
| LLM provider core | in-progress | `server/llm/client.ts` (`openai`): `listModels`/health probe + `chatCompletion` (reply text + normalized usage + latency, empty-response→503), base-URL normalization, `ApiError` mapping; connection sourced from DB settings; unit-tested (incl. mocked completion) + verified live | Add context assembly (history/prompts) with priorities 2–3; tool-call loop at priority 4 |
| Telegram intake foundation | in-progress | In-process long-polling `server/telegram/bot-manager.ts` (grammy) — singleton lifecycle, DB-backed token, autostart via `instrumentation.ts` + Start/Stop API; deterministic `features/bot-messaging/server/addressing.ts` (unit-tested); verified live | Add maintenance mode, owner checks, and per-message Debug traces UI |
| Dashboard overview | in-progress | `app/page.tsx` on real probes (`server/status.ts`: `SELECT 1` + live `/v1/models`); sidebar bot-status on cheap DB readiness; verified live | Add real metrics + Telegram status once those features land |
| Debug traces and LLM usage | in-progress | `lib/trace.ts` types + `server/trace` recorder/repository on Drizzle, tested | Add Debug UI + trace-context in Route Handler wrapper |

## Shared Infrastructure Progress

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Shared Route Handler wrapper | done | `server/http.ts` (`defineRoute`, `ok`, `parseJson`, `parseQuery`, `toApiError`) + tests | Add trace-context integration when recorder lands |
| Shared error shape | done | `lib/api-error.ts` (`ApiError`, code→status map, envelope) + tests | — |
| Shared trace schema | done | `lib/trace.ts` types + `db/schema.ts` tables + `server/trace` repository/recorder, tested | Wire recorder into features as they land |
| Shared log/trace export | in-progress | `traceBundleSchema` + `getTrace`/`listTraces` queries | Implement export Route Handler + download button (needs debug UI) |
| Shared dashboard layout | done | `components/layout/AppShell` (responsive rail + mobile drawer), `Sidebar` (config-driven, active state), `Topbar`; theme toggle + tokens | Add breadcrumbs + per-route topbar title as routes grow |
| UI kit tokens/primitives | done | `app/globals.css` semantic tokens (Tailwind v4 `@theme`, `.dark`); `components/ui/*` (Button/Card/Badge/Avatar/Progress/Separator/StatCard/EmptyState/Skeleton) + `lib/cn.ts`; verified live | Extend with Table/Tabs/Dialog/Toast when features need them |
| Shared form components | done | `components/ui` `Input`, `Textarea`, `Select`, `Label`, `Field` (label+hint+error+aria wiring), `Switch`, `Checkbox`; first consumed by `features/settings/ui/SettingsForm.tsx` | Extract a form-state/submit helper if a 2nd feature form duplicates the fetch/status pattern |
| Shared table/filter components | todo | none | Define pagination/filter API |
| Shared debug components | todo | none | Define trace list/detail/download UI |
| Shared status components | done | `components/ui/Badge` (tones+dot), `EmptyState`, `Skeleton`/`Spinner`, refactored `StatusCard`/`PageHeader` onto tokens | Add explicit error panel when debug UI lands |
| Test harness | done | Vitest unit config (45) + Testcontainers integration config (15); `server-only` alias stub; `vi.hoisted`+`vi.mock` pattern for isolating services from persistence (see `bot-messaging/service.test.ts`) | Add Route Handler + dashboard smoke tests per feature |

## Decision Notes

Per user preference, decisions are made by asking the user directly, not by
writing `docs/decisions/*.md`. This table is the lightweight record.

| Topic | Status | Decided by | Decision |
| --- | --- | --- | --- |
| ORM / persistence | done | user | Drizzle ORM + drizzle-kit migrations |
| Settings storage model | done | user | Typed columns, single settings row (`id = 'singleton'`); new settings = new column + migration |
| Configuration source | done | user | Runtime config lives in DB-backed Settings via the dashboard, not env vars (bootstrap-only `DATABASE_URL` stays in env). Status must be a real probe, not env presence |
| LLM API key storage | done | user | Optional API key stored in the DB, masked in UI/API (`apiKeyConfigured` only), redacted from traces |
| Owner field timing | done | user | Deferred to the Telegram intake phase (priority 1) — needs the bot to resolve @username→id |
| Migration workflow | done | user | `generate` committed SQL files; applied via `drizzle-kit migrate` (`npm run db:migrate`), run by the Docker entrypoint before `next start`. No in-app auto-migration (instrumentation approach rejected as non-standard). |
| DB test strategy | done | user | Real Postgres via Testcontainers (integration suite) |
| MVP data import | done | agent default | Out of scope for v1 (fresh DB) — reconfirm with user if import is needed before cutover |
| Telegram webhook vs polling | done | user | **Long polling, in-process** (started from `instrumentation.ts`), not a webhook and not a separate worker. Rationale: self-hosted single container behind NAT (no inbound HTTPS needed); I/O-bound handlers already run concurrently on the event loop, so a worker/thread buys nothing now. Isolated behind a bot-manager singleton so moving to a dedicated worker later (multi-replica / CPU-bound) is a contained change. |
| Telegram poller lifecycle | done | user | **Autostart on boot** (fails gracefully and surfaces on the dashboard when no token) **+ dashboard Start/Stop** controls. Token lives in DB settings; a token change requires restart (poller binds token at start). |
| Realtime polling vs SSE vs WebSocket | todo | — | undecided |
| Background job operating model | todo | — | undecided |

## Blockers

No blockers recorded.

## Next Agent Notes

- Read `NEXTJS_REWRITE_PLAN.md` first.
- Confirm v1 scope before implementation.
- Do not copy MVP modules by default.
- Keep shared patterns ahead of feature-specific code.

### Current state (2026-07-11)

- Phase 1 done; Phases 2/3/4/6/11 in-progress and verified: `npm run lint`,
  `npm run typecheck`, `npm run test` (45 unit), `npm run test:integration`
  (15, Testcontainers), `npm run build` (0 warnings), and `npm run db:migrate`
  all pass. Priority-1 bot messaging (text receive/reply) vertical slice is
  built and verified live in-browser.
- **Telegram intake is decided and built**: in-process long polling via
  `instrumentation.ts` → `server/telegram/register-node.ts` →
  `server/telegram/bot-manager.ts` (a `globalThis` singleton owning the grammy
  `Bot` lifecycle). Token is DB-backed (masked `telegram_bot_token` column).
  Autostart is best-effort/non-blocking; Start/Stop via `POST /api/telegram/bot`
  and the Overview `BotControl`. Message policy is in
  `features/bot-messaging/server/service.ts` (addressing → LLM → reply → trace),
  with injected collaborators for testability.
- The plan (`NEXTJS_REWRITE_PLAN.md`) was re-validated 2026-07-10 and now
  matches the decided directions: DB-backed config, real-probe status,
  ask-the-user decisions (no `docs/decisions/`), and the `features/settings`
  reference shape for the feature contract.
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

- **Config is now DB-backed, not env** (user direction — memory
  `config-in-db-not-env`). Follow `features/settings/*` + `server/llm/client.ts`
  as the reference shape. Never gate status on env presence — probe the real
  thing (memory `verify-real-state-not-env-presence`). Never invent
  fields/placeholders — ground in `../ollama-tg-bot` and ask (memory
  `no-placeholders-ask-instead`).
- Overview, shell, and `/api/health` are **done** on real probes
  (`server/status.ts`: `getSystemStatus`/`getConfigReadiness`/`getHealth`).
  `envPresence()` is deleted — do not reintroduce presence-style status.
- **Finish priority 1** — the vertical slice works but the feature is not `done`
  until: (a) the **shared Debug UI** (trace list/detail + JSON viewer + log
  download) exists — `settings` *and* `bot-messaging` already record traces with
  no viewer; (b) an **end-to-end run with a real bot token** (operator-supplied
  — do not create Telegram credentials); (c) **maintenance mode + owner checks**
  are added. Then move to priority 2 (system/personality prompts), which will
  replace the minimal default system prompt in
  `features/bot-messaging/server/service.ts`.
- **Shared Debug UI is now the highest-leverage next task** — it unblocks the
  Debug-page/trace-download requirement for both `settings` and `bot-messaging`.
- Deferred within bot messaging: markdown/HTML reply rendering (v1 is plain
  text), the MVP LLM "analyzer" addressing fallback, media/vision intake
  (priority 7), and `@grammyjs/runner` for concurrent update handling (built-in
  polling is sequential — acceptable for v1).

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
- Docker: the app image is Next **standalone** (`output: 'standalone'`), so the
  drizzle-kit CLI is intentionally NOT in it. Container migrations run via
  `docker/migrate/migrate.mjs` (drizzle's programmatic migrator, isolated
  `drizzle-orm`+`pg`). Keep migration-running out of the app's node_modules.
- Docker build uses `npm install` (not `npm ci`) because the Windows-generated
  lockfile lacks Linux/musl optional native deps. Set `HOSTNAME=0.0.0.0` for the
  standalone server, and use `127.0.0.1` (not `localhost`) in the container
  healthcheck — standalone binds IPv4 and `localhost` may resolve to IPv6 `::1`.
- After changing `db/schema.ts`: `npm run db:generate`, commit the SQL. Both the
  local dev tool (drizzle-kit) and the container runner read `db/migrations`.

### Commands that passed

- `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`
