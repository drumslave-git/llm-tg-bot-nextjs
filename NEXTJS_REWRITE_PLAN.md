# Next.js Rewrite / Recreation Plan

## Scope and Ground Rules

This is a rewrite of the MVP
[drumslave-git/ollama-tg-bot](https://github.com/drumslave-git/ollama-tg-bot)
into
[drumslave-git/llm-tg-bot-nextjs](https://github.com/drumslave-git/llm-tg-bot-nextjs).

In the current workspace, agents are inside the `llm-tg-bot-nextjs` repository.
The old MVP sources are available at `../ollama-tg-bot` when local comparison is
needed. Do not hardcode absolute filesystem paths in docs, code, scripts, or
tests.

The old project is not treated as code to migrate. It is a working reference for product behavior, data needs, operational constraints, and lessons learned. Reuse code only when it is clearly still the best shape for the new design. Otherwise, recreate the capability in a cleaner Next.js-native way.

There is no phase where the two applications run together, proxy to each other, share a runtime, or depend on cross-project communication. The Next.js project must become independently complete before cutover.

Use standard Next.js capabilities first:

- App Router
- Route Handlers
- Server Components
- Client Components
- `instrumentation.ts` where appropriate
- `next dev`, `next build`, and `next start`
- standard `.env*` handling
- standard self-hosted Next.js deployment patterns

If a capability appears impossible or unsafe with supported Next.js mechanisms, stop at that capability, document the blocker, list standard alternatives, and discuss the design case by case before adding custom infrastructure.

## Current Reference System

The MVP includes these major capabilities:

- Telegram bot powered by an OpenAI-compatible chat completions API
- Dashboard for settings, stats, debug views, memory, mood, tasks, summaries, vision, browser runs, and data tables
- Postgres + pgvector persistence
- LLM usage and processing debug history
- Background work for tasks, summaries, memory extraction, vision backfill, mood cooldown, and browser-agent runs
- Optional web search through Tavily
- Link/browser fetching through Playwright
- Image/vision/sticker support
- Docker deployment with a bundled Postgres service

The rewrite should preserve useful product behavior, not old implementation boundaries.

## Target Architecture Principles

1. Next.js is the application platform.
2. HTTP APIs are implemented as `app/api/**/route.ts` Route Handlers.
3. Server-only domain logic lives outside UI modules and is protected from client imports.
4. The dashboard uses Server Components for initial reads where useful and Client Components for forms, sockets/SSE/polling, local state, and interaction.
5. Realtime updates use standard Next-compatible mechanisms first: SSE Route Handler or polling. WebSockets/Socket.IO require a separate design decision.
6. Background work is designed explicitly. Prefer supported deployment primitives such as webhooks, cron-triggered Route Handlers, external workers, or startup instrumentation over implicit long-running loops.
7. Database schema should be intentional and versioned. Do not blindly recreate MVP table sprawl if a cleaner schema is warranted.
8. Compatibility with the existing `.env` and Docker deployment is desirable, but not at the cost of carrying poor MVP design forward.

## Engineering Standards

Code quality is a first-class requirement for the rewrite.

1. Code must be clean, readable, and DRY.
2. Features must follow shared architecture patterns instead of one-off implementations.
3. Shared behavior belongs in shared modules, hooks, services, components, schemas, and utilities.
4. Feature-specific code should contain only feature-specific policy and UI, not duplicated plumbing.
5. Route Handlers should be thin and delegate validation, authorization, business logic, persistence, and trace recording to shared server modules.
6. Dashboard pages should use shared layout, table, form, status, empty-state, loading, error, debug, and log-download components.
7. Naming, error shapes, response shapes, trace shapes, timestamps, pagination, filtering, and export formats must be consistent across features.
8. Any duplicated implementation across two features is a refactor signal; by the third use it must become shared infrastructure unless there is a documented reason not to.
9. Tests should target shared behavior once and feature policy separately.
10. New features are not complete until they fit the common feature contract described below.

## Standard Feature Contract

Every feature should follow the same structure unless a design note explains why it cannot.

Recommended feature shape:

```text
features/<feature>/
  server/
    service.ts
    schema.ts
    repository.ts
    trace.ts
    errors.ts
  api/
    routes.ts
  ui/
    page.tsx
    DebugPage.tsx
    components.tsx
  tests/
    service.test.ts
    routes.test.ts
```

Each feature must provide:

1. Clear domain service API.
2. Zod schemas for input and output validation.
3. Typed database access through shared query helpers.
4. Consistent Route Handler wrappers for:
   - auth/owner checks where needed
   - validation
   - error mapping
   - trace context
   - JSON responses
5. A dashboard page for normal operation.
6. A dedicated Debug page.
7. Trace recording for each meaningful action.
8. Log/detail download from the Debug page.
9. Consistent status reporting for dashboard overview cards.
10. Unit tests and route/API tests.

Debug pages must allow an operator to inspect:

- when the action happened
- who or what triggered it
- input summary
- decision steps
- external calls
- LLM request/response metadata where applicable
- token usage where applicable
- generated outputs
- errors and retry state
- related database row IDs
- downloadable JSON log/trace bundle

Use shared debug components for trace lists, trace detail, JSON viewers, metadata panels, error panels, and download buttons. Do not build a different debug UI per feature unless the feature has genuinely unique visualization needs.

## Agent Progress Tracking

Agents should track progress in repository files, not only in chat.

Required tracking files:

- `NEXTJS_REWRITE_PROGRESS.md`: phase and feature progress tracker.
- `docs/decisions/<date>-<topic>.md`: case-by-case design notes for non-standard decisions.
- feature-local test files: executable proof that a feature meets its contract.

Progress rules:

1. Update `NEXTJS_REWRITE_PROGRESS.md` before and after substantial work.
2. Mark each item as one of:
   - `todo`
   - `in-progress`
   - `blocked`
   - `done`
   - `deferred`
3. Every `blocked` item must include:
   - blocker
   - attempted approach
   - next decision needed
4. Every `done` item must include proof:
   - files changed
   - tests run
   - build/typecheck/lint status where relevant
   - remaining risks
5. Every feature must have a mini checklist:
   - acceptance criteria
   - data model
   - service
   - Route Handlers
   - normal dashboard page
   - Debug page
   - trace recording
   - log/trace download
   - tests
   - docs/decision notes if needed
6. Do not mark a feature `done` if it lacks the shared Debug page, trace recording, and log/trace download unless it is explicitly marked `deferred` with a reason.
7. When starting work, read the current progress tracker first.
8. When handing off work, leave a short "Next Agent Notes" entry with:
   - current state
   - next best task
   - known pitfalls
   - commands that passed or failed

Suggested status format:

```text
Status: todo | in-progress | blocked | done | deferred
Owner: agent/date
Proof: tests/build/docs links
Next: one concrete next step
```

## Phase 0: Product and Behavior Inventory

Goal: define what the rewrite must do before writing implementation code.

Steps:

1. Inventory user-facing dashboard pages from the MVP:
   - overview
   - character/settings
   - history
   - summaries
   - memory
   - mood
   - tasks
   - vision
   - browser runs
   - debug
   - data
2. Inventory bot behaviors:
   - private chat replies
   - group mention replies
   - reply-to-bot handling
   - maintenance mode
   - owner controls
   - slash commands
   - history-aware replies
   - LLM tool use
   - memory injection
   - mood/personality injection
   - image/sticker handling
3. Inventory operational requirements:
   - required env vars
   - Postgres + pgvector
   - Docker self-hosting
   - downloads directory
   - Telegram bot token handling
   - LLM provider configuration
   - scheduled/background work
4. Mark each MVP feature as:
   - `must-have for v1`
   - `nice-to-have after cutover`
   - `drop/rethink`
5. Write acceptance criteria for each `must-have`.

Exit criteria:

- The rewrite has a prioritized feature list.
- The MVP is no longer the implicit source of truth; explicit acceptance criteria are.

## Phase 1: Next.js Foundation

Goal: prepare a clean Next.js application foundation.

Steps:

1. Keep scripts standard:
   - `dev`: `next dev`
   - `build`: `next build`
   - `start`: `next start`
   - `lint`: `eslint`
   - add `typecheck` and `test` once configured
2. Set Node requirement to match production needs, likely Node `>=22.13.0`.
3. Add dependencies intentionally:
   - Telegram: `grammy`, `@grammyjs/types`
   - LLM: `openai`, `zod`
   - database: `pg`
   - browser/media: `playwright`, `sharp` only when those features are implemented
   - UI utilities: add only when dashboard components need them
4. Establish folders:
   - `app/` for routes, layouts, Route Handlers
   - `features/` for product feature modules
   - `server/` for server-only services
   - `db/` for schema, migrations, and query helpers
   - `components/` for shared UI
   - `lib/` for small shared utilities
5. Add `server-only` markers to server modules that touch secrets, database, filesystem, Telegram, Playwright, or LLM provider credentials.
6. Read relevant installed Next docs before implementing each major mechanism:
   - Route Handlers
   - Server/Client Components
   - environment variables
   - instrumentation
   - self-hosting

Exit criteria:

- `npm run build` passes on the clean foundation.
- Folder boundaries are documented.
- No MVP code has been copied by default.

## Phase 2: Data Model and Persistence

Goal: design the new database deliberately.

Steps:

1. List required entities:
   - settings
   - chats
   - messages
   - summaries
   - memories
   - mood/personality state
   - tasks
   - task events/fires
   - media/vision descriptions
   - LLM usage
   - processing/debug traces
   - browser-agent runs
2. Compare the MVP schema only to understand what data was needed.
3. Design a normalized v1 schema with clear ownership and indexes.
4. Decide migration/backfill policy:
   - fresh database only
   - import selected MVP data
   - one-time import script from old database
5. Design shared tables/contracts for cross-feature observability:
   - traces
   - trace events
   - external call records
   - LLM usage
   - job/action status
   - downloadable log bundles
6. Add migrations or idempotent schema setup.
7. Implement a small typed database access layer.
8. Add shared repository helpers for pagination, filtering, time ranges, trace lookup, and log export.
9. Add tests for schema initialization and critical queries.

Exit criteria:

- Database can initialize from empty Postgres.
- Query helpers are typed and tested.
- Trace/log storage is shared and reusable by every feature.
- Data import from the MVP is either explicitly supported or explicitly out of scope.

## Phase 3: Configuration and Settings

Goal: recreate configuration as a first-class product area.

Steps:

1. Define server environment variables:
   - `BOT_TOKEN`
   - `LLM_BASE_URL`
   - `DATABASE_URL`
   - optional provider keys
   - optional Tavily key
   - `TZ`
2. Support Docker secret file variants only where still needed.
3. Define database-backed settings:
   - model
   - prompts/personality
   - owner
   - maintenance mode
   - context/performance limits
   - feature toggles
   - vision/browser/memory settings
4. Implement validation with `zod`.
5. Implement `app/api/settings/**` Route Handlers.
6. Build the settings dashboard page using Server Components for initial data and Client Components for forms.

Exit criteria:

- Missing required env vars produce clear errors.
- Settings can be read and updated from the dashboard.
- Settings writes are validated server-side.

## Phase 4: Telegram Bot Interface

Goal: implement the bot interface in a Next.js-compatible way.

Steps:

1. Decide the standard Telegram delivery model:
   - preferred: Telegram webhook handled by a Route Handler
   - fallback: polling only after a design note explains why webhook is not suitable
2. Implement webhook Route Handler if selected:
   - `app/api/telegram/webhook/route.ts`
   - validate secret/path/token strategy
   - parse update
   - hand off to server-only bot service
3. Implement message addressing:
   - private chats always addressed
   - group mentions
   - reply-to-bot
   - command targeting
4. Implement maintenance mode and owner checks.
5. Implement reply delivery and Telegram HTML escaping.
6. Add tests for addressing, maintenance, owner checks, and reply formatting.

Exit criteria:

- Bot can receive a test Telegram update through the selected standard mechanism.
- Private and group addressing behavior is correct.
- No duplicate bot process can accidentally run inside normal Next lifecycle.

## Phase 5: LLM Conversation Core

Goal: build the core assistant turn cleanly.

Steps:

1. Implement provider configuration for OpenAI-compatible chat completions.
2. Implement context assembly:
   - system prompt
   - recent history
   - memories
   - mood/personality
   - link/search/vision context when enabled
3. Implement token/context budgeting.
4. Implement response generation.
5. Implement tool-call support only for v1 must-have tools.
6. Record LLM usage and processing traces.
7. Add tests for prompt assembly, context budgeting, tool-loop control, and failure handling.

Exit criteria:

- A Telegram update can produce a reply through the configured LLM.
- Empty/error provider responses are handled gracefully.
- Usage and debug traces are recorded.

## Phase 6: Dashboard Shell

Goal: create the actual usable dashboard, not a marketing page.

Steps:

1. Replace the generated home page with the dashboard shell.
2. Build an App Router layout with persistent navigation and status indicators.
3. Implement routes for v1 must-have pages.
4. Use Server Components for initial page data where appropriate.
5. Use Client Components for:
   - settings forms
   - toggles
   - live status
   - debug expand/collapse
   - task creation/editing
6. Build shared dashboard primitives before feature pages duplicate them:
   - layout/navigation
   - page header
   - status cards
   - data table
   - filters
   - form fields
   - buttons
   - badges
   - loading/empty/error states
   - debug trace list/detail
   - JSON viewer
   - log download button
7. Keep UI quiet, dense, and operational.
8. Do not carry over MVP React Router unless it is deliberately chosen as a temporary bridge.

Exit criteria:

- Dashboard opens at `/`.
- Refreshing nested routes works.
- Core pages render from Next routes, not a Vite-style shell unless explicitly accepted.
- Feature pages use shared UI primitives instead of bespoke layouts.

## Phase 7: Realtime and Status Updates

Goal: provide dashboard freshness using standard Next-compatible mechanisms.

Steps:

1. Define which data must be live:
   - queue/status
   - current bot health
   - LLM health
   - background task state
   - debug traces
2. Start with polling where the update frequency is low.
3. Use SSE Route Handler for one-way live status streams if polling is not sufficient.
4. Keep event payloads small and typed.
5. Add reconnect/retry behavior in the client hook.
6. If true bidirectional WebSocket behavior is required, create a design note before adding Socket.IO or another WebSocket stack.

Exit criteria:

- Dashboard shows fresh status without manual refresh for the selected v1 live areas.
- Failure/reconnect behavior is understandable to the user.

## Phase 8: Background Work Design

Goal: replace MVP background loops with explicit, supportable mechanisms.

Steps:

1. List required background jobs:
   - scheduled tasks
   - summaries
   - memory extraction
   - vision backfill
   - browser-agent queue
   - mood cooldown
2. For each job, choose a standard operating model:
   - run on demand through Route Handler
   - run from external cron hitting a Route Handler
   - run from a separate worker service
   - run from Next instrumentation only if safe for the deployment model
3. Document why each chosen model fits.
4. Implement one job type at a time.
5. Add job status, locking, and idempotency in the database.
6. Add dashboard controls and debug views.

Exit criteria:

- Each v1 background job has an explicit operating model.
- Jobs are idempotent and cannot double-run accidentally.
- Any external worker/cron requirement is documented before cutover.

## Phase 9: Feature Recreation

Goal: rebuild product features in priority order.

The order below is authoritative for feature work unless the progress tracker records an accepted change. Foundation work such as settings, health, shared traces, shared debug UI, shared Route Handler wrappers, and dashboard layout must be built early, but it does not replace this feature priority list.

Priority order:

| Priority | Feature | Scope |
| --- | --- | --- |
| 1 | Bot messaging: text receive/reply | Bot can receive Telegram text updates and answer with LLM-generated text. |
| 2 | System and personality prompts | Configurable system prompt, personality prompt, and prompt composition used by every reply. |
| 3 | History feature | Store, retrieve, and inject conversation history consistently. |
| 4 | MCP tools basic support | Shared tool registry, tool schema conversion, tool-call loop, tool trace recording, and safe tool error handling. |
| 5 | Search MCP tool | Search tool exposed through the shared MCP/tool system with traceable requests/results. |
| 6 | Visit/read link MCP tool | Link reading tool exposed through the shared MCP/tool system with SSRF protections and traceable fetch/read output. |
| 7 | Bot messaging: vision | Bot can receive image/sticker/media messages and include vision context in replies. |
| 8 | Vision backfill background job | Background processing for older/unprocessed media with status, locking, debug traces, and log download. |
| 9 | Mood feature | Mood/personality state, mood injection into replies, dashboard controls, and debug traces. |
| 10 | Scheduled tasks feature | User-configurable scheduled tasks with execution traces, status, idempotency, and dashboard controls. |
| 11 | Memory feature | Extract, store, edit, retrieve, and inject memories with traceable extraction and update flows. |
| 12 | Image generation | Generate images through configured provider/tooling with dashboard/debug visibility and downloadable traces. |
| 13 | Browser agent feature | Browser-agent runs with queue/status, step traces, artifacts/downloads, and a dedicated Debug page. |

Feature dependency notes:

- Bot text messaging depends on settings, health, Telegram intake, LLM provider, and shared trace infrastructure.
- Search and visit/read-link tools depend on MCP tools basic support.
- Vision backfill depends on bot vision/media persistence.
- Mood and memory both depend on prompt composition and history.
- Scheduled tasks must use the shared background-job operating model from Phase 8.
- Browser agent must not be started until the shared job/status/debug/log-export patterns exist.
- Features not listed in this priority table are not v1 by default. If another MVP capability, such as summaries or maintenance controls, is needed in v1, add it to this table with an explicit priority, acceptance criteria, and dependencies before implementation.

Feature acceptance checklist:

1. Normal user behavior works end to end.
2. Feature follows the standard feature contract.
3. Feature uses shared API, error, trace, debug, table, form, status, and export patterns.
4. Feature has a normal dashboard page where applicable.
5. Feature has a dedicated Debug page.
6. Every meaningful action records traces.
7. Logs/traces can be downloaded.
8. Feature has tests for service logic, Route Handlers, and critical UI/debug behavior.

For each feature:

1. Confirm acceptance criteria.
2. Fit the feature into the standard feature contract.
3. Design data model and API.
4. Implement server-only service logic.
5. Implement trace recording for every meaningful action.
6. Implement Route Handlers using shared wrappers.
7. Implement normal dashboard UI using shared components.
8. Implement the dedicated Debug page using shared debug components.
9. Implement downloadable trace/log export.
10. Add tests.
11. Run build/typecheck/tests before moving to the next feature.

Exit criteria:

- Each completed feature is independently usable.
- Each completed feature has a Debug page.
- Each completed feature records traces consistently.
- Each completed feature supports log/trace download.
- Each completed feature follows shared API, error, trace, and UI patterns.
- No feature depends on the old project running.

## Phase 10: Testing Strategy

Goal: verify the rewrite without copying the MVP's accidental structure.

Required tests:

1. Unit tests:
   - addressing
   - maintenance
   - prompt/context assembly
   - settings validation
   - Telegram formatting
   - tool-call loop safety
2. Database tests:
   - schema initialization
   - critical queries
   - job locking/idempotency
3. Route Handler tests:
   - settings
   - stats
   - health
   - Telegram webhook
   - feature APIs
4. Dashboard smoke tests:
   - main pages render
   - forms submit
   - live status recovers
   - Debug pages render for each feature
   - log/trace downloads work
5. Integration tests:
   - one end-to-end Telegram update to LLM reply using mocked provider
   - optional live LLM tests gated by env vars
6. Pattern consistency checks:
   - feature Route Handlers use shared wrappers
   - feature Debug pages use shared debug components
   - error responses follow shared shape
   - traces follow shared schema
   - no duplicated feature-local table/form/debug plumbing where shared code exists

Exit criteria:

- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm run build` passes.
- `npm run test` passes for non-live tests.
- Code review confirms new feature code follows the shared feature contract.

## Phase 11: Docker and Self-Hosting

Goal: deploy the rewritten Next.js app cleanly.

Steps:

1. Create Dockerfile for standard Next self-hosting.
2. Use `next build` and `next start`.
3. Include native dependencies only when required:
   - Playwright browser dependencies
   - `libvips` / Sharp
   - `ffmpeg`
4. Recreate Compose services:
   - app
   - Postgres + pgvector
5. Preserve useful environment contract from the MVP.
6. Preserve downloads volume if browser/download features are in v1.
7. Preserve Traefik labels if still used.
8. Add health checks.

Exit criteria:

- `docker compose build` succeeds.
- `docker compose up -d` starts the rewritten app and database.
- Dashboard opens on the configured port.
- v1 bot path works in container.

## Phase 12: Cutover

Goal: replace the MVP operationally.

Steps:

1. Stop the MVP app.
2. Back up MVP database and downloads.
3. Back up old `.env` and Compose files.
4. Start the rewritten Next.js app.
5. Verify dashboard.
6. Verify Telegram receive/reply path.
7. Verify LLM provider health.
8. Verify selected background jobs.
9. Verify no old bot instance is running.
10. Keep MVP rollback artifacts until one full operational cycle passes.

Rollback plan:

1. Stop the rewritten app.
2. Restore the MVP service.
3. Restore database from backup only if necessary.
4. Verify bot and dashboard.

Exit criteria:

- Rewritten Next.js app is the only running bot instance.
- v1 acceptance criteria are met.
- Rollback path is known and tested enough for the deployment risk.

## Case-by-Case Design Notes Required

Write a short design note before implementing any of these if standard Next.js behavior is not enough:

- Telegram polling instead of webhook Route Handler
- Socket.IO or custom WebSocket server
- long-running in-process schedulers
- custom Node server
- separate worker service
- database migration/import from MVP production data
- Playwright browser lifecycle beyond per-job execution
- any feature that requires process-global mutable state

Each design note should include:

- problem
- standard Next.js option tried or rejected
- reason it is insufficient
- alternatives
- recommended design
- operational impact
- rollback/failure behavior

## Done Definition

The rewrite is complete when:

- [drumslave-git/llm-tg-bot-nextjs](https://github.com/drumslave-git/llm-tg-bot-nextjs) independently runs the selected v1 bot, dashboard, API, persistence, realtime/status, jobs, and Docker deployment.
- The old project is not required for development, startup, API calls, dashboard rendering, or runtime work.
- All v1 acceptance criteria pass.
- All required checks pass.
- Code is clean, readable, and DRY.
- Features follow one shared implementation pattern.
- Every v1 feature has a Debug page.
- Every meaningful feature action is traceable.
- Logs/traces can be downloaded consistently.
- Shared code/components are used for common behavior instead of case-by-case implementations.
- API responses, errors, statuses, pagination, timestamps, trace records, and exports are unified.
- Any non-standard infrastructure has an accepted case-by-case design note.
- The deployment can replace the MVP service with a known rollback path.
