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
Owner: agent/2026-07-13
Last updated: 2026-07-13
Proof: `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (208 unit), `npm run test:integration` ✓ (93, real Postgres via Testcontainers). `npm run build` not run this session — a dev server is live on 3200 and a production build would clobber it (see the Priority 6 log entry). **Priority 2 — system & personality prompts (done):** the base system prompt is a fixed code constant (`BASE_SYSTEM_PROMPT` in `features/bot-messaging/server/prompt.ts`); the operator manages personas as a **full personalities CRUD feature** (user decision — corrected from an initial single-field approach). A `personalities` table (migration `0005`: id/name/prompt/timestamps) + `settings.active_personality_id` (FK, `on delete set null`). New `features/personalities/*` (repository/schema/service/ui) with a **`/personalities` page** (create/edit/delete + set-active) and **`/personalities/debug`**; routes `GET/POST /api/personalities`, `PATCH/DELETE /api/personalities/[id]`, `PUT /api/personalities/active`; every mutation traced. Composition (`buildSystemPrompt`/`hasPersonality`, pure) is unchanged: base alone, or base + `---\nAdditional instructions:\n<persona>`; the bot-messaging service records a **`system prompt composed`** step (`personalityApplied` + full composed prompt) between `addressing check` and `request`; the runtime injects the **active** personality's prompt via `getActivePersonalityPrompt()`. Verified live: created a persona on `/personalities`, set it active (Active badge + `activeId` via API), deleted it (list emptied and active auto-cleared via the FK), all four mutations traced `success` on `/personalities/debug`; no console errors. **Known users + owner-by-dropdown**: a `known_users` table (migration `0004`) capturing everyone who messages the bot, a `/users` page with inline alias editing, and the owner is now chosen from a **dropdown of known users** (id stored directly — the earlier lazy @username→id resolution is removed). **Maintenance mode + owner checks** built and verified live (a pure `bot-messaging/policy.ts`; blocked-but-addressed messages traced as skipped). The **shared Debug UI** is now built and verified live — the last feature-contract gap for both `settings` and priority-1 `bot-messaging`. A global `/debug` page (filter by feature/status, pagination, "Download all") plus a shared `/debug/[id]` detail view (metadata panel, error panel, ordered event timeline with LLM usage, per-trace JSON download) and a feature-scoped `/settings/debug`. Backed by `server/trace/service.ts` (list/detail/bundle) over the existing recorder/repository, thin `app/api/traces/**` handlers, and reusable `components/debug/*`. Verified live against the running dev server on real recorded traces: list renders 11 traces; a bot reply detail shows LLM usage (`prompt 38 · completion 184 · total 222 · 5741ms`); an error trace shows the error panel + timeline; `/settings/debug` shows only settings traces; single + filtered bundle downloads return the `llm-tg-bot/trace-bundle@1` envelope with attachment headers; no console errors.
Realtime: the dashboard now updates **live over SSE** (user decision — not polling/WebSockets). Shared layer: in-process `server/realtime/hub.ts` pub/sub, `GET /api/events` SSE stream, `useLiveRefresh`/`LiveIndicator` client; the trace recorder publishes on create/settle. Verified live: with the page untouched, a newly recorded `test-connection` trace appeared at the top of `/debug` on its own; the `/api/events` stream stays open (200); no console errors. Debug rows are now fully clickable (stretched link) — clicking any cell opens the trace.
**Priority 3 — History feature (done):** a **1:1 conversation mirror** (`chat_messages`, migration `0006`) capturing every human message and every bot reply with full metadata (chat id, Telegram message id, sender id, reply-to pointer, content, sent/edited/deleted timestamps). New `features/history/*` (repository/schema/format/service/ui). Messages are captured **passively** on every incoming message (even un-addressed group chatter) in `bot-manager.onMessage`; the delivered reply is mirrored via a `recordReply` dep. Per reply, `getConversationWindow` loads the **current UTC day's** messages and injects them as **structured prior turns** (`user`/`assistant`) between the cache-stable system prompt and the current message — the bot-messaging service records a `history window loaded` step. In groups, human turns are prefixed with the sender's known-user label. **Edits** are mirrored (`bot.on("edited_message")` → `applyMessageEdit`, traced). **Deletes:** the Telegram Bot API delivers no deletion update for ordinary chats, so user-initiated deletes cannot be mirrored — a `deleted_at` column exists to represent deletions we *can* know about (bot's own / Business-connection events) and the constraint is recorded in Decision Notes. Pages: `/history` (chat list), `/history/[chatId]` (full mirror with edited/deleted badges), `/history/debug` (shared `TraceExplorer`, edit traces). Verified live: seeded two chats → `/history` lists both (most-recent first, correct counts), `/history/777` shows the metadata mirror incl. reply pointer + an `edited` badge, `/history/debug` renders; no console errors; dev DB left clean. Base system prompt gained a short Conversation section (history-awareness).
**Priority 4 — MCP tools basic support (done):** tools use the **real MCP SDK** (`@modelcontextprotocol/sdk`, in-process — user decision, MVP parity): one shared `McpServer` with per-feature tool registrars, linked to a `Client` over an in-process transport pair (`server/mcp/*`: `in-process-transport`, `registry` `BotMcpRegistry`, `openai-tools` conversion, `context` per-turn `AsyncLocalStorage` chat binding, `runtime` `globalThis` singleton). A **bounded, stall-guarded tool-call loop** (`server/llm/tool-loop.ts` — pure `runToolLoop` core + `chatCompletionWithTools`) appends tool results to the same `messages` array the history window feeds, so a reply that needs no tool is still a single cache-friendly inference. The **first history MCP tools** ship (user decision): `history_search` + `history_get_in_range` (`features/history/server/mcp-tools.ts`) — deeper-than-today lookups scoped to the current chat via the tool context (the model never passes a chat id). **All registered tools are always available** — there is **no per-tool on/off** (user decision, follow-up 8): the runtime always offers every registered tool via `getToolset()`. The **`/tools` page** is a read-only registry listing (grouped by feature); `GET /api/tools`. Tool **calls** are recorded as full `external_call` events on the bot-messaging **reply** trace (args + result), so they show in `/debug` — the MCP-tools feature owns no traces of its own, so it has no dedicated Debug page. Verified via the test suite (the `getToolsView`/`getToolset` unit test drives the real in-process registry end to end) + typecheck/build; an earlier live check confirmed the page renders and traces record before the on/off mechanism was removed. The remaining feature-1..4 gate is an operator-run live LLM+token round-trip.
**Priority 5 — Search MCP tool (done):** a Tavily-backed **`search_web`** MCP tool, registered through the same `server/mcp` registrar pattern (`features/web-search/*`: pure `types.ts`/`format.ts`, server `search.ts` (`runWebSearch` — Tavily `POST /search`, `search_depth: basic`, `include_answer`, injectable `fetch`, never throws → always a model-ready success/failure context) + `mcp-tools.ts` (`registerWebSearchMcpTools`, `readOnlyHint`/`openWorldHint`)). Wired into `server/mcp/runtime.ts`, so it is **always available** (no on/off) alongside the history/known-users tools. The **Tavily API key lives in DB-backed settings** (`config-in-db-not-env`): a masked `settings.tavily_api_key` column (migration `0008`), server-only `getWebSearchApiKey()` read **at call time** (a key change takes effect without re-registering), client `webSearchConfigured` boolean, and a **Tavily API key** field on the Settings form (write-only, mirrors the LLM/bot-token secrets; redacted from traces). When the key is unset the tool returns a clear `isError` "web search unavailable" message rather than a broken search. Tool **calls** are traced as `external_call` events on the bot-messaging **reply** trace (same as the history tools) — the feature owns no mutations, so no dedicated Debug page. Verified live: `/tools` lists `search_web` under a **Web-Search** group; `/settings` shows the Tavily API key field; no console errors. Server-side masking/persist/clear/redaction proven by integration tests. Not verified: a real LLM tool-call + live Tavily round-trip — shares the operator-run gate.
**Priority 6 — Visit/read link MCP tool (done):** a Playwright-backed **`read_page`** MCP tool that reads ONE public web page in headless Chromium and returns its readable text for the model to answer from (user decision: **Playwright / MVP parity** over lightweight fetch — see Decision Notes). New `features/link-fetch/*`: pure client-safe `types.ts` (`FetchedPage`) + `format.ts` (`formatLinkFetchContext`/`formatLinkFetchFailure` — model-ready result text, always honest on failure) + `url-safety.ts` (`isSafePublicUrl` SSRF guard — blocks non-http(s), credentials, localhost, the Docker host gateway, private/loopback/link-local IPv4+IPv6; `normalizeUrl`); server-only `server/playwright.ts` (shared headless Chromium on a **`globalThis` singleton** — `getSharedChromium`/`closeSharedChromium`/`fetchPageWithPlaywright`, per-read isolated context, 60s nav timeout, 12k-char text cap), `server/fetch-link.ts` (`fetchLink` — the boundary: normalize → SSRF-check → read → format; **never throws**; injectable `fetchPage` for tests), `server/mcp-tools.ts` (`registerLinkFetchMcpTools`, `read_page`, `readOnlyHint`/`idempotentHint`/`openWorldHint`). Registered in `server/mcp/runtime.ts` under feature `link-fetch`, so it is **always available** (no on/off) and every call runs in its own **`mcp-tools-link-fetch`** trace scope automatically (via the existing `tracedToolCall` wrapper) — no dedicated feature Debug page, matching the other read tools. Added `mcp-tools-link-fetch` to `lib/features.ts` (label "Link reader tool") and `serverExternalPackages: ["playwright"]` to `next.config.ts` (never bundle the native browser pkg). Verified live: the `/debug` feature filter now lists **"Link reader tool"** (`mcp-tools-link-fetch`); no console errors. The `/tools` group + a real LLM tool-call round-trip require a dev-server restart (boot-time MCP registry singleton) + the operator-run live-bot gate (no credentials created).

**Priority 7 — Bot messaging: vision (done):** the bot receives image/sticker/media and reads it with the **same configured model** (user decision — no separate vision model). New `features/vision/*`: pure client-safe `types.ts` (`MediaKind`/`ImagePayload`/`MediaAnnotation`/`MediaView`), `detect.ts` (`detectMessageMedia` — photo/sticker(static→webp, animated/video→thumbnail)/image-document/animation(gif→file, else thumbnail)/video-frame; `findReplyMediaMessage` depth-4; `messageHasVisionMedia`), `describe-prompt.ts` (the exhaustive MVP describe prompt), `format.ts` (`renderMediaSuffix`, `toImagePart`, `buildVisionContent`); server-only `normalize.ts` (`sharp` → bounded JPEG, `VISION_MAX_DIMENSION=768` code constant), `telegram-files.ts` (token-based file download), `repository.ts` (`message_media` table, migration `0009`), `describe.ts` (`buildDescribeMessages`), `service.ts`. **Data model:** `message_media` (id/chatId/telegramMessageId/kind/fileId/fileUniqueId/mimeType/**dataBase64**/visionHint/description/**status**/timestamps; unique `(chat_id,telegram_message_id)`, status index). **Lifecycle (user decision):** media is **stored as base64** on ingestion (`status=pending`); media **on the answered message** is attached to the reply pass (the model sees it immediately), then **described and resaved** — `markDescribed` writes the text description, **drops the base64**, sets `status=described`; **other media** (unaddressed/group chatter) stays pending for the **backfill job (priority 8)**. Unloadable media → `status=unavailable`. **LLM multimodal:** `ChatMessage.content` is now `string | ChatContentPart[]` (text/image_url parts); only the current `user` turn carries images; `sanitizeMessagesForTrace` replaces inline base64 with `data:<mime>;base64,<N bytes>` in traces (the real image is on `/vision`, not a base64 wall — deliberate exception to full-raw-bodies for binary blobs). **Runtime (`bot-manager`):** ingests media passively, records media-only messages in history (`recordIncomingMessage` `hasMedia` flag → empty-content allowed), resolves the reply attachment (current message, or a replied-to image with a "asking about the … they replied to" note), and after a delivered reply runs `describeAndStore` for the current message's media (traced under feature **`vision`**). **History transcript** now carries media: past image turns render ` [photo: <description>]` via `getConversationWindow`'s injected `loadMediaSuffixes` (history stays decoupled — the suffix strings are built by the runtime from vision annotations). **Dashboard:** `/vision` page (media gallery — pending rows show the stored image, described rows show the text description; kind + status badges), nav **Vision** item, `vision` SSE topic, shared Debug via `/debug?feature=vision`. Verified live (dev server on 3200): `/vision` renders (nav item, LiveIndicator, Debug link, empty state), `/debug` feature filter lists **Vision**, no console errors. **Not verified live:** a real Telegram photo → reply round-trip — same operator-run gate (real bot token + poller restart; no credentials created).

**Priority 8 — Vision backfill background job (done):** the `pending` media rows (`message_media.status='pending'`, bytes intact) are captioned in the background by an **in-process idle-debounced scheduler** — the newly-decided **shared background-job operating model** (user decision; establishes the pattern for priorities 9–13). New shared primitive `server/jobs/idle-scheduler.ts` (`createIdleScheduler` — job-agnostic phase machine + debounce timer; `onActivity`/`runNow`/`getStatus`/`stop`; cooperative abort via `ctx.isAborted()`) and `server/jobs/lock.ts` (`withAdvisoryLock` — cross-process Postgres advisory lock on a pinned pool connection). The job body `features/vision/server/backfill.ts` (`runVisionBackfill`) wraps the lock, iterates `listPendingMedia` batches, calls the existing `describeAndStore` per row (which drops the bytes on success), respects abort, caps at 200 rows/run, and traces the batch under a new **`vision-backfill`** feature (per-row describes still trace under `vision`). Idempotency = the existing `status='pending'` gating (a described/unavailable row is never re-fetched; `describeAndStore` re-checks before spending an LLM call). Trigger = **idle-debounced (MVP parity)**: `features/vision/server/backfill-scheduler.ts` is a `globalThis` singleton wiring the primitive to the job (45s debounce code constant, LLM conn read fresh per run); `bot-manager.onMessage` calls `pokeVisionBackfill()` on every message to re-arm the wait and yield a running batch to live traffic; `register-node.ts` starts it on boot (arms an initial backlog-clearing run) and stops it on shutdown. Dashboard: a **Backfill card** on `/vision` (phase badge, backlog count, last-run summary, "Run now") backed by `GET/POST /api/vision/backfill`; live via the existing `vision` SSE topic (the scheduler publishes on every status change); shared Debug at `/debug?feature=vision-backfill`. Tests: `idle-scheduler.test.ts` (+6 unit, fake timers: debounce, re-arm, runNow, mid-run abort+re-arm, error, stop → **208 unit**), `backfill.integration.test.ts` (+7: describe-all + run/row traces, idempotent second run, empty-desc→unresolved, abort-early, lock-skip, `withAdvisoryLock` acquire/release + held-skip). Verified live on the running dev server: `/vision` shows the Backfill card ("Idle", "2 media rows awaiting a description", Run now) with no console errors; `GET /api/vision/backfill` returns `{status:{phase:"idle",…},pending:2}`. **Not run:** a real "Run now" against the operator's live pending media (irreversibly drops their stored image bytes + spends tokens — left to the operator) and the idle auto-run/poke wiring, which needs a dev-server restart (scheduler + bot-manager are boot-bound singletons). `next build` not run (dev server live on 3200 — `dont-clobber-running-dev-server`).

Next: **Priority 9 — Mood feature** (mood/personality state + injection into replies, dashboard controls, debug traces) — builds on the personalities table (priority 2) and, for any mood-cooldown background work, reuses the shared in-process idle-scheduler model established here. The shared feature-1..8 gate is an operator-run live test with a real bot token + a dev-server restart (do not create credentials).

### Session log

- 2026-07-13: **Priority 8 — Vision backfill background job (done).** Background
  captioning of the media rows left `status='pending'` (unaddressed / group
  chatter), on the newly-decided **shared background-job operating model**.
  - **Decisions (user, AskUserQuestion):** (1) operating model = **in-process
    scheduler started from `instrumentation.ts`** (same lifecycle as the existing
    bot-manager / MCP / Playwright / realtime-hub `globalThis` singletons) over
    external cron→Route Handler / separate worker / on-demand-only — fits the
    single-container deployment, needs no new deploy unit or external cron, and is
    consistent with the recorded in-process polling decision; (2) trigger =
    **idle-debounced (MVP parity)** — a debounce timer re-armed on bot activity,
    aborting the running batch when live traffic resumes so backfill never competes
    with a live reply. Recorded in Decision Notes (the required sign-off for an
    in-process scheduler). Establishes the model for priorities 9–13.
  - **Shared job infra** `server/jobs/*`: `idle-scheduler.ts` (`createIdleScheduler`
    — job-agnostic phase machine (`idle`/`scheduled`/`running`) + debounce timer;
    `onActivity` re-arms + aborts a running batch, `runNow` bypasses the wait,
    `getStatus`, `stop`; cooperative abort via `ctx.isAborted()`), `lock.ts`
    (`withAdvisoryLock` — DB-backed cross-process lock via
    `pg_try_advisory_lock`/`pg_advisory_unlock` on **one pinned pool connection**,
    so a redeploy overlap can't double-run; the job's own queries stay on the shared
    pool — the lock is global across the DB).
  - **Vision backfill** `features/vision/server/backfill.ts` (`runVisionBackfill`)
    — never throws; wraps the advisory lock; loops `listPendingMedia` in batches of
    10, calls the existing `describeAndStore` per row (drops bytes on success),
    tracks attempted ids so a transient failure can't loop, respects `isAborted`,
    caps at 200 rows/run; traces the batch under a new **`vision-backfill`** feature
    (per-row describes still under `vision`). Idempotency = the existing
    `status='pending'` gating. `backfill-scheduler.ts` — `globalThis` singleton
    wiring the primitive to the job (45s debounce **code constant**, LLM conn read
    fresh per run; `pokeVisionBackfill`/`runVisionBackfillNow`/`getVisionBackfillStatus`/
    `start`/`stop`).
  - **Wiring:** `bot-manager.onMessage` → `pokeVisionBackfill()` on every message;
    `register-node.ts` → `startVisionBackfill()` on boot (arms an initial
    backlog-clearing run) + `stopVisionBackfill()` on shutdown. New repo/service
    `countPendingMedia`/`getPendingMediaCount`. `lib/features.ts` gained
    `vision-backfill` (label "Vision backfill", `vision` topic) → free shared Debug.
  - **Dashboard:** `VisionBackfillCard` on `/vision` (phase badge, backlog count,
    last-run summary/time, "Run now") + `GET/POST /api/vision/backfill`; live via
    the existing `vision` SSE topic (scheduler publishes on status change).
  - **Tests:** unit `server/jobs/idle-scheduler.test.ts` (+6, fake timers: debounce
    fire, re-arm on repeated activity, runNow, mid-run abort+re-arm, throw→error,
    stop) → **208 unit**. Integration `features/vision/server/backfill.integration.test.ts`
    (+7: describe-all + run/row traces, idempotent second run, empty-desc→unresolved
    + row stays pending, abort-early leaves rest pending, lock-held→skip, plus
    `withAdvisoryLock` acquire/release + nested-held-skip).
  - **Verified live** (dev server on 3200, HMR): `/vision` renders the Backfill
    card ("Idle" badge, "2 media rows awaiting a description. Runs automatically
    while the bot is quiet.", Run now button, Last run/result); no console errors;
    `GET /api/vision/backfill` → `{status:{phase:"idle",…},pending:2}`.
  - **Not run:** a real "Run now" against the operator's live pending media — it
    irreversibly drops their stored image bytes (describe + resave) and spends LLM
    tokens on real user data, so left to the operator; and the idle auto-run/poke
    wiring, which needs a dev-server restart (scheduler + bot-manager are boot-bound
    `globalThis` singletons — same operator gate as prior features).
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 208 ✓, backfill + vision
    integration ✓ (14 across the two files). `build` **not run** — dev server live
    on 3200 (`dont-clobber-running-dev-server`); typecheck covers type validity.

- 2026-07-13 (Priority 7 follow-up): **Caption-less media is processed like any
  message** (user: "when media is sent to the bot, even without text — it has to be
  visioned and processed like any other message"). The service's `no_content`
  early-return was discarding a photo/sticker with no caption before addressing or
  reply. Fix: `IncomingMessage` gained a `hasVision` flag (set by the runtime to
  `visionAttachment != null` — a loadable image on the message or a replied-to
  one), and the guard is now `if (!text && !incoming.hasVision) ignored("no_content")`.
  So a caption-less media message is addressed (private → always; group → mention/
  reply/command, which `checkAddressed` already reads from the caption), answered
  with the image attached, and described + resaved like a text turn. Addressing,
  ingest, and describe paths are unchanged. Test: bot-messaging `service.test.ts`
  (+1: empty text + `hasVision` → replied, image parts on the user turn) → **202
  unit**. lint ✓, typecheck ✓. Not verified live (operator gate: real photo → reply
  needs a bot token + poller restart).

- 2026-07-13: **Priority 7 — Bot messaging: vision (done).** The bot can receive
  image/sticker/media and answer with the media in view.
  - **Decisions (user):** (1) **same configured model** handles vision (no separate
    vision-model setting — MVP parity, one model assumed vision-capable);
    (2) **persist media now** — stored as **base64** on ingestion; (3) media **on
    the answered message** → **immediate visual recognition** (attached to the
    reply pass) then **resave replacing base64 with the vision-result
    description**; (4) **other media → backfill in a later phase (priority 8)**.
    Recorded in Decision Notes.
  - **Acceptance criteria (all met):** receive photo/sticker/image-doc/animation/
    video (+ replied-to media, depth 4); attach to the reply pass for the same
    model; store media; describe + drop bytes for the answered turn; graceful
    failure (never blocks a reply — unloadable media recorded `unavailable`);
    traced under `vision`; `/vision` dashboard + shared Debug; unit + integration
    tests; lint/typecheck/test green.
  - **New feature module** `features/vision/*` (see the Current Summary block above
    for the full file list + lifecycle). Grounded in the MVP
    `../ollama-tg-bot/server/src/features/vision/*` (detection precedence, describe
    prompt, sharp normalization), adapted to Next: `message_media` table instead of
    the MVP's media store, `ChatMessage` multimodal content parts instead of the
    MVP `VisionChatMessage.images`, immediate describe+resave for the answered turn
    (the MVP deferred all captioning to the idle backfill scheduler).
  - **Cross-cutting changes:** `ChatMessage.content: string | ChatContentPart[]`
    (`server/llm/client.ts`) + `sanitizeMessagesForTrace` (image bytes → byte-count
    marker in traces); `tool-loop.ts` seed mapping passes array content through;
    `next.config.ts` `serverExternalPackages` gains `sharp`; history
    `recordMediaMessageSchema` (empty content for media-only) + `getConversationWindow`
    `loadMediaSuffixes` injection + `toTranscriptLine` media suffix; `lib/features.ts`
    `vision` feature; `lib/realtime.ts` `vision` topic; nav `Vision` item;
    `test/db.ts` truncate adds `message_media`. Dep: `sharp@^0.34`.
  - **Tests:** unit `vision/detect.test.ts` (+11), `vision/format.test.ts` (+7),
    `vision/server/describe.test.ts` (+2), `client.test.ts` `sanitizeMessagesForTrace`
    (+3), history `format.test.ts` media suffix (+2), bot-messaging `service.test.ts`
    vision attach + reply-note (+2) → **201 unit**. Integration
    `vision/server/vision.integration.test.ts` (+7: idempotent insert, unavailable
    placeholder, markDescribed drops bytes + no re-describe, annotations,
    describeAndStore success/skip/error) → **86 integration**.
  - **Verified live** (dev server on 3200, HMR): `/vision` renders (nav item,
    LiveIndicator, Debug link → `/debug?feature=vision`, "No media yet" empty
    state); the `/debug` feature filter lists **Vision**; no console errors.
  - **Not verified live:** a real Telegram photo → reply round-trip (image
    attached to the model, then described+resaved) — needs a real bot token **and**
    a poller restart (the boot-time bot manager singleton won't pick up the new
    `onMessage` via HMR); same operator-run gate as features 1–6. No credentials
    created.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 201 ✓, integration 86 ✓,
    db:generate/db:migrate ✓. `build` **not run** — a dev server is live on 3200
    and `next build` would clobber its `.next` (memory
    `dont-clobber-running-dev-server`); typecheck covers type validity and the
    `serverExternalPackages`/nav changes are config/data-only. Run `npm run build`
    once the dev server is stopped.
  - **Docker note (Phase 11):** `sharp` needs its platform prebuilt binaries in the
    runner image — like `playwright`'s Chromium (already flagged), the Alpine
    `node:22-alpine` base must either install the musl `sharp` build or move to a
    glibc base. Recorded as a known risk alongside the Playwright one.

- 2026-07-13 (Priority 6 follow-up): **read_page usage + prompt/tool-description
  discipline** (user observed, from three live reply traces at ~15:53, that a shared
  Steam link was answered from memory and a "last update?" question triggered
  `search_web` — no `read_page`). **Root cause was mechanical:** those traces
  predate the tool's registration — at 15:53 the running poller's boot-time MCP
  registry singleton had only history + `search_web` + `update_user_aliases`, so
  `read_page` was uncallable (it appears on `/tools` now, after a restart).
  **Architecture correction (user directive):** the system prompt must **not list
  or describe tools** (no hardcoded tool enumeration), **each tool self-describes**
  via its own MCP description, and **tool descriptions must be atomic** — never
  reference another tool by name. Applied:
  - `bot-messaging/prompt.ts`: replaced the "Tools and honesty" section (which
    enumerated example tools) with a tool-agnostic **"Honesty"** section (do not
    claim an action you did not take this turn); the base prompt no longer names any
    tool. Doc comment updated to state the tool-agnostic rule.
  - `read_page` description now owns its own usage guidance ("read a shared/linked
    page instead of answering from memory") and **no longer mentions `search_web`**;
    `search_web` description reverted to its atomic form (**no `read_page`
    reference**).
  - Same anti-pattern fixed in the **DM identity context**: `known-users`
    `formatUserContext` was injecting a system message that named the
    `update_user_aliases` tool and gave usage guidance. It is now **identity facts
    only** (who + aliases); the "record a newly mentioned nickname, don't just claim
    you did" guidance moved into the `update_user_aliases` tool description (also
    covers self-reported nicknames now). `format.test.ts` updated to assert the
    context is tool-agnostic.
  - Checks: lint ✓, typecheck ✓, unit 175 ✓. **Takes effect only after a
    bot/dev-server restart** (base prompt via the service + tool descriptions via
    the registry are bound in the boot-time singleton) — retest a shared link
    afterward. (For the "last update?" case, `search_web` was arguably fine — the
    Steam *store* page doesn't list patch dates — so the real win is grounding
    replies about a shared page in its actual content instead of memory.)

- 2026-07-13: **Priority 6 — Visit/read link MCP tool (done).** A Playwright-backed
  `read_page` MCP tool exposed through the shared `server/mcp` registry.
  - **Decision (user, AskUserQuestion):** fetch engine = **Playwright / MVP parity**
    (headless Chromium `body.innerText`) over a lightweight `fetch`+HTML-extract
    approach — accepts the `playwright` dep + Chromium-in-Docker cost for JS-page
    support; the persistent browser singleton is part of "MVP parity". Recorded in
    Decision Notes.
  - **Acceptance criteria (all met):** a link-reading tool registered via the MCP
    registrar pattern, always available (no on/off), SSRF-protected, traceable
    through its own `mcp-tools-link-fetch` scope; graceful failure (never throws,
    honest "could not read"/"read failed" messages); unit tests; lint/typecheck/
    test green.
  - **Feature module** `features/link-fetch/*`: pure client-safe `types.ts`
    (`FetchedPage`), `format.ts` (`formatLinkFetchContext`/`formatLinkFetchFailure`),
    `url-safety.ts` (`isSafePublicUrl` — blocks bad scheme/creds/localhost/docker
    host/private+loopback+link-local IPv4&IPv6, incl. bracketed IPv6 hosts;
    `normalizeUrl`). Server-only `server/playwright.ts` (`getSharedChromium` +
    `fetchPageWithPlaywright` — `globalThis`-singleton browser, per-read isolated
    context, `--no-sandbox`, 60s nav timeout, 12k-char cap, never throws),
    `server/fetch-link.ts` (`fetchLink` boundary — normalize→SSRF→read→format,
    never throws, injectable `fetchPage`), `server/mcp-tools.ts`
    (`registerLinkFetchMcpTools`, `READ_PAGE_TOOL`/`LINK_FETCH_TOOL_NAMES`;
    `readOnlyHint:true`/`idempotentHint:true`/`openWorldHint:true`). Grounded in the
    MVP `../ollama-tg-bot/server/src/features/link-fetch/*`, adapted to Next MCP
    conventions (ZodRawShape `inputSchema`, no `browse_web` batch tool yet, single
    page only, `globalThis` singleton instead of module-level).
  - **Wiring:** `server/mcp/runtime.ts` registers the tool under feature
    `link-fetch`; `lib/features.ts` gained `mcp-tools-link-fetch` (label "Link
    reader tool"); `next.config.ts` gained `serverExternalPackages: ["playwright"]`.
    No DB/migration (the tool owns no persistence). `playwright@^1.52.0` added.
  - **Tests:** unit `url-safety.test.ts` (+9: public allow, bad scheme, creds,
    localhost/docker, private+loopback IPv4, private+loopback IPv6, malformed;
    `normalizeUrl`), `format.test.ts` (+5: title/content, no-title, empty-body,
    per-page error, failure), `server/fetch-link.test.ts` (+5: read+normalize,
    invalid-url skip, SSRF skip, per-page error, thrown→failure); mcp-tools
    `service.test.ts` updated for **6 tools** → **175 unit**.
  - **Verified live** (dev server on 3200, HMR): `/debug` feature filter now lists
    **"Link reader tool"** (`mcp-tools-link-fetch`); no console errors. **Not
    verified live:** `/tools` grouping + a real LLM `read_page` round-trip — the
    boot-time MCP registry singleton needs a dev-server restart to pick up the new
    tool, and a live call needs the operator-run bot-token gate (no credentials
    created; the user's live dev server was not restarted).
  - **Docker note (deferred to Phase 11):** the runner image is `node:22-alpine`;
    Playwright's downloaded Chromium does not run on Alpine — Phase 11 must install
    system Chromium (apk) or switch to the official Playwright base image before the
    read-link tool works in-container. Recorded as a known risk.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 175 ✓, integration 79 ✓
    (unchanged — feature is DB-free). `build` **not run** — a dev server is live on
    3200 and `next build` would clobber its `.next` (memory
    `dont-clobber-running-dev-server`); typecheck covers type validity and
    `serverExternalPackages` is config-only. Run `npm run build` once the dev server
    is stopped.

- 2026-07-13 (follow-up): **Group-chat context awareness — id-anchored transcript,
  24h window, reply resolution, addressing hint** (user request + decisions). The
  goal: in group chats the bot must know *who* is asking, *whom* they are talking
  about, and *which* message a reply points at (e.g. "@bot tell him why he is
  wrong" as a reply to an earlier claim).
  - **History format rewrite** (`features/history/server/format.ts`): history is
    now injected as **one `user` message** holding a transcript with a byte-stable
    preamble; each line is `[#<telegram_message_id>] <sender>: <text>` (bot rows
    labelled `You (@<botname>)`, unknown senders `User <id>`), and a reply is
    marked `[reply to #<id>]` (+ `, quoting: "…"` for Telegram partial quotes).
    Pure helpers: `historyWindowStart`, `renderReplyRef` (`anchor`/`inline`
    `ReplyRef`), `renderTranscriptLine`, `toTranscriptLine`, `renderTranscript`,
    `fallbackSpeakerLabel` (replaces `startOfUtcDay`/`toPriorTurn`).
  - **Window:** rolling **last 24 hours** (was: current UTC day). Speaker labels
    are now resolved for private chats too (the transcript is a flat document).
  - **Current turn** is rendered in the same line format by a new
    `composeCurrentTurn` (history service): its `reply_to_message` is resolved
    against the mirror — stored target → `[reply to #<id>]` anchor; unstored →
    the quoted sender + **full untrimmed text** inlined (from the Telegram
    payload); no textual content → `(content not available)`.
  - **New MCP tool `history_get_by_message_ids`** (`ids: number[]`, max 50) to
    dereference `#<id>` anchors outside the injected window; all history tool
    outputs now carry `[#<id>]` anchors + `replyTo` in lines and structured
    content; `history_search` description updated (24h, not "today").
  - **Group addressing hint** (`buildAddressingHint`, bot-messaging `prompt.ts`):
    a system message naming the sender (label from the raw Telegram user) and how
    they addressed the bot (mention/reply/command), instructing the model to
    direct the reply at another participant when asked to. Injected after chat
    context; null in private chats. `BASE_SYSTEM_PROMPT`'s Conversation section
    rewritten for the transcript format and reply-chain following.
  - **Service/deps:** bot-messaging gained `loadCurrentTurn` (best-effort, falls
    back to raw text) and records `current turn composed` (line, reply resolution,
    hint) between `chat context loaded` and `history window loaded`;
    `getConversationWindow` signature: `{ chatId, botLabel, excludeTelegramMessageId, now }`
    (no more `isGroup`). Runtime (`bot-manager.buildDeps`) wires `botLabel` and
    `loadCurrentTurn` (labels via `formatKnownUserLabel` on the raw `from`; the
    bot's own quoted messages labelled as itself). New repository fn
    `getChatMessagesByTelegramIds` (chat-scoped, non-deleted).
  - **Known limitation (user decision):** `message_thread_id` (forum topics) not
    stored — topics interleave in one transcript. Recorded in Decision Notes.
  - **Tests:** `format.test.ts` rewritten (window start, reply refs incl.
    untrimmed inline + quote, line/transcript rendering, labels);
    `history.integration.test.ts` (24h window incl. beyond-window exclusion,
    transcript output, empty window, `composeCurrentTurn` anchor/inline/quote,
    `getChatMessagesByTelegramIds` scoping); bot-messaging `service.test.ts`
    (+3: composed current turn + trace event, null-loader fallback, group
    addressing hint placement); `prompt.test.ts` (+4 hint variants);
    mcp-tools `service.test.ts` updated for the new tool.
  - Checks: lint ✓, typecheck ✓, unit 156 ✓, integration 79 ✓, build ✓.
  - Not verified live (no bot token in this session): a real group round-trip —
    same operator-run gate as features 1–5.

- 2026-07-13 (follow-up): **Per-tool trace scopes + change-gated passive capture**
  (user request, building on the registry work). (1) **Every MCP tool call now runs
  inside its own trace**, scoped to `mcp-tools-<owning-feature>` (e.g.
  `mcp-tools-history`, `mcp-tools-known-users`, `mcp-tools-web-search`) with the
  tool name as the trace action. Implemented as a single wrapper `tracedToolCall`
  (`server/mcp/tool-trace.ts`) around the one choke point `BotMcpRegistry.callTool`,
  so all current/future tools get a scope automatically. Best-effort at the
  `startTrace` boundary — a trace-backend failure never blocks a tool call (the
  reply trace still records the call inline). Added `tryGetToolContext()` (non-
  throwing) for the chatId/correlation. The three scopes are registered in
  `lib/features.ts` (labels "History tools"/"User tools"/"Web search tool"); the
  Tools dashboard gained a per-group **Debug** link → `/debug?feature=mcp-tools-*`.
  (2) **Passive user/group capture now records a trace only when data actually
  changes** — a newly seen user/group, a profile-field change, or a newly seen
  group member. Identical re-sightings stay untraced (they fire on every message);
  `updatedAt`/`last_seen_at` are still bumped so ordering/roster are unaffected.
  `rememberUser` reads the prior row and traces `capture-user`/`update-profile`;
  `rememberGroupActivity` traces `capture-group`/`update-profile`/`member-joined`
  (co-occurring changes fold into one trace with per-change events). New repo helper
  `groupMembershipExists`. **Tests:** extended known-users + known-groups
  integration suites (change-gating assertions; fixed a now-stale exact-count
  assertion in the groups notes test) and added `server/mcp/tool-trace.integration.test.ts`
  (success / isError-result / thrown-error scopes). Verified live: `/tools` shows
  per-group Debug links, `/debug` lists all tool scopes with clean labels, no
  console errors. Checks: lint ✓, typecheck ✓, test ✓ 135/135, test:integration ✓
  73/73. Remaining: legacy `mcp-tools` trace rows in the DB are still orphaned
  (no code writes that feature now) — left for a separate cleanup decision.
- 2026-07-13 (follow-up): **Trace feature-id consistency — central registry +
  Debug consolidation** (user request: "make traces consistent and keep them that
  way"). Root issue: each feature's `feature` string was a bare literal duplicated
  between its service (the trace *writer*) and its scoped Debug page (the *reader*),
  with nothing enforcing they matched — a rename would silently empty the Debug
  list. New single source of truth **`lib/features.ts`** (`FEATURES` registry,
  `FeatureId`, `FEATURE_IDS`, `featureLabel`, `featureDebugHref`) mapping each
  feature to its `id` / `label` / `realtimeTopic` / `relatedIdsKey` / `path`. All
  six services now read `FEATURES[...].id`, `.realtimeTopic`, and `.relatedIdsKey`
  instead of literals (bot-messaging, history, known-users, known-groups,
  personalities, settings). **Removed the 5 per-feature Debug pages**
  (`app/{groups,users,history,personalities,settings}/debug`); their dashboard
  "Debug" buttons now link to the shared `/debug?feature=<id>` via
  `featureDebugHref`. `DebugFilters` lists **every registered feature** (labeled),
  unioned with feature ids found in the data, so a feature is always selectable and
  an empty list reads as "no traces yet" rather than "missing". Verified live at
  `/debug?feature=known-groups`: Groups pre-selected, labels correct
  ("Bot messaging"/"Users"/"Groups"), download href carries the filter. Checks:
  lint ✓, typecheck ✓ (via build), test ✓ 135/135, build ✓. **Findings for
  follow-up:** (a) legacy `mcp-tools` traces exist in the DB but no current code
  records that feature — orphaned rows (surfaced, unlabeled, in the filter);
  (b) tool calls are traced as `external_call` events inside `bot-messaging` reply
  traces, not under their own feature — the Tools dashboard has no Debug scope;
  (c) passive user/group capture (`rememberUser`/`rememberGroupActivity`) remains
  intentionally untraced (high-frequency upsert) — consistent across features.
- 2026-07-13 (follow-up): **Settings split into Core / Integrations tabs** (user
  request — visual separation, "everything except the Tavily key is core"). New
  shared **`Tabs` primitive** in the UI kit (`components/ui/Tabs.tsx`,
  barrel-exported with `TabItem`): accessible tablist/tabpanel, arrow-key nav,
  uncontrolled-or-controlled, all panels stay mounted (inactive `hidden`) so field
  state survives switching. `SettingsForm` reorganized into a **Core** tab (LLM
  URL/key/model + Test connection, Telegram token, Owner, Maintenance mode — the
  bot won't run without these) and an **Integrations** tab (Tavily/web-search key,
  with a "the bot runs without these" note). One **Save** button below the tabs
  persists every dirty field regardless of active tab (the PATCH is already
  dirty-field based — no per-tab save). Verified live: both tabs render, switching
  hides the other group, the Tavily field lives under Integrations, Save stays
  visible; no console errors. Checks: lint ✓, typecheck ✓, build ✓ (0 warnings).
- 2026-07-13: **Priority 5 — Search MCP tool (done).** A Tavily-backed
  `search_web` MCP tool exposed through the shared `server/mcp` registry, plus
  DB-backed config for the API key.
  - **Acceptance criteria (all met):** a web-search tool registered via the MCP
    registrar pattern, always available (no on/off), traceable through the reply
    trace's `external_call` events; API key configured through the dashboard (not
    env); graceful failure (never throws, honest "unavailable"/"failed" messages);
    unit + integration tests; lint/typecheck/test/build green.
  - **Feature module** `features/web-search/*`: pure `types.ts`
    (`WebSearchResult`/`WebSearchSource`/`WebSearchPayload`) + `format.ts`
    (`formatWebSearchContext` — summary + numbered sources + citation guidance,
    or a "no results, use general knowledge" message; `extractWebSearchSources`
    dedupe-by-url; `formatWebSearchFailure`; `normalizeTavilyResults`; client-safe,
    unit-tested). `server/search.ts` (`runWebSearch(query, config)` — Tavily
    `POST https://api.tavily.com/search`, `search_depth: basic`, `max_results: 5`,
    `include_answer: true`, 60s timeout, injectable `fetch`; **always resolves**
    with `{ ok, sources, context, reason }`). `server/mcp-tools.ts`
    (`registerWebSearchMcpTools` + `WEB_SEARCH_TOOL_NAMES`; `search_web`,
    `readOnlyHint:true`/`openWorldHint:true`; reads `getWebSearchApiKey()` at call
    time, returns `isError` when unset). Grounded in the MVP
    `../ollama-tg-bot/server/src/features/web-search/*`, adapted to the Next MCP
    conventions (ZodRawShape `inputSchema`, no FeatureDefinition registry).
  - **Config in DB** (`config-in-db-not-env`): masked `settings.tavily_api_key`
    (migration `0008_lush_bloodstorm.sql`), repository record/patch/mapRow,
    `updateSettingsSchema.tavilyApiKey` (write-only, empty→clear), client
    `settingsSchema.webSearchConfigured`, service `toClientSettings`/`toPatch`/
    `redact` + server-only `getWebSearchApiKey()`. SettingsForm gained a **Tavily
    API key** password field (mirrors the bot-token field).
  - **Wiring:** `server/mcp/runtime.ts` registers the web-search tools; the tool
    becomes available automatically via `getToolset()` (bot-manager already runs
    the tool loop when any tool is registered — no runtime change needed).
  - **Tests:** unit `web-search/format.test.ts` (+6: normalize, context with/
    without results, source dedupe, failure) + `web-search/server/search.test.ts`
    (+6: success sources/context, Bearer+query wiring, empty query, HTTP error,
    fetch rejection, missing key); `mcp-tools/service.test.ts` updated for 4 tools
    → **135 unit**. Integration `settings.integration.test.ts` (+1: Tavily key
    masked/configured/clearable + server-only accessor; default-shape +
    redaction cases extended) → **68**.
  - **Verified live** (dev server, migration applied): `/tools` lists `search_web`
    under a **Web-Search** group; `/settings` renders the Tavily API key field
    between the Telegram token and Owner; no console errors. Server-side
    masking/persist/clear/redaction proven by integration tests.
  - **Not verified live:** a real LLM tool-call + live Tavily round-trip — shares
    the operator-run live-bot token gate (no credentials created).
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 135 ✓, integration 68 ✓,
    build ✓ (0 warnings, `search_web` registered), db:generate/db:migrate ✓.
- 2026-07-12 (follow-up 12): **Env surface trimmed to bootstrap-only** (user
  request; the cleanup flagged in follow-up 11). `server/env.ts` now declares
  only `DATABASE_URL`, `TZ`, `NODE_ENV` (the `<NAME>_FILE` Docker-secret
  mechanism and lazy `requireEnv` contract unchanged) — removed the unread
  MVP-era keys (`BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `LLM_*`,
  `EMBEDDING_*`, `IMAGE_GENERATION_*`, `TAVILY_API_KEY`, `DOWNLOADS_DIR`,
  `LOGGING_LEVEL`). `docker-compose.yml` app service now forwards only
  `NODE_ENV`/`PORT`/`DATABASE_URL`/`TZ`. `.env.example` dropped the
  "Reserved" section; DESIGN.md Configuration no longer calls the schema
  legacy. `server/env.test.ts` retargeted to the surviving keys (invalid-enum
  case now uses `NODE_ENV`, via a plain-record cast since Next types it
  read-only). Per AGENTS.md, whether any future key lives env-side stays a
  per-feature user decision — this removed only vars nothing reads
  (`db/pool.ts` → `DATABASE_URL` is the sole consumer). Checks: lint ✓,
  typecheck ✓, unit 123 ✓, integration 67 ✓, build ✓.
- 2026-07-12 (follow-up 10): **Known groups + group↔user membership + group
  context injection** (user request — a new user-directed feature, not in the
  original priority list). Mirrors the known-users feature: a first-class list of
  the groups the bot is in, the relation of which users belong to which group,
  and — built on that relation — a roster of known participants injected into the
  model's context for a group reply so it can recognize who is who.
  - **Acceptance criteria (all met):** groups captured passively on each group
    message; per-group membership recorded (refreshed `last_seen_at`); a bounded
    roster (name + operator aliases + optional group notes) injected as a system
    message for group replies; dashboard list + per-group detail (members + notes)
    + Debug page; notes edits traced; live over SSE; unit + integration tests;
    lint/typecheck/test/build green.
  - **Schema (migration `0007_normal_leper_queen.sql`):** `known_groups`
    (`chat_id` PK, `title`, `type`, operator-curated `notes`, timestamps —
    passive upsert refreshes `title`/`type`, never clobbers `notes`) and
    `group_members` (`(chat_id,user_id)` PK, FKs → `known_groups`/`known_users`
    `on delete cascade`, `first_seen_at`/`last_seen_at`; chat + user indexes).
  - **Feature module** `features/known-groups/*`: `server/repository.ts`
    (`upsertKnownGroup`/`listKnownGroups` (member-count join)/`getKnownGroup`/
    `setKnownGroupNotes`/`recordGroupMembership`/`getGroupMembers` (join to
    known_users, most-recent-first, bounded)), `server/schema.ts`
    (`knownGroupSchema`, `updateGroupNotesSchema` — trim/empty→null, ≤2000, view
    types), pure `format.ts` (`formatKnownGroupLabel`, `formatGroupContext` — the
    roster block builder, client-safe, unit-tested), `server/service.ts`
    (`listGroups`/`getGroupWithMembers`/`rememberGroupActivity` (passive, untraced)/
    `updateNotes` (traced)/`getGroupContext` — roster capped at 50), ui
    (`KnownGroupsList`, `GroupMembersCard`, client `GroupNotesEditor`).
  - **Runtime + injection:** `bot-manager.onMessage` calls `rememberGroupActivity`
    for group/supergroup chats (after `rememberUser`, so the membership FK holds).
    `bot-messaging/service.ts` exposes a single optional **`loadChatContext`** dep
    (best-effort — a lookup failure resolves null, never drops the reply): when it
    returns non-null it records a **`chat context loaded`** step and injects the
    context as a second `system` message after the (cache-stable) base prompt,
    before the history window (`[systemBase, chatContext?, ...history, current]`).
    `buildDeps` wires it per chat type — in a group to `getGroupContext` (roster),
    in a private chat to `getUserContext` (the DM identity block, see known-users
    below). Superseded the earlier groups-only `loadGroupContext`/`group context
    loaded` shape (renamed 2026-07-13).
  - **Routes/pages/nav:** `GET /api/groups`, `PATCH /api/groups/[id]` (notes);
    `/groups` (list), `/groups/[chatId]` (notes editor + members, `notFound` on
    unknown id), `/groups/debug` (shared `TraceExplorer`, notes-edit traces). Nav
    gained a **Groups** item; new `groups` SSE topic (`LiveIndicator`).
  - **Tests:** unit `format.test.ts` (+7: label + roster with aliases/notes/no-title
    + null cases), `schema.test.ts` (+3: trim/clear/bounds), bot-messaging
    `service.test.ts` (+2: group roster injected as 2nd system message + step
    order; step omitted when loader→null) → **123 unit**. Integration
    `known-groups.integration.test.ts` (+10: capture + title-refresh-without-
    clobbering-notes, membership scoping, list order + counts, members order,
    detail/unknown, notes set/clear + trace, unknown→error trace, context roster
    build, empty/unknown→null) → **67**.
  - **Verified live** on the dev server (migration applied): seeded a "Family Chat"
    supergroup with two members → `/groups` lists it (2 members); `/groups/-1009999`
    shows the notes editor + members table (George (@drumslave) with aliases
    "Dad, Boss"; Alice Smith no aliases; ordered by last-seen); editing notes
    PATCHed 200, persisted on reload, and recorded a `known-groups`/`update-notes`
    **success** trace (102ms) on `/groups/debug`; no console errors. Seeded rows +
    traces deleted afterward — dev DB restored.
  - **Not verified live:** the actual LLM roster injection through a real Telegram
    group message — shares the operator-run live-bot token gate (no Telegram
    credentials created); covered by the unit + integration tests above.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 123 ✓, integration 67 ✓, build
    ✓ (0 warnings, `/groups*` + `/api/groups*` routes present), db:generate/
    db:migrate ✓.
- 2026-07-12 (follow-up 9): **New MCP tool `update_user_aliases`** (user request:
  when the model sees a person referred to by another name/nickname, update
  `known_users`). A **write** tool (the first non-read-only one).
  - **How the model targets a user:** it identifies people by the names it sees in
    conversation (first name, @username, an existing nickname) — never a numeric
    id (group speaker labels don't expose ids). So the tool takes a `name`
    reference + `aliases`, and resolution is **chat-scoped**: only people who have
    messaged in the current chat can be matched (via the tool context's chatId),
    so the model can never rename an unrelated user.
  - **Files:** pure `features/known-users/match.ts` (`matchUsersByReference` —
    exact case-insensitive match of a reference against username/first/last/full
    name/aliases; unit-tested); history `repository.getChatParticipantIds` (distinct
    non-deleted senders in a chat); known-users `service.addAliasByReference`
    (resolve → filter aliases already implied by identity, strip a leading `@` →
    append via `updateAliasesSchema` clean/bounds → `setKnownUserAliases`; **traced**
    under `known-users`/`add-aliases`, `skip` on no-match/ambiguous/noop, publishes
    `users`); `features/known-users/server/mcp-tools.ts` (`update_user_aliases`,
    `readOnlyHint:false`, thin — calls `addAliasByReference`, maps result to text).
    Registered in `server/mcp/runtime.ts` under feature `known-users`.
  - **Result contract** (`updated`/`noop`/`not_found`/`ambiguous`/`invalid`) maps
    to a clear model-facing message; ambiguity asks the model to use @username.
    The mutation shows on `/users/debug` (known-users trace) and the tool call on
    the reply trace (`external_call`). `/tools` now lists it under a `known-users`
    group.
  - **Tests:** unit `match.test.ts` (+4: name/username/full-name/alias match, CI,
    no-substring, ambiguous), mcp-tools `service.test.ts` updated for 3 tools →
    **112 unit**. Integration `known-users.integration.test.ts` (+5:
    resolve+append+trace, not_found→skip, ambiguous, identity no-op, cross-chat
    isolation) → **57**.
  - Checks: lint ✓, typecheck ✓, unit 112 ✓, integration 57 ✓, build ✓ (0
    warnings). Live browser check pending a dev-server restart (unchanged from
    follow-up 8; the MCP registry is a `globalThis` singleton).
- 2026-07-12 (follow-up 8): **Removed MCP tool on/off** (user: "we dont need
  turning on/off for mcp tools"). All registered MCP tools are now **always
  available** to the model; the runtime always offers every registered tool.
  - **Deleted:** the `settings.enabled_tool_names` column (migration `0007`
    **squashed** — sql + snapshot + journal entry removed, dev DB column dropped +
    stray `__drizzle_migrations` row deleted; `db:generate` shows no diff, settings
    back to 10 columns), settings `getEnabledToolNames`/`setEnabledToolNames`, the
    registry enabled-set (`setEnabledToolNames` + filtering — `listAllTools` →
    `listTools`, `callTool` no longer gates), mcp-tools `setToolEnabled` +
    `setToolEnabledSchema` + `ToolView.enabled`, `PATCH /api/tools/[name]`, the
    `/tools/debug` page, and the `tools` SSE topic.
  - **Now:** `getToolset()` (was `getEnabledToolset`) returns every registered
    tool; bot-manager always runs the tool loop when any tool is registered.
    `getToolsView()` is a read-only registry listing; the `/tools` page renders it
    as a static, grouped, read-only list (no switches, no Live pill, no Debug
    link). The `mcp-tools` service test moved to the unit suite (no DB).
  - Checks: lint ✓, typecheck ✓, unit **107** ✓, integration **52** ✓, build ✓
    (0 warnings), `db:generate` (no diff) ✓. Live browser re-check pending — the
    dev server must be restarted to pick up server-side changes (the MCP registry
    is a `globalThis` singleton, like the bot poller; HMR does not refresh it).
- 2026-07-12 (follow-up 7): **Priority 4 — MCP tools basic support (done).**
  Tool transport = **real MCP SDK, in-process** (user decision via
  AskUserQuestion — MVP parity; enables connecting external MCP servers later);
  v1 scope = **infrastructure + the first history tools** (user decision).
  - **Dep:** `@modelcontextprotocol/sdk@^1.29` (verified it works with this repo's
    **zod 4** — peer `^3.25 || ^4.0`; the working `registerTool` form takes a
    **ZodRawShape**, not `z.object(...)`).
  - **Shared MCP infra** `server/mcp/*`: `in-process-transport.ts` (linked
    `Transport` pair), `tool-result.ts` (`McpToolCallResult`), `openai-tools.ts`
    (`mcpToolToOpenAi` — strips the SDK's `$schema` marker; `callToolResultToText`;
    `toToolCallResult`), `context.ts` (`AsyncLocalStorage` per-turn `{chatId}` +
    `runWithToolContext`/`getToolContext`), `registry.ts` (`BotMcpRegistry`:
    server↔client connect, `registerTools(feature, registrar, names)`,
    `listAllTools`/`listOpenAiTools` (enabled-filtered)/`callTool`), `runtime.ts`
    (`loadMcpRegistry` — `globalThis` singleton, registers history tools).
  - **Tool-call loop** `server/llm/tool-loop.ts`: pure `runToolLoop` (progress-/
    stall-guarded, `MAX_STALL_ROUNDS=3`, optional `maxRounds`, usage+latency
    summed, `onToolCall` per call) + `chatCompletionWithTools` (wires the OpenAI
    client; same `ChatCompletionResult` shape as `chatCompletion`; throws on a
    stalled/empty loop). `client.ts` now exports `createOpenAiClient`/`toLlmError`/
    `CHAT_COMPLETION_TIMEOUT_MS` for reuse.
  - **History tools** `features/history/server/mcp-tools.ts`: `history_search`
    (case-insensitive content match, multi-query merge) + `history_get_in_range`
    (ISO range). Chat bound via the tool context (no model-supplied id → no
    cross-chat leakage). New repo queries `searchChatMessages` (LIKE-escaped) +
    `getChatMessagesInRange`.
  - **Enablement + dashboard** `features/mcp-tools/*`: `settings.enabled_tool_names
    text[]` (migration `0007`) with server-only `getEnabledToolNames`/
    `setEnabledToolNames` accessors; `service.ts` (`getToolsView`,
    `setToolEnabled` — traced under feature `mcp-tools`, prunes stale names,
    `getEnabledToolset` for the runtime). `/tools` page (per-tool switches, live
    via new `tools` SSE topic) + `/tools/debug`; `GET /api/tools`, `PATCH
    /api/tools/[name]`. Nav gained a **Tools** item.
  - **Wiring:** `bot-manager.buildDeps.generateReply` now resolves the enabled
    toolset per turn — none → single `chatCompletion` (unchanged); some → run
    `chatCompletionWithTools` inside `runWithToolContext({chatId})`. Bot-messaging
    `service.ts` `generateReply` gained an optional `onToolCall` sink; each tool
    call is recorded as a full `external_call` event on the **reply** trace
    (between `request` and `response`), so tool activity shows in `/debug` — no
    separate feature trace for calls.
  - **Tests:** unit `server/mcp/openai-tools.test.ts` (+6), `server/mcp/
    registry.test.ts` (+4, in-process SDK round-trip — proves zod-4 compat),
    `server/llm/tool-loop.test.ts` (+7: answer, tool→answer, tool error,
    isError, stall, maxRounds), `features/mcp-tools/server/schema.test.ts` (+2),
    bot-messaging `service.test.ts` (+1: tool call → `external_call` event flow) →
    **108 unit**. Integration: history repo search/range (+3),
    `features/mcp-tools/server/mcp-tools.integration.test.ts` (+7: view, enable/
    disable + trace, unknown→fail, stale-prune, toolset null/resolved) → **59**.
  - **Verified live** (dev server + dev DB, migration applied): `/tools` lists the
    two history tools grouped under `history`; enabling `history_search` persisted
    (Enabled badge; toggle flipped) and recorded an `mcp-tools`/`enable` success
    trace on `/tools/debug` (139ms); `GET`/`PATCH /api/tools` return the standard
    envelope; no console errors. Dev DB restored (both tools disabled).
  - **Not yet verified:** a real LLM tool-call round-trip through a live bot —
    shares the operator-run token gate for features 1–4.
  - Checks: lint ✓, typecheck ✓, unit 108 ✓, integration 59 ✓, build ✓ (0
    warnings), db:generate/db:migrate ✓.
- 2026-07-12 (follow-up 6): **History message → trace navigation + newest-first
  order** (user requests). (1) The per-chat mirror (`/history/[chatId]`) is now
  ordered **newest first** (`getChatMessages` → `desc(id)`); the LLM injection
  window (`getChatMessagesSince`) stays chronological. (2) Each message row links
  to the trace that handled its turn: a new **Trace** column → `/debug/[id]`.
  Resolution is by trace **correlation id** (`${chatId}:${messageId}`) — a user
  row uses its own id, an assistant row uses the message it replied to, so a
  turn's user+assistant rows both point at the same trace. Added
  `getLatestTraceIdsByCorrelation` to `server/trace/repository.ts` (batch lookup,
  newest per correlation id via the existing `traces_correlation_idx`);
  `getChatHistory` annotates each row with `traceId` (`ChatMessageWithTrace`).
  The trace already carries both relations — input via `correlationId`, reply via
  the `send message` event's `messageId` — so no schema change was needed. Tests:
  history integration (+2: newest-first order, user+reply→same-trace / no-trace →
  null). Verified live: chat 312973896's 4 rows render newest-first with Trace
  links; clicking one opened its `bot-messaging/reply` detail (correlation
  `312973896:867`, reply `messageId:868`). Checks: lint ✓, typecheck ✓, unit 89
  ✓, integration 49 ✓, build ✓ (0 warnings).
- 2026-07-12 (follow-up 5): **Live updates for data pages (user directive).**
  User set a **standing rule**: every data-display page (current and future) must
  update live over the shared SSE layer — no manual refresh (memory
  `live-data-no-manual-refresh`). Triggered by History not auto-updating.
  - Added `history` + `users` to `REALTIME_TOPICS` (`lib/realtime.ts`).
  - `history` service calls `publishEvent("history")` after each record/edit;
    known-users service calls `publishEvent("users")` after capture + alias edit.
  - `<LiveIndicator topic>` added to `/history`, `/history/[chatId]`, and
    `/users` headers (Debug pages already live via the `traces` topic).
  - Also uncovered + fixed the real cause of the earlier "reply but nothing in
    history": the Telegram poller is a boot-time `globalThis` singleton, so HMR
    doesn't reload its handlers — a dashboard Stop/Start (or dev-server restart)
    is required after server-side bot changes. After restart, real messages
    record correctly (verified: chat 312973896 has 4 rows; the 2nd reply
    referenced the 1st turn → history injection working; trace shows the
    `history window loaded` step).
  - Verified the live loop end-to-end: with `/users` open and untouched, an alias
    PATCH (in-process `publishEvent("users")`) produced a `/users?_rsc` refetch.
    Known limitation logged: `KnownUsersTable`'s alias input holds server data in
    `useState`, so that cell doesn't reflect a refresh (row data does); pure
    Server-Component tables like History update visibly.
  - Checks: lint ✓, typecheck ✓, unit 89 ✓, integration 47 ✓, build ✓ (0
    warnings).
- 2026-07-12 (follow-up 4): **Priority 3 — History feature (done).** A 1:1
  Telegram conversation mirror + current-day context injection. User decisions
  this session (via AskUserQuestion): injection = **structured prior turns**
  (real `user`/`assistant` messages, not an MVP-style tagged transcript block),
  storing **full per-message metadata**; window scope = **current day's
  messages**; the mirror must track **edit and delete** events 1:1.
  - **Schema (migration `0006_tricky_eternity.sql`):** `chat_messages` —
    identity `id` (append-only log; monotonic order, extension-free — a
    documented exception to the app-UUID convention), `chat_id`,
    `telegram_message_id`, `role` (`user`/`assistant`), `user_id`, `content`,
    `reply_to_message_id`, `sent_at`, `edited_at`, `deleted_at`, `created_at`.
    Unique `(chat_id, telegram_message_id)` (so `edited_message` locates the row);
    index `(chat_id, sent_at)`.
  - **Feature module** `features/history/*`: `repository.ts` (append idempotent
    on conflict / getByTelegramId / updateContent / getMessagesSince /
    listChatSummaries / getChatMessages), pure `format.ts` (`startOfUtcDay`,
    `toPriorTurn` with group speaker prefix, `collectUserIds`), `schema.ts` (zod
    record/edit inputs + client view types), `service.ts`
    (`recordIncomingMessage`/`recordAssistantMessage` — passive, untraced;
    `applyMessageEdit` — traced; `getConversationWindow` — today's messages as
    prior turns, group labels via `getKnownUsersByIds` + `formatKnownUserLabel`;
    `getHistoryOverview`/`getChatHistory` for the pages).
  - **Injection:** bot-messaging `service.ts` gained `loadHistory` + `recordReply`
    deps and `sendReply` now returns `{ messageId }`; the reply flow records a
    `history window loaded` step and injects the window between the (cache-stable)
    system prompt and the current turn, then mirrors the delivered reply
    (best-effort). `BASE_SYSTEM_PROMPT` gained a short Conversation section.
  - **Runtime:** `bot-manager.onMessage` mirrors every human message passively
    (alongside `rememberUser`); `buildDeps` wires `loadHistory`/`recordReply` and
    returns the delivered id from `sendReply`; new `bot.on("edited_message")` →
    `applyMessageEdit`; `allowed_updates` now `["message","edited_message"]`.
  - **Deletes — Telegram limitation:** the Bot API has no deletion update for
    ordinary private/group chats, so user-initiated deletes cannot be mirrored.
    `deleted_at` exists for deletions we can know about (bot's own /
    Business-connection `deleted_business_messages`); recorded in Decision Notes.
  - **Pages:** `/history` (chat list), `/history/[chatId]` (full mirror with
    edited/deleted badges), `/history/debug` (shared `TraceExplorer`, edit
    traces). Nav `/history` un-`soon`ed.
  - **Tests:** `format.test.ts` (+8: day boundary, prior-turn mapping incl.
    group prefix + unknown-speaker fallback, id collection); bot-messaging
    `service.test.ts` (+1 history injection order + `recordReply`; flow/deps
    updated); `history.integration.test.ts` (+7: append idempotency, empty-skip,
    today-only window excluding current, group labels, edit rewrite + success
    trace, edit-unknown → skipped, chat summaries order). Unit 89, integration 47.
  - **Verified live** on the dev server (migration applied): seeded two chats →
    `/history` lists both most-recent-first with counts; `/history/777` shows the
    metadata mirror (reply pointer, `edited` badge); `/history/debug` renders; no
    console errors. Seeded rows deleted afterward — dev DB clean.
  - Checks: lint ✓, typecheck ✓, unit 89 ✓, integration 47 ✓, build ✓ (0
    warnings), db:generate/db:migrate ✓.
- 2026-07-12 (follow-up 3): **UI-kit consolidation + `/users` card-per-section**
  (user request). (1) Moved the last stray shared primitive, `StatusCard`, into
  the ui-kit (`components/ui/StatusCard.tsx`, barrel-exported with `StatusTone`);
  the Overview now imports it from `@/components/ui`. Removed the empty
  `components/dashboard/` dir. Audited every page's non-`ui` `@/components/*`
  imports: only `components/debug/*` (shared trace UI), `components/theme/*`,
  `components/realtime/*`, and `components/layout/*` remain — cohesive shared
  modules, not primitives, so they stay. No page hand-rolls a primitive that the
  kit provides. (2) Aligned `/users` to the same card-per-section layout as
  `/personalities`: `KnownUsersTable` now owns its `Card` (CardHeader title +
  description, CardContent table/empty), and `app/users/page.tsx` is just
  `PageHeader` + the component (bare `EmptyState` on DB error, matching
  personalities). Checks: lint ✓, typecheck ✓, unit 81 ✓, build ✓ (0 warnings).
  Verified live (both DB-down and DB-up): `/users` renders the error-path
  "Database unavailable" fallback when the DB is down, and — after restarting the
  dev Postgres container — the card-per-section happy-path (the `Card` with title
  + description wrapping the users table; row `@drumslave` with inline alias
  editor). Overview renders the kit's `StatusCard`s (DATABASE/LLM/MODEL/TELEGRAM).
  Only console noise is the pre-existing benign `ThemeScript` pre-hydration dev
  warning.
- 2026-07-12 (follow-up 2): **UI-kit adoption for personalities** (user
  feedback — `PersonalitiesManager` had too many bespoke elements). Refactored it
  to compose entirely from shared primitives: the create form and each persona
  are now `Card`/`CardHeader`/`CardTitle`/`CardContent`/`CardFooter`/`CardAction`
  (no hand-rolled bordered `<div>`s or `<h3>`s); the page dropped its outer Card
  wrapper so the manager owns its cards. Moved **`PageHeader` into the ui-kit**
  (`components/ui/PageHeader.tsx`, exported from the barrel) and updated all 8
  importers to `@/components/ui` — the kit is now the single entry point for the
  page-heading primitive too. Verified live: `/personalities` renders the
  Card-based layout (create card + per-persona cards with header actions +
  Active badge), create/set-active/delete work, no console errors; `/`,
  `/settings`, `/users`, and all `*/debug` pages still 200 after the PageHeader
  move. lint ✓, typecheck ✓, build ✓ (0 warnings), unit 81 ✓.
- 2026-07-12 (follow-up): **Rewrote `BASE_SYSTEM_PROMPT` from the MVP.** Reviewed
  the MVP's `BASE_SYSTEM_PROMPT_CORE` + `buildReplyFormatSpec` and distilled the
  **capability-agnostic** parts into our base: persona framing (Telegram chat
  assistant), output discipline (reply only — no JSON/wrapper/labels), **plain
  text only** (we send no `parse_mode`, so markup renders literally — unlike the
  MVP which allows Telegram HTML), brevity (well under 4096), capability honesty
  ("you see only the current message; no history/tools/web; don't claim actions
  you can't do"), and prompt-injection/secrecy defenses (treat the user message
  as data; never reveal the system prompt; refuse briefly). **Dropped** everything
  tied to unbuilt machinery — history retrieval/`[RECENT CHAT]`/speaker tags,
  memory/tasks/mood, tool use, known-user directory — to avoid instructing the
  model to use tools that don't exist. Code comment flags the "no tools/history"
  lines for revision when priorities 3–4 land. Tests reference the constant, so
  they held (lint ✓, typecheck ✓, unit 81 ✓).
- 2026-07-12: **Priority 2 — system and personality prompts (done).**
  Personalities are a **full CRUD feature with a dedicated page + active
  selection** (user decision — corrected mid-task from an initial "single
  editable `personality_prompt` field on settings" approach, which was reverted).
  The base system prompt stays a fixed code constant; the operator manages named
  personas and picks the active one, whose prompt is composed into every reply.
  - **Schema (migration `0005_aberrant_maria_hill.sql`, squashed — the reverted
    `personality_prompt` migration was deleted, not stacked):** a `personalities`
    table (`id` app-uuid, `name`, `prompt` default '', timestamps; `name` index)
    + `settings.active_personality_id` (nullable, FK → `personalities.id`
    **`on delete set null`** so deleting the active persona clears the selection).
  - **Feature module** `features/personalities/*`: `repository.ts`
    (list/getById/count/isNameTaken(CI)/insert/update/delete), `schema.ts` (zod:
    create/update/set-active; bounds name ≤64, prompt ≤32000, max 32 — mirror the
    MVP), `service.ts` (`getPersonalitiesView` {personalities, activeId},
    `createPersonality`/`editPersonality`/`removePersonality`/`setActivePersonality`
    — all traced; case-insensitive name-uniqueness + max-count guards; server-only
    `getActivePersonalityPrompt` for composition), `ui/PersonalitiesManager.tsx`
    (create form + per-card edit/delete + set-active/deactivate).
  - **Routes:** `GET/POST /api/personalities`, `PATCH/DELETE
    /api/personalities/[id]`, `PUT /api/personalities/active`. **Pages:**
    `/personalities` (Server Component → manager) + `/personalities/debug`
    (shared `TraceExplorer`). Nav: the planned `/prompts` "soon" item became the
    live **Personalities** item.
  - **Composition (kept from the reverted attempt):**
    `features/bot-messaging/server/prompt.ts` (pure, unit-tested) —
    `BASE_SYSTEM_PROMPT` + `buildSystemPrompt({ personalityPrompt })` (base alone,
    or base + `\n\n---\nAdditional instructions:\n<persona>`) + `hasPersonality`;
    replaces the old inline `DEFAULT_SYSTEM_PROMPT`. The service records a
    **`system prompt composed`** step (`personalityApplied` + full composed prompt)
    between `addressing check` and `request`; `bot-manager.onMessage` injects the
    **active** persona via `getActivePersonalityPrompt()` (`Promise.all` with
    `getBotPolicy()`).
  - **Reverted** the interim settings changes: no `personality_prompt` column,
    no `getPersonalityPrompt`, no SettingsForm textarea; `settings` now carries
    `active_personality_id` instead (internal record/patch only — not in the
    client `settingsSchema`, since active-selection is managed on the
    Personalities page). `test/db.ts` truncate now includes `personalities`.
  - **Tests:** `prompt.test.ts` (+4), bot-messaging `service.test.ts` (+2,
    event-flow updated), personalities `schema.test.ts` (+7), personalities
    `personalities.integration.test.ts` (+8: create/list, dup-name CI, edit +
    rename-conflict + unknown, set/clear-active + resolve prompt, invalid activate,
    delete + FK-clears-active + unknown, per-mutation traces). Unit 81,
    integration 40.
  - **Verified live** on the dev server: created "Grumpy Sysadmin" on
    `/personalities`, set it active (Active badge; `activeId` confirmed via
    `GET /api/personalities`), deleted it (list emptied; `activeId` auto-cleared
    to null via the FK); `create`/`set-active`/`delete` traces `success` on
    `/personalities/debug`; no console errors. Dev DB left clean (0 personalities).
  - Checks: lint ✓, typecheck ✓, unit 81 ✓, integration 40 ✓, build ✓ (0
    warnings), db:generate/db:migrate ✓.
- 2026-07-11 (follow-up 10): **Maintenance mode simplified to owner-vs-everyone**
  (user clarification — supersedes the group-@mention rule from follow-ups 6/9).
  In maintenance mode the bot is **fully functional for the owner** (normal
  addressing only — no extra "must @mention in a group" restriction) and closed
  to everyone else, who always get the static `MAINTENANCE_REPLY`. Dropped the
  `group_requires_mention` reason and the `isGroup`/`source` args from
  `checkMaintenance` (now just `{ policy, owner }`). Updated the maintenance-mode
  hint in `SettingsForm`. Tests: `policy.test.ts` (removed the group-mention
  case), `service.test.ts` (owner is now fully functional in a group during
  maintenance; block-event data is `{ reason: "not_owner" }`). lint ✓,
  typecheck ✓, unit 71 ✓, build ✓ (0 warnings). Telegram-path behavior — covered
  by unit tests, not browser-verifiable.
- 2026-07-11 (follow-up 9): **Maintenance-mode notice for non-owners** (user
  request). A non-owner who addresses the bot during maintenance now gets a
  static reply (`MAINTENANCE_REPLY`) explaining maintenance mode instead of
  silent ignore — sent best-effort and recorded as a `maintenance notice sent`
  output event; the trace still settles `skipped` and no LLM runs. The owner,
  blocked only for missing a group @mention, stays silent (they know the rule).
  `bot-messaging/service.test.ts` updated: non-owner asserts the notice is sent
  (no LLM), owner-in-group asserts no reply. lint ✓, typecheck ✓, unit 72 ✓,
  build ✓. Not browser-verifiable (Telegram message path); covered by unit tests.
- 2026-07-11 (follow-up 8): **Shared `Table` primitive** (user feedback — the
  known-users work added a second bespoke table instead of extracting shared
  chrome first). Added `components/ui/Table` (`Table`/`TableHead`/`TableBody`/
  `TableRow`/`TableHeaderCell`/`TableCell`): scroll container, borders, header
  typography, `header`/`interactive` row variants, align/valign — look only, each
  feature keeps its own row behavior. Refactored **both** consumers onto it:
  `components/debug/TraceList` (interactive rows + stretched link preserved) and
  `features/known-users/ui/KnownUsersTable` (inline alias editors preserved). No
  visual change. Checks: lint ✓, typecheck ✓, unit 72 ✓, build ✓ (0 warnings);
  verified live — `/debug` (23 rows, stretched link intact) and `/users` render
  identically through the shared primitive.
- 2026-07-11 (follow-up 7): **Known users feature + owner-by-dropdown** (user
  request). Adds a first-class list of everyone who has messaged the bot and
  turns owner selection from a free-text @username guess into a concrete pick.
  - **`known_users` table** (migration `0004_heavy_metal_master.sql`): `user_id`
    (PK), `username`, `first_name`, `last_name`, `aliases text[]`, `first_seen_at`,
    `updated_at`. Upserted on **every** incoming human message (bot-manager
    `onMessage`, before addressing, best-effort) so the profile refreshes but
    operator-curated `aliases` are never overwritten by the passive upsert.
  - **Aliases = manual nicknames** (user decision): operator-curated alternate
    names, edited inline on the Users page. `updateAliasesSchema` trims, drops
    blanks, and collapses case-insensitive duplicates; bounds 20 × 60 chars.
  - **Feature module** `features/known-users/*`: `repository.ts`
    (`listKnownUsers`/`getKnownUser`/`upsertKnownUser`/`setKnownUserAliases`),
    `schema.ts` (zod), `service.ts` (`listUsers`/`rememberUser`/`updateAliases` —
    alias edits **traced** as `known-users`/`update-aliases`), pure
    `format.ts` (`formatKnownUserLabel`, client-safe), `ui/KnownUsersTable.tsx`
    (inline alias editor). Routes `GET /api/users`, `PATCH /api/users/[id]`.
    Pages `/users` (table) + `/users/debug` (shared `TraceExplorer`). Nav gained
    a Users item.
  - **Owner is now a dropdown of known users** (replaces free-text @username +
    lazy resolution): settings `updateSettings` takes `ownerUserId`, validates it
    is a known user, and denormalizes `owner_username` for display. `getBotPolicy`
    is now a pure read (`{ ownerUserId, maintenanceModeEnabled }`); `resolveBotPolicy`
    and the lazy-persist path are gone. `policy.isOwner` matches by numeric id
    only. `SettingsForm` owner field is a `<Select>` of known users.
  - **Tests:** known-users `schema.test.ts` (+5: trim/blank/dedupe/bounds),
    `known-users.integration.test.ts` (+5: remember refresh-without-clobbering-aliases,
    list order, alias update trace, unknown-user error); settings integration
    rewritten for owner-by-id (`getBotPolicy`, owner denormalization, unknown-id
    rejection, clear); bot-messaging `policy.test.ts` + `service.test.ts` updated
    to id-based ownership. Unit 72, integration 31.
  - **Verified live** on the dev server: `/users` renders (empty state, then a
    table of two seeded users); editing Alice's aliases to `Boss, Ali, Boss`
    persisted as `["Boss","Ali"]` (trim + dedupe); the Settings owner dropdown
    listed `Alice Anderson (@alice)` / `Bob (@bob)`; selecting Alice + maintenance
    on saved `ownerUserId:"1001"`, `ownerUsername:"alice"` (server-denormalized),
    `maintenanceModeEnabled:true`; no console errors. Reverted settings + deleted
    the seeded users afterward — dev DB restored.
  - Checks: lint ✓, typecheck ✓, unit 72 ✓, integration 31 ✓, build ✓ (0
    warnings), db:migrate ✓.
- 2026-07-11 (follow-up 6): **Maintenance mode + owner checks** (priority-1
  feature-contract items; owner was deferred to this phase because it needs
  @username→id resolution via the bot).
  - **Settings columns** (migration `0003_numerous_may_parker.sql`):
    `owner_username` (normalized: lowercase, no `@`), `owner_user_id` (resolved
    numeric id), `maintenance_mode_enabled` (bool, default false). Schema/
    repository/zod-schema/service extended; client `Settings` now exposes
    `ownerUsername`/`ownerUserId`/`maintenanceModeEnabled` (owner is not a secret).
  - **Owner id resolution** is lazy (Telegram has no username→id lookup):
    `resolveBotPolicy({ fromId, username })` in the settings service reads the row
    and, the first time the configured owner @username messages the bot, persists
    their numeric id (mirrors the MVP's `tryResolveOwnerFromUser`). Changing the
    owner username clears the resolved id so it re-resolves; username-based owner
    matching (case-insensitive) works in the meantime, so there's no gap.
  - **Policy** is a new pure module `features/bot-messaging/server/policy.ts`
    (`isOwner`, `checkMaintenance`) — unit-testable, no DB/network. Recreated MVP
    behavior: maintenance on → only the owner gets replies, and in groups the
    owner must @mention the bot directly (a reply-to-bot or command does not
    pass). The bot-messaging service enforces it right after the addressing check;
    a **blocked-but-addressed** message is still traced (addressing check →
    `maintenance mode — blocked` warn event → trace settled **skipped**) so the
    operator sees who was turned away and why. `IncomingMessage` gained
    `fromUsername`; `BotMessagingDeps` gained `policy`; the bot-manager resolves
    the policy per message and injects it.
  - **UI:** `SettingsForm` gained an owner @username field (with a resolved /
    not-yet-resolved badge) and a maintenance-mode `Switch`; owner is only re-sent
    when changed (avoids needless id-reset churn). Settings page header/card copy
    broadened beyond "LLM connection".
  - **Tests:** `policy.test.ts` (+7: owner id/username matching, maintenance
    on/off, group-mention rule); bot-messaging `service.test.ts` (+3: non-owner
    blocked→skipped trace + no reply, owner allowed by username, owner blocked in
    a group without @mention); settings integration (+4: default shape, username
    normalization + maintenance toggle, owner-change clears resolved id,
    `resolveBotPolicy` lazy-resolve/persist + no-overwrite). Unit 67, integration 26.
  - **Verified live** on the running dev server: saved `@TestOwner` + maintenance
    on → `GET /api/settings` returned `ownerUsername:"testowner"` (normalized),
    `ownerUserId:null`, `maintenanceModeEnabled:true`; the form showed the
    "Not yet resolved — ask @testowner to message the bot" badge. Reverted the
    test values afterward (owner cleared, maintenance off) — dev DB restored.
  - Checks: lint ✓, typecheck ✓, unit 67 ✓, integration 26 ✓, build ✓ (0
    warnings), db:migrate ✓.
- 2026-07-11 (follow-up 5): **Debug fidelity fixes** (user, emphatic).
  - **Full raw bodies:** `chatCompletion` now returns `requestBody` +
    `responseBody` (the raw provider completion). `bot-messaging` records the
    **whole** request body (`{ messages }`) and the **entire raw response
    object** (id/model/usage/choices/finish_reason/…) — previously only the
    extracted `content` was stored. LLM client + service updated; `GeneratedReply`
    gained `responseBody`.
  - **Fixed, consistent event flow** (was ad-hoc): `addressing check` (new
    `success` level → **green dot**) → `llm_request` + body → `llm_response` +
    raw body + model/token stats → `send message` + full content. Added a
    per-event status **dot** (level-coloured) to `TraceTimeline`; added `success`
    to `traceLevelSchema`.
  - **No JSON background:** `react-json-view-lite`'s `darkStyles.container`
    injects an opaque solarized panel (`rgb(0,43,54)`) — overrode the `container`
    style to drop it so the tree sits flat on the card. Verified live: zero
    non-transparent backgrounds in the viewers.
  - **Top block:** removed the (trimmed) **Output** field; **Input** now shows the
    **full untrimmed** message (`inputSummary` no longer sliced).
  - **Tests:** rewrote the bot-messaging body test to assert the fixed flow +
    full untrimmed message + raw response body (57 unit still green). `client.test`
    unaffected (partial asserts).
  - **Verified live** by seeding a realistic trace via a throwaway dev route
    (removed after; seeded row deleted): flow/labels/dots/timings correct, full
    request messages + full raw response body render, green addressing dot
    (`rgb(52,211,153)`), no viewer background, Input full + no Output.
  - Checks: lint ✓, typecheck ✓, unit 57 ✓, integration 22 ✓, build ✓ (0 warnings).
- 2026-07-11 (follow-up 4): **Debug robustness pass** (user requests).
  - **Collapsible JSON viewer:** `JsonBlock` rewritten as a client component on
    **`react-json-view-lite`** (v2.5.0). Note: the user asked for
    `react-json-view`, but that package supports only React ≤17 and is
    unmaintained — incompatible with this project's React 19; `react-json-view-lite`
    is the stable React-19 equivalent (same collapsible-tree UX). Theme-aware via
    a new shared `components/theme/useIsDark` hook (also DRY-refactored out of
    `ThemeToggle`); primitives render as wrapped text so nothing truncates.
    Verified live: tree is collapsible (clickable nodes, lib CSS loaded) and
    text colour switches with the theme (`rgb(237,237,240)` dark →
    `rgb(24,24,27)` light).
  - **Per-step timing:** `TraceTimeline` now shows each step's elapsed time
    (`+Δ` since the previous step, baseline = trace start), so a response shows
    its request's latency (verified: LLM response `+5.7s`, matching usage
    `5741ms`).
  - **Full message/request/response bodies:** `bot-messaging` service now records
    the **whole** incoming message text, the full LLM request body (messages),
    the full response content, and the full delivered reply as event `data`
    (summaries stay short for the list). New service test asserts a 500-char
    message + 300-char reply are recorded untrimmed.
  - **No trace cap:** `listTraces` returns **all** matching traces when no limit
    is given (removed the default-50 and the 200 clamp that also silently capped
    the 500-row bundle); Debug list drops pagination and shows a `N traces`
    count. Integration test seeds 55 and asserts all 55 return. Verified live: 13
    traces shown, count line present, no Prev/Next.
  - **Checks:** lint ✓, typecheck ✓, unit 57 ✓, integration 22 ✓, build ✓ (0
    warnings). Dep added: `react-json-view-lite`. No console errors.
- 2026-07-11 (follow-up 3): **Realtime updates via SSE + Debug UX fixes**
  (user-reported: Debug list didn't live-update; trace rows weren't obviously
  clickable). User decided the project realtime transport: **SSE, not polling
  and not WebSockets** (see Decision Notes — one-way needs, standard Next, no
  custom server).
  - **Shared realtime layer:** `lib/realtime.ts` (event contract; topics
    `traces`/`bot`/`status`), `server/realtime/hub.ts` (in-process pub/sub on a
    `globalThis` singleton, like the bot manager — never throws), `GET
    /api/events` SSE Route Handler (`ReadableStream`, `: ping` heartbeat every
    25s, cleans up on `request.signal` abort; `text/event-stream` +
    `X-Accel-Buffering: no`). Client: `components/realtime/useLiveRefresh` (one
    `EventSource`, debounced `router.refresh()` on matching topic, auto-reconnect)
    + `LiveIndicator` pill (Live/Connecting/Paused, click to pause). The trace
    recorder now `publishEvent("traces")` on create and on each settle, so every
    Debug view refreshes itself. Replaced the initial polling `AutoRefresh`
    (deleted) with this.
  - **Debug UX:** `TraceList` rows are now fully clickable via a stretched link
    (`after:absolute after:inset-0` over a `relative` row) + hover state + a
    trailing chevron — clicking any cell opens the trace.
  - **Checks:** lint ✓, typecheck ✓, unit 56 ✓, integration 22 ✓ (recorder is
    exercised there — re-run to confirm the publish side-effect is harmless),
    build ✓ (0 warnings, `/api/events` route present). Verified live: untouched
    `/debug` self-updated when a new trace was recorded via `POST
    /api/settings/test-connection`; clicking a non-link cell (Duration) navigated
    to the detail; SSE stream stays open (200); no console errors.
- 2026-07-11 (follow-up 2): **Shared Debug UI — trace list/detail + JSON log
  download** (the highest-leverage remaining foundation task; unblocks the
  feature-contract Debug-page/download requirement for `settings` and
  `bot-messaging`).
  - **Server:** `server/trace/repository.ts` gained `listFeatures` (distinct
    feature names for the filter) and `getEventsForTraces` (events for many
    traces in one grouped `inArray` query — no N+1 for bundles). New
    `server/trace/service.ts` is the single Debug boundary: `getTraceList`
    (paged headers + total + feature list), `getTraceDetail` (`not_found`
    ApiError when missing), `buildTraceBundle` (single) and
    `buildTraceListBundle` (filtered, ≤500, events attached) → the shared
    `traceBundleSchema` envelope. `server/trace/schema.ts` holds
    `traceQuerySchema` (coerced `feature/status/limit/offset`), shared by the
    routes and the Server Component pages. `server/http.ts` gained
    `jsonDownload` (pretty JSON + `Content-Disposition: attachment`), shared by
    every feature's export.
  - **API (thin, `defineRoute`):** `GET /api/traces` (list),
    `GET /api/traces/[id]` (detail), `GET /api/traces/[id]/bundle` (single
    download), `GET /api/traces/bundle` (filtered download).
  - **Shared components** `components/debug/*` (barrel): `TraceStatusBadge`
    (status→tone), `JsonBlock` (server, pretty payload viewer), `TraceList`
    (dense table), `TraceTimeline` (ordered events + LLM usage line + JSON),
    `TraceDetail` (metadata/error/related-ids panels + timeline + download),
    `DownloadButton` (plain `<a download>`, no client JS), `DebugFilters`
    (the only Client Component — pushes feature/status to the URL),
    `TraceExplorer` (composes filters + list + download-all + pagination). Also
    added shared `lib/format.ts` (`formatTimestamp`/`formatTime`/`formatDuration`
    — UTC-stable, no hydration drift).
  - **Pages:** global `/debug` (list) + shared `/debug/[id]` (detail, `notFound`
    on unknown id) + feature-scoped `/settings/debug` (reuses `TraceExplorer`
    with `showFeatureFilter={false}`, single shared detail route via
    `detailBasePath`). Settings page header gained a "Debug" link; nav `/debug`
    un-`soon`ed.
  - **Tests:** unit `lib/format.test.ts` (+6) and `server/trace/schema.test.ts`
    (+5) → 56 unit; integration `server/trace/service.integration.test.ts` (+7:
    list paging/feature-list, feature+status filter, detail found/not-found,
    single + filtered bundle) → 22 integration.
  - Checks: lint ✓, typecheck ✓, unit 56 ✓, integration 22 ✓, build ✓ (0
    warnings, routes present). Verified live in-browser (see Current Summary).
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
| Phase 2: Data Model and Persistence | in-progress | Drizzle schema + migrations + trace repository/recorder + `settings`/`personalities`/`known_users`/`chat_messages` tables; unit 89 + integration 47 (Testcontainers); `db:migrate` verified. `chat_messages` (history mirror) is the first append-only log table — identity PK | Add remaining feature tables (memories/tasks/mood) with their features |
| Phase 3: Configuration and Settings | in-progress | Config moved env→DB (user direction). DB-backed LLM-connection settings (`features/settings/*`, typed columns: base URL/API key/model), `openai` provider client (`server/llm/client.ts`), `GET`/`PATCH` `app/api/settings` + `POST /test-connection` (real `/v1/models` probe); key masked + trace-redacted; verified live. Overview/shell/health reworked onto real probes. Plan Phase 3 realigned to this direction | Add model params/prompts with their features; surface traces in shared Debug UI |
| Phase 4: Telegram Bot Interface | in-progress | In-process long-polling bot (grammy) via `instrumentation.ts` + `server/telegram/bot-manager.ts` singleton; DB-backed token; deterministic addressing; **maintenance mode + owner checks** (owner chosen from the `known_users` dropdown, pure `bot-messaging/policy.ts` id-match, blocked messages traced as skipped); known-user capture on every message; Start/Stop API + Overview control; message traces in the shared Debug UI; verified live. lint/typecheck/test/build ✓ | Live run with a real token (operator-supplied) |
| Phase 5: LLM Conversation Core | in-progress | Provider client (`chatCompletion`) + turn assembly: system prompt (base + active personality) → current-day history window (structured prior turns) → current message; usage/latency + full bodies traced. **MCP tool-call loop** landed (`server/llm/tool-loop.ts` — bounded/stall-guarded, appends tool results to the same messages array); tool calls traced as `external_call` on the reply trace | Add memory/mood context blocks (priorities 9/11); v1 tool-call safety is in place |
| Phase 6: Dashboard Shell | in-progress | UI kit + responsive AppShell (sidebar/drawer/topbar); Overview, Settings, and now the shared Debug pages (`/debug`, `/debug/[id]`, `/settings/debug`) built on shared primitives + `components/debug/*`; lint/typecheck/test/build ✓, verified live | Add shared table/filter primitive (Debug uses a bespoke table for now); feature routes as features land |
| Phase 7: Realtime and Status Updates | in-progress | Decision recorded (user): **SSE**, not polling/WebSockets, and a **standing rule that every data-display page live-updates via this layer**. Shared realtime layer: in-process `server/realtime/hub.ts` (globalThis pub/sub), `GET /api/events` SSE Route Handler, client `useLiveRefresh` + `LiveIndicator`. Live topics: `traces` (Debug), `history` (chat mirror), `users` (known users). Verified live | Wire `bot`/`status` topics from the bot manager + status probes onto Overview; reconcile client-state tables to reflect live refreshes |
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
| 1 | Bot messaging: text receive/reply | in-progress | defined (see 2026-07-11 log) | yes (shared `/debug` + `/debug/[id]`, filter by feature) | yes (single + filtered `/api/traces/**/bundle`) | yes (addressing, **maintenance/owner policy**, service, chatCompletion, token masking, trace service/schema) | settings, health, Telegram intake, LLM provider, shared traces | Live run with a real token (operator-supplied) — then priority 2 |
| 2 | System and personality prompts | done | defined (see 2026-07-12 log) | yes (`/personalities/debug` + shared `/debug`; `system prompt composed` step shows the full composed prompt) | yes (shared `/api/traces/**/bundle`) | yes (`prompt.ts` composition, personalities service/schema/integration, bot-messaging service) | settings, LLM provider | Live token run shares feature-1's gate; next → priority 3 (history) |
| 3 | History feature | done | defined (see 2026-07-12 follow-up 4 log) | yes (`/history/debug` edit traces + `history window loaded` step on every reply) | yes (shared `/api/traces/**/bundle`) | yes (`format.ts`, history integration, bot-messaging injection) | bot messaging, shared traces, DB schema | Live token run shares the feature-1/2 gate; next → priority 4 (MCP tools). Note: user-initiated Telegram deletes can't be mirrored (Bot API limitation) |
| 4 | MCP tools basic support | done | defined (see 2026-07-12 follow-up 7/8 logs) | n/a (pure infra, no feature mutations) — tool **calls** appear as `external_call` events on the bot-messaging **reply** traces in `/debug` | yes (shared `/api/traces/**/bundle`) | yes (mcp registry/openai-tools/tool-loop/mcp-tools-service unit, history search/range integration, bot-messaging tool-event flow) | LLM core, shared traces, history | Live LLM tool round-trip shares the token gate; next → priority 5 (search) |
| 5 | Search MCP tool | done | defined (see 2026-07-13 log) | n/a (read-only tool) — calls appear as `external_call` events on the bot-messaging **reply** traces in `/debug` | yes (shared `/api/traces/**/bundle`) | yes (web-search format/search unit, mcp-tools 4-tool service, settings Tavily-key integration) | MCP basic support | Live LLM + Tavily round-trip shares the token gate; next → priority 6 (visit/read link) |
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
| Settings and health | in-progress | DB-backed settings (`features/settings/*`): LLM connection (base URL/key/model), **active personality** (`active_personality_id`, FK → personalities, `getActivePersonalityId`), Telegram token, and **owner (id chosen from known users, denormalized username) + maintenance mode**; `GET`/`PATCH` + `test-connection` real probe; secrets masked + trace-redacted; pure `getBotPolicy` read; unit + integration tests. Config source is the DB, not env (`config-in-db-not-env`); Overview + `/api/health` probe real state. **Tavily API key** (`tavily_api_key`, masked, `getWebSearchApiKey`) added for the web-search tool | Extend settings columns per feature |
| History | done | `features/history/*` + `chat_messages` table (migration `0006`): 1:1 Telegram mirror (full metadata, unique `(chat_id, telegram_message_id)`); passive capture in `bot-manager.onMessage` + reply mirroring; `getConversationWindow` injects the current UTC-day's messages as structured prior turns (group speaker labels via known-users); `edited_message` mirrored + traced; `/history` (chat list), `/history/[chatId]` (mirror, **newest-first**, each row links to its handling trace via correlation id), `/history/debug`; live-updates over SSE (`history` topic); unit + integration tested; verified live | Vision rows layer here (priority 7); MCP history/search tools for deeper-than-today lookups (priority 4+) |
| Personalities | done | `features/personalities/*` + `personalities` table (migration `0005`) + `settings.active_personality_id` (FK on-delete-set-null): CRUD service (create/edit/delete, CI name-uniqueness + max-32 guards), active selection, `getActivePersonalityPrompt` for composition; `/personalities` page (create/edit/delete/set-active) + `/personalities/debug`; `GET/POST /api/personalities`, `PATCH/DELETE /api/personalities/[id]`, `PUT /api/personalities/active`; every mutation traced; unit + integration tested; verified live | Mood (priority 9) extends this table with per-persona mood defaults |
| LLM provider core | in-progress | `server/llm/client.ts` (`openai`): `listModels`/health probe + `chatCompletion` (reply text + normalized usage + latency, empty-response→503), base-URL normalization, `ApiError` mapping; connection sourced from DB settings; unit-tested (incl. mocked completion) + verified live | Add context assembly (history/prompts) with priorities 2–3; tool-call loop at priority 4 |
| Telegram intake foundation | in-progress | In-process long-polling `server/telegram/bot-manager.ts` (grammy) — singleton lifecycle, DB-backed token, autostart via `instrumentation.ts` + Start/Stop API; deterministic `features/bot-messaging/server/addressing.ts` + `policy.ts` (owner/maintenance, unit-tested); remembers every human sender to `known_users`; per-message Debug traces; verified live | Live run with a real token |
| Known users | done | `features/known-users/*` + `known_users` table (migration `0004`): captured on every message (profile refresh, aliases preserved); `/users` page with inline alias editing (dedupe/trim), `/users/debug`; `GET /api/users` + `PATCH /api/users/[id]`; alias edits traced; owner is chosen from this list. Unit + integration tested; verified live | Use aliases for name-based addressing when the group analyzer lands |
| Dashboard overview | in-progress | `app/page.tsx` on real probes (`server/status.ts`: `SELECT 1` + live `/v1/models`); sidebar bot-status on cheap DB readiness; verified live | Add real metrics + Telegram status once those features land |
| MCP tools | done | `server/mcp/*` (real `@modelcontextprotocol/sdk`, in-process: transport/registry/openai-tools/context/runtime singleton) + `server/llm/tool-loop.ts` (bounded/stall-guarded loop); `features/mcp-tools/*` (`getToolsView`/`getToolset` + read-only `/tools` page + `GET /api/tools`); **all registered tools always available (no on/off)**; tools = history `history_search`/`history_get_in_range` (read) + known-users `update_user_aliases` (write — records a nickname for a chat participant the model resolves by name; `features/known-users/match.ts` + `addAliasByReference`); all chat-scoped via `AsyncLocalStorage`; tool calls traced as `external_call` on reply traces (writes also trace under their own feature); unit + integration tested. **Web-search `search_web`** (Tavily, priority 5) added via the same registrar pattern (`features/web-search/*`, key in DB settings) | Add link (priority 6) tool via the same registrar pattern; images in tool results deferred to vision (priority 7) |
| Debug traces and LLM usage | done | `lib/trace.ts` types + `server/trace` recorder/repository/service on Drizzle; shared Debug UI (`/debug`, `/debug/[id]`, `/settings/debug`) renders steps, LLM request/response + token usage, errors, related ids; JSON bundle download; unit + integration tested; verified live | Add trace-context to the Route Handler wrapper so API calls auto-record; surface a trace link from Overview status cards |

## Shared Infrastructure Progress

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Shared Route Handler wrapper | done | `server/http.ts` (`defineRoute`, `ok`, `parseJson`, `parseQuery`, `toApiError`) + tests | Add trace-context integration when recorder lands |
| Shared error shape | done | `lib/api-error.ts` (`ApiError`, code→status map, envelope) + tests | — |
| Shared trace schema | done | `lib/trace.ts` types + `db/schema.ts` tables + `server/trace` repository/recorder, tested | Wire recorder into features as they land |
| Shared log/trace export | done | `jsonDownload` (`server/http.ts`) + `buildTraceBundle`/`buildTraceListBundle` (`server/trace/service.ts`) + `app/api/traces/[id]/bundle` & `app/api/traces/bundle` routes + `DownloadButton`; single + filtered bundle downloads verified live (attachment headers, `trace-bundle@1` envelope) | — |
| Shared dashboard layout | done | `components/layout/AppShell` (responsive rail + mobile drawer), `Sidebar` (config-driven, active state), `Topbar`; theme toggle + tokens | Add breadcrumbs + per-route topbar title as routes grow |
| UI kit tokens/primitives | done | `app/globals.css` semantic tokens (Tailwind v4 `@theme`, `.dark`); `components/ui/*` (Button/Card/Badge/Avatar/Progress/Separator/StatCard/StatusCard/EmptyState/Skeleton/**PageHeader**) + `lib/cn.ts`; barrel is the single entry point (`PageHeader` + `StatusCard` moved into the kit 2026-07-12; no page imports a local primitive; feature UIs like `PersonalitiesManager`/`KnownUsersTable` compose from `Card`/`Field`, no bespoke chrome); **`Tabs`** (accessible tablist/tabpanel, arrow-key nav, controlled-or-uncontrolled) added and first used to split Settings into Core / Integrations; verified live | Extend with Dialog/Toast when features need them |
| Shared form components | done | `components/ui` `Input`, `Textarea`, `Select`, `Label`, `Field` (label+hint+error+aria wiring), `Switch`, `Checkbox`; first consumed by `features/settings/ui/SettingsForm.tsx` | Extract a form-state/submit helper if a 2nd feature form duplicates the fetch/status pattern |
| Shared table/filter components | in-progress | Shared `components/ui/Table` primitives (`Table`/`TableHead`/`TableBody`/`TableRow`/`TableHeaderCell`/`TableCell` — scroll container, borders, header typography, `interactive`/`header` row variants, align/valign). Both `components/debug/TraceList` and `features/known-users/ui/KnownUsersTable` compose from it (no bespoke table markup). Verified live | Add filter/pagination primitives (Debug still uses `DebugFilters`); adopt in new feature tables |
| Shared debug components | done | `components/debug/*` (barrel): `TraceExplorer` (uncapped list + filters + live + export), `TraceList` (clickable rows), `TraceDetail`, `TraceTimeline` (per-step timing), `JsonBlock` (collapsible, theme-aware `react-json-view-lite`), `TraceStatusBadge`, `DownloadButton`, `DebugFilters`; consumed by `/debug`, `/debug/[id]`, `/settings/debug`; verified live (JSON tree, timings, full bodies, theme switch) | Add per-feature Debug pages as thin `TraceExplorer` wrappers (e.g. a bot-messaging section when it gets a dashboard route) |
| Shared realtime (SSE) | in-progress | `lib/realtime.ts` (event contract) + `server/realtime/hub.ts` (in-process pub/sub singleton) + `GET /api/events` SSE stream + `components/realtime/useLiveRefresh` hook + `LiveIndicator` pill. Topics `traces` (Debug), `history` (chat mirror — publishes on record/edit), `users` (known-users — publishes on capture/alias edit) all live; each page drops a `<LiveIndicator topic>` and its service calls `publishEvent`. **Standing rule (user):** every data-display page must live-update via this layer — no manual refresh (memory `live-data-no-manual-refresh`). Verified live: a `users` publish triggered a `/users?_rsc` refetch with the page untouched. Decision: SSE not polling/WS (user) | Publish `bot`/`status` topics from the bot manager + status probes; consume on Overview. Reconcile client-state tables (e.g. `KnownUsersTable` alias input) so live prop changes show |
| Shared status components | done | `components/ui/Badge` (tones+dot), `EmptyState`, `Skeleton`/`Spinner`, refactored `StatusCard`/`PageHeader` onto tokens | Add explicit error panel when debug UI lands |
| Test harness | done | Vitest unit config (57) + Testcontainers integration config (22); `server-only` alias stub; `vi.hoisted`+`vi.mock` pattern for isolating services from persistence (see `bot-messaging/service.test.ts`) | Add Route Handler + dashboard smoke tests per feature |

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
| Owner selection model | done | user | Owner is **chosen from a dropdown of known users** (users who have messaged the bot), storing the numeric id directly. Supersedes the earlier free-text @username + lazy-resolution approach — no username→id resolution needed since the id is known. |
| Known-user aliases | done | user | Aliases are **operator-curated manual nicknames**, edited inline on the Users page (not auto-tracked username history). Intended for future name-based group addressing. |
| History injection model (priority 3) | done | user | **Superseded 2026-07-13 (user):** history is injected as **one `user` message holding an id-anchored transcript** — each line `[#<telegram_message_id>] <sender>: <text>`, replies marked `[reply to #<id>]` (stored target) or with the quoted sender + full untrimmed text inlined (unstored target). The current turn is rendered in the same line format, and groups get a system **addressing hint** (who is asking, how they addressed the bot). Original decision (structured `user`/`assistant` prior turns with group label prefixes) applied until then. Storage keeps **full metadata** (chat id, TG message id, sender id, reply-to, content, timestamps) for a 1:1 mirror. |
| History window scope (priority 3) | done | user | **Superseded 2026-07-13 (user):** the per-reply context window is a **rolling last-24-hours window** (`historyWindowStart`), replacing the original UTC-day boundary (which caused near-empty context just after midnight). Still no message-count or token budget — revisit if a busy group blows the model context. |
| Forum-topic threads (`message_thread_id`) | done | user | **Known limitation, out of scope for now:** threads are not stored, so a forum supergroup's topics interleave into a single history transcript. |
| Telegram edit/delete mirroring (priority 3) | done | agent (constraint surfaced to user) | **Edits** are mirrored via `edited_message` updates. **Deletes cannot be**: the Telegram Bot API delivers no deletion update for ordinary private/group chats (only `deleted_business_messages`, and only for Business connections), so user-initiated deletes are invisible to the bot. `chat_messages.deleted_at` exists to represent deletions we *can* know about (the bot's own deletions, or Business-connection events); it is not populated by ordinary user deletions. |
| Prompt model (priority 2) | done | user | **Full personalities CRUD feature** (corrected from an initial single-field approach). The base system prompt stays a fixed code constant; personas are a `personalities` table with a **dedicated `/personalities` page** (create/edit/delete + **set active**) and `settings.active_personality_id`. The active persona's prompt is composed into every reply. Mood (priority 9) will build on this table. |
| Migration workflow | done | user | `generate` committed SQL files; applied via `drizzle-kit migrate` (`npm run db:migrate`), run by the Docker entrypoint before `next start`. No in-app auto-migration (instrumentation approach rejected as non-standard). |
| DB test strategy | done | user | Real Postgres via Testcontainers (integration suite) |
| MVP data import | done | agent default | Out of scope for v1 (fresh DB) — reconfirm with user if import is needed before cutover |
| Telegram webhook vs polling | done | user | **Long polling, in-process** (started from `instrumentation.ts`), not a webhook and not a separate worker. Rationale: self-hosted single container behind NAT (no inbound HTTPS needed); I/O-bound handlers already run concurrently on the event loop, so a worker/thread buys nothing now. Isolated behind a bot-manager singleton so moving to a dedicated worker later (multi-replica / CPU-bound) is a contained change. |
| Telegram poller lifecycle | done | user | **Autostart on boot** (fails gracefully and surfaces on the dashboard when no token) **+ dashboard Start/Stop** controls. Token lives in DB settings; a token change requires restart (poller binds token at start). |
| Realtime polling vs SSE vs WebSocket | done | user | **SSE via standard Route Handlers** (a single `GET /api/events` stream + client hook), not polling and not WebSockets. Rationale: all current live needs (bot/LLM health, jobs, debug traces) are one-way server→client; SSE is Next-standard, runs under `next start` and the standalone Docker image with no custom server, whereas WebSockets would require a custom Node server / separate service + sticky sessions. In-process hub (`server/realtime/hub.ts`, `globalThis` singleton) fans out to subscribers; matches the single-container model. WebSockets revisited only if a feature needs client→server streaming (e.g. browser-agent control at priority 13). |
| MCP tool transport/registry (priority 4) | done | user | **Real MCP SDK, in-process** (`@modelcontextprotocol/sdk`) — one shared `McpServer` with per-feature registrars, linked to a `Client` over an in-process transport pair, tools converted to OpenAI tool shape. Chosen over a plain in-process tool registry for MVP parity and the ability to connect **external** MCP servers later with the same loop. Verified compatible with the repo's zod 4. |
| MCP v1 scope (priority 4) | done | user | **Infrastructure + the first history tools.** Ship the registry, tool-call loop, per-tool trace recording, safe tool errors, tests, AND expose history as MCP tools now (`history_search`, `history_get_in_range` — deeper-than-today lookups). |
| MCP tool on/off (priority 4) | done | user | **No per-tool on/off — all registered tools are always available** to the model ("we dont need turning on/off for mcp tools"). The earlier `settings.enabled_tool_names` + `/tools` toggles were removed and the migration squashed. The `/tools` page is a read-only registry listing. |
| Web-search provider + key (priority 5) | done | agent (follows `config-in-db-not-env`) | **Tavily**, reusing the MVP provider. The API key is a **masked DB settings column** (`settings.tavily_api_key`), read at call time by `getWebSearchApiKey()` — not an env var. `max_results` is a code constant (5), not a setting. The tool is read-only and always available (no on/off); calls are traced as `external_call` on the reply trace (no dedicated feature trace/Debug page), matching the history read tools. |
| MCP tool trace placement (priority 4) | done | agent | Tool **calls** are traced as `external_call` events on the bot-messaging **reply** trace (full args+result), so they appear in `/debug` — no separate per-call feature trace, and the `mcp-tools` feature (now pure infra, no mutations) has no dedicated Debug page. Tools are bound to the current chat via `AsyncLocalStorage` (the model never passes a chat id → no cross-chat leakage). |
| Read-link fetch engine (priority 6) | done | user | **Playwright (MVP parity)** over a lightweight `fetch`+HTML-extract approach. The `read_page` tool renders one page in **headless Chromium** (`body.innerText`, JS-heavy pages supported). Cost accepted: `playwright` dependency now (`serverExternalPackages` so Next never bundles it) + Chromium in the Docker image (Phase 11). The browser is a persistent **`globalThis` singleton** (MVP parity — "beyond per-job execution", explicitly part of the chosen option; same singleton pattern as the bot manager / MCP registry), reusable by the browser-agent feature (priority 13). |
| Vision model (priority 7) | done | user | **Same configured LLM/model** handles vision (no separate vision-model/endpoint setting) — MVP parity (the MVP uses one model for everything; `auxiliary` only tweaks temperature). The vision-capable model is assumed. No new settings column. |
| Vision media persistence (priority 7) | done | user | **Persist media now, as base64.** On ingestion every media message's normalized JPEG is stored in `message_media` (`data_base64`, `status=pending`). Media **on the answered message** is described immediately and **resaved replacing the base64 with the text description** (`status=described`, bytes dropped) — keeps long-term history token-light. **Other media** (unaddressed/group chatter) stays `pending` for the **backfill job (priority 8)**. `VISION_MAX_DIMENSION=768` is a code constant, not a setting. |
| Vision describe timing (priority 7) | done | user | The answered turn's image is read by the **main reply pass** (immediate recognition, no separate call for the answer), then a **separate describe pass** captions it to text for history and drops the bytes. The MVP deferred ALL captioning to an idle backfill scheduler; here the current turn is captioned immediately so the next turn's transcript carries a description. |
| Image bytes in traces (priority 7) | done | agent | Inline base64 image data URLs are **redacted in trace bodies** (`sanitizeMessagesForTrace` → `data:<mime>;base64,<N bytes>`) — a deliberate exception to the full-raw-bodies rule (memory `debug-show-full-raw-bodies`) for binary blobs: a ~1 MB base64 per image would bloat the trace jsonb and make the Debug JSON unreadable. The actual image is shown on the `/vision` page (better UX than a base64 wall). All readable content (roles, text, structure) is kept verbatim. |
| Background job operating model | done | user | **In-process scheduler started from `instrumentation.ts`**, same lifecycle as the existing bot-manager / MCP registry / Playwright / realtime-hub `globalThis` singletons — chosen over external cron→Route Handler, a separate worker, or on-demand-only. Rationale: single self-hosted container that already runs an in-process poller; a scheduler in the same process needs no new deploy unit, secret, or external cron, and is consistent with the recorded polling decision. Trade-off accepted (this is the required sign-off for an in-process scheduler): won't survive a move to multi-replica without change; isolated behind a shared scheduler primitive so a later move to a worker/cron is contained. DB-backed **locking** via a Postgres advisory lock (`server/jobs/lock.ts`) guards cross-process overlap (e.g. redeploy); **idempotency** is the existing per-row `status='pending'` gating (`describeAndStore` skips non-pending). **Trigger = idle-debounced (MVP parity):** a debounce timer (re)armed on bot activity, aborting the running batch when live traffic resumes so backfill never competes with a live reply. Debounce is a code constant, not a setting (matches `VISION_MAX_DIMENSION`). Establishes the shared model for priorities 8–13 (mood cooldown, scheduled tasks, memory extraction, browser-agent queue). |

## Blockers

No blockers recorded.

## Next Agent Notes

- Read `NEXTJS_REWRITE_PLAN.md` first.
- Confirm v1 scope before implementation.
- Do not copy MVP modules by default.
- Keep shared patterns ahead of feature-specific code.

### Fix: model claimed a tool action it did not take (2026-07-13)

- **Symptom:** in a private chat the bot replied "Записав" (recorded) to a user
  giving nicknames without ever calling `update_user_aliases`
  (trace `890953a2…`: no `external_call` event; reasoning declined the tool
  because it had no name to reference the DM sender by). The `search_web` path was
  fine — trace `16f7d441…` shows a real tool call + grounded answer.
- **Root causes:** (1) private chats injected no sender identity, so the
  identity-scoped `update_user_aliases` tool had no reference name and was
  effectively uncallable; (2) nothing in the base prompt forbade claiming an
  un-taken tool action.
- **Fix:** (1) `bot-messaging/prompt.ts` base prompt gained a **Tools and honesty**
  section (never claim you searched/looked up/saved/recorded unless you actually
  called that tool this turn and it succeeded; don't fabricate results). (2) DM
  identity injection: new pure `formatUserContext` + `getUserContext`
  (known-users), wired through the generalized `loadChatContext` dep (see
  known-groups injection note above) so private replies get a `[systemBase,
  userIdentity, …]` shape naming who the bot is talking to and giving a concrete
  reference name for the alias tool.
- **Proof:** `npm run lint` clean, `npm run typecheck` clean, `npm run test`
  **140 unit** pass (bot-messaging `service.test.ts` updated to `loadChatContext`
  /`chat context loaded` + a data-omitted case; new known-users `format.test.ts`
  covering `formatUserContext`/`formatKnownUserLabel`). Not yet verified live
  against a real Telegram DM.

### Current state (2026-07-12)

- Phase 1 done; Phases 2/3/4/5/6/11 in-progress and verified: `npm run lint`,
  `npm run typecheck`, `npm run test` (89 unit), `npm run test:integration`
  (47, Testcontainers), `npm run build` (0 warnings) all pass. Priority-1 bot
  messaging (text receive/reply), priority-2 (system & personality prompts — a
  full personalities CRUD feature), and priority-3 (**history** — a 1:1
  conversation mirror + current-day context injection) are built and verified
  live in-browser; the shared Debug UI (list/detail/download) is built and
  verified live too.
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
- **Finish priority 1** — the vertical slice works; the **shared Debug UI +
  trace download** (`/debug`, `/debug/[id]`, `/settings/debug`;
  `app/api/traces/**`; `components/debug/*`), **maintenance mode + owner
  checks** (`features/bot-messaging/server/policy.ts`, id-based), and the
  **known-users feature** (owner is chosen from `/users`) are now done. The
  **only** remaining item for feature-1 `done` is an **end-to-end run with a real
  bot token** (operator-supplied — do not create Telegram credentials). Then move
  to priority 2 (system/personality prompts), which will replace the minimal
  default system prompt in `features/bot-messaging/server/service.ts`.
- **Owner is chosen by id from `known_users`** (dropdown). `getBotPolicy` is a
  pure read; there is no lazy @username resolution — do not reintroduce it. New
  users are captured in `bot-manager.onMessage` before addressing.
- **The Debug UI is the shared surface for every future feature.** New features
  get their Debug page for near-free: render `<TraceExplorer>` (from
  `components/debug`) with a `feature`-scoped `getTraceList` and
  `showFeatureFilter={false}` (see `app/settings/debug/page.tsx`). Row detail
  links reuse the single `/debug/[id]` route. Don't build a bespoke debug UI.
- **Priority 2 (system & personality prompts) is done** (2026-07-12): base
  prompt is the code constant `BASE_SYSTEM_PROMPT` in
  `features/bot-messaging/server/prompt.ts`. Personas are a **full CRUD feature**
  (`features/personalities/*`, `/personalities` page, `personalities` table +
  `settings.active_personality_id` FK). The **active** persona's prompt is
  composed by `buildSystemPrompt` and injected via `getActivePersonalityPrompt()`
  in `bot-manager.onMessage`; the composed prompt is traced (`system prompt
  composed` step). Do not reintroduce `DEFAULT_SYSTEM_PROMPT` or a single
  `personality_prompt` settings field (that approach was tried and reverted —
  personalities must stay a CRUD feature with active selection).
- **Priority 3 (History) is done** (2026-07-12 follow-up 4). It's a 1:1
  conversation mirror (`chat_messages`, migration `0006`) + current-day context
  injection. Key facts for future work:
  - Passive capture happens in `bot-manager.onMessage` (every human message,
    even un-addressed) via `recordIncomingMessage`; the delivered reply is
    mirrored via the bot-messaging `recordReply` dep. Do not move capture into
    the addressed-only path — the window needs un-addressed group chatter.
  - The window is injected as **structured prior turns** by
    `getConversationWindow` (today's UTC-day messages), placed between the
    system prompt and the current turn — keep the system prompt cache-stable, do
    not fold history into it. Vision/media rows will layer onto `chat_messages`
    at priority 7; the MCP history/search tools (deeper-than-today lookups) layer
    at priority 4+.
  - **Do not build a Telegram delete handler for ordinary chats** — the Bot API
    delivers no deletion update there (see Decision Notes). `deleted_at` is for
    deletions we can actually observe (bot's own / Business connections).
- **Priority 4 (MCP tools basic support) is done** (2026-07-12 follow-up 7).
  Tools use the **real MCP SDK, in-process** (user decision). Key facts for future
  tool work (priorities 5, 6, 12):
  - A new tool-owning feature adds a `server/mcp-tools.ts` with a
    `registerXMcpTools(server)` registrar + exported tool-name list, then registers
    it in `server/mcp/runtime.ts` `build()`. Handlers read the current chat via
    `getToolContext()` and their own persistence (`getDb()`); they must NOT accept
    a caller-supplied chat/entity id.
  - `registerTool` inputSchema is a **ZodRawShape** (`{ q: z.string() }`), not
    `z.object(...)`. Tools return `{ content:[{type:"text",text}], structuredContent }`.
  - **All registered tools are always available — there is no on/off** (user
    decision, follow-up 8). The runtime resolves the toolset with `getToolset()`
    and the loop lives in `server/llm/tool-loop.ts`; a new tool just needs a
    registrar wired into `server/mcp/runtime.ts`. Tool calls are traced as
    `external_call` events on the **reply** trace (do not add a separate per-call
    trace). The `/tools` page is a read-only registry listing.
  - The MVP's history/image/link/search/memory/tasks tools + `tool-loop.ts` remain
    the behavior reference under `../ollama-tg-bot`.
- **Priority 5 (Search MCP tool) is done** (2026-07-13). Tavily-backed
  `search_web` in `features/web-search/*`, registered in `server/mcp/runtime.ts`.
  The API key is a **masked DB settings column** (`settings.tavily_api_key`), read
  at call time by `getWebSearchApiKey()` — the handler reads config fresh each call
  (like the history tools call `getDb()`), so no host context / registrar arg was
  needed. `runWebSearch` never throws — it always returns a model-ready success or
  failure context. When the key is unset the tool returns an `isError`
  "unavailable" message. Do not add a per-tool on/off or a dedicated Debug page —
  read-tool calls surface as `external_call` on the reply trace.
- **Next best task: priority 6 — Visit/read link MCP tool.** Register a
  link-fetch MCP tool (fetch a URL, extract readable text) through the same
  registrar pattern (a `features/link-fetch` module added to
  `server/mcp/runtime.ts`). **SSRF protection is the core requirement** — block
  private/loopback/link-local IPs and non-http(s) schemes, cap redirects and body
  size, time out. Ground behavior in `../ollama-tg-bot`
  `server/src/features/link-fetch/*` (and `web-browse/*` if relevant). Confirm the
  fetch/read/SSRF policy scope with the user before building. The remaining
  feature-1..5 gate is an operator-run live test with a real bot token + Tavily key
  (do not create credentials).
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
