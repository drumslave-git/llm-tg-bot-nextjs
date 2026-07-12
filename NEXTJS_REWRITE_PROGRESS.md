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
Owner: agent/2026-07-12
Last updated: 2026-07-12
Proof: `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (81 unit), `npm run test:integration` ✓ (40, real Postgres via Testcontainers), `npm run build` ✓ (0 warnings). **Priority 2 — system & personality prompts (done):** the base system prompt is a fixed code constant (`BASE_SYSTEM_PROMPT` in `features/bot-messaging/server/prompt.ts`); the operator manages personas as a **full personalities CRUD feature** (user decision — corrected from an initial single-field approach). A `personalities` table (migration `0005`: id/name/prompt/timestamps) + `settings.active_personality_id` (FK, `on delete set null`). New `features/personalities/*` (repository/schema/service/ui) with a **`/personalities` page** (create/edit/delete + set-active) and **`/personalities/debug`**; routes `GET/POST /api/personalities`, `PATCH/DELETE /api/personalities/[id]`, `PUT /api/personalities/active`; every mutation traced. Composition (`buildSystemPrompt`/`hasPersonality`, pure) is unchanged: base alone, or base + `---\nAdditional instructions:\n<persona>`; the bot-messaging service records a **`system prompt composed`** step (`personalityApplied` + full composed prompt) between `addressing check` and `request`; the runtime injects the **active** personality's prompt via `getActivePersonalityPrompt()`. Verified live: created a persona on `/personalities`, set it active (Active badge + `activeId` via API), deleted it (list emptied and active auto-cleared via the FK), all four mutations traced `success` on `/personalities/debug`; no console errors. **Known users + owner-by-dropdown**: a `known_users` table (migration `0004`) capturing everyone who messages the bot, a `/users` page with inline alias editing, and the owner is now chosen from a **dropdown of known users** (id stored directly — the earlier lazy @username→id resolution is removed). **Maintenance mode + owner checks** built and verified live (a pure `bot-messaging/policy.ts`; blocked-but-addressed messages traced as skipped). The **shared Debug UI** is now built and verified live — the last feature-contract gap for both `settings` and priority-1 `bot-messaging`. A global `/debug` page (filter by feature/status, pagination, "Download all") plus a shared `/debug/[id]` detail view (metadata panel, error panel, ordered event timeline with LLM usage, per-trace JSON download) and a feature-scoped `/settings/debug`. Backed by `server/trace/service.ts` (list/detail/bundle) over the existing recorder/repository, thin `app/api/traces/**` handlers, and reusable `components/debug/*`. Verified live against the running dev server on real recorded traces: list renders 11 traces; a bot reply detail shows LLM usage (`prompt 38 · completion 184 · total 222 · 5741ms`); an error trace shows the error panel + timeline; `/settings/debug` shows only settings traces; single + filtered bundle downloads return the `llm-tg-bot/trace-bundle@1` envelope with attachment headers; no console errors.
Realtime: the dashboard now updates **live over SSE** (user decision — not polling/WebSockets). Shared layer: in-process `server/realtime/hub.ts` pub/sub, `GET /api/events` SSE stream, `useLiveRefresh`/`LiveIndicator` client; the trace recorder publishes on create/settle. Verified live: with the page untouched, a newly recorded `test-connection` trace appeared at the top of `/debug` on its own; the `/api/events` stream stays open (200); no console errors. Debug rows are now fully clickable (stretched link) — clicking any cell opens the trace.
Next: **Priority 3 — History feature** (store/retrieve/inject conversation history). Feature 1's only open item is an operator-run live test with a real bot token; feature 2 (prompts) is now done pending the same shared live run.

### Session log

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
| Phase 2: Data Model and Persistence | in-progress | Drizzle schema + migrations + trace repository/recorder + `settings` table; unit 27 + integration 11 (Testcontainers); `db:migrate` verified | Add feature tables (chats/messages) with their features |
| Phase 3: Configuration and Settings | in-progress | Config moved env→DB (user direction). DB-backed LLM-connection settings (`features/settings/*`, typed columns: base URL/API key/model), `openai` provider client (`server/llm/client.ts`), `GET`/`PATCH` `app/api/settings` + `POST /test-connection` (real `/v1/models` probe); key masked + trace-redacted; verified live. Overview/shell/health reworked onto real probes. Plan Phase 3 realigned to this direction | Add model params/prompts with their features; surface traces in shared Debug UI |
| Phase 4: Telegram Bot Interface | in-progress | In-process long-polling bot (grammy) via `instrumentation.ts` + `server/telegram/bot-manager.ts` singleton; DB-backed token; deterministic addressing; **maintenance mode + owner checks** (owner chosen from the `known_users` dropdown, pure `bot-messaging/policy.ts` id-match, blocked messages traced as skipped); known-user capture on every message; Start/Stop API + Overview control; message traces in the shared Debug UI; verified live. lint/typecheck/test/build ✓ | Live run with a real token (operator-supplied) |
| Phase 5: LLM Conversation Core | todo | none | Design provider and conversation service |
| Phase 6: Dashboard Shell | in-progress | UI kit + responsive AppShell (sidebar/drawer/topbar); Overview, Settings, and now the shared Debug pages (`/debug`, `/debug/[id]`, `/settings/debug`) built on shared primitives + `components/debug/*`; lint/typecheck/test/build ✓, verified live | Add shared table/filter primitive (Debug uses a bespoke table for now); feature routes as features land |
| Phase 7: Realtime and Status Updates | in-progress | Decision recorded (user): **SSE**, not polling/WebSockets. Shared realtime layer built: in-process `server/realtime/hub.ts` (globalThis pub/sub), `GET /api/events` SSE Route Handler (heartbeat + abort cleanup), client `useLiveRefresh` hook + `LiveIndicator`; trace recorder publishes on create/settle → Debug list live-updates. lint/typecheck/test/build pending re-run | Wire bot/LLM health + job state onto the hub as those surfaces need live updates |
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
| Settings and health | in-progress | DB-backed settings (`features/settings/*`): LLM connection (base URL/key/model), **active personality** (`active_personality_id`, FK → personalities, `getActivePersonalityId`), Telegram token, and **owner (id chosen from known users, denormalized username) + maintenance mode**; `GET`/`PATCH` + `test-connection` real probe; secrets masked + trace-redacted; pure `getBotPolicy` read; unit + integration tests. Config source is the DB, not env (`config-in-db-not-env`); Overview + `/api/health` probe real state | Extend settings columns per feature (history next) |
| Personalities | done | `features/personalities/*` + `personalities` table (migration `0005`) + `settings.active_personality_id` (FK on-delete-set-null): CRUD service (create/edit/delete, CI name-uniqueness + max-32 guards), active selection, `getActivePersonalityPrompt` for composition; `/personalities` page (create/edit/delete/set-active) + `/personalities/debug`; `GET/POST /api/personalities`, `PATCH/DELETE /api/personalities/[id]`, `PUT /api/personalities/active`; every mutation traced; unit + integration tested; verified live | Mood (priority 9) extends this table with per-persona mood defaults |
| LLM provider core | in-progress | `server/llm/client.ts` (`openai`): `listModels`/health probe + `chatCompletion` (reply text + normalized usage + latency, empty-response→503), base-URL normalization, `ApiError` mapping; connection sourced from DB settings; unit-tested (incl. mocked completion) + verified live | Add context assembly (history/prompts) with priorities 2–3; tool-call loop at priority 4 |
| Telegram intake foundation | in-progress | In-process long-polling `server/telegram/bot-manager.ts` (grammy) — singleton lifecycle, DB-backed token, autostart via `instrumentation.ts` + Start/Stop API; deterministic `features/bot-messaging/server/addressing.ts` + `policy.ts` (owner/maintenance, unit-tested); remembers every human sender to `known_users`; per-message Debug traces; verified live | Live run with a real token |
| Known users | done | `features/known-users/*` + `known_users` table (migration `0004`): captured on every message (profile refresh, aliases preserved); `/users` page with inline alias editing (dedupe/trim), `/users/debug`; `GET /api/users` + `PATCH /api/users/[id]`; alias edits traced; owner is chosen from this list. Unit + integration tested; verified live | Use aliases for name-based addressing when the group analyzer lands |
| Dashboard overview | in-progress | `app/page.tsx` on real probes (`server/status.ts`: `SELECT 1` + live `/v1/models`); sidebar bot-status on cheap DB readiness; verified live | Add real metrics + Telegram status once those features land |
| Debug traces and LLM usage | done | `lib/trace.ts` types + `server/trace` recorder/repository/service on Drizzle; shared Debug UI (`/debug`, `/debug/[id]`, `/settings/debug`) renders steps, LLM request/response + token usage, errors, related ids; JSON bundle download; unit + integration tested; verified live | Add trace-context to the Route Handler wrapper so API calls auto-record; surface a trace link from Overview status cards |

## Shared Infrastructure Progress

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Shared Route Handler wrapper | done | `server/http.ts` (`defineRoute`, `ok`, `parseJson`, `parseQuery`, `toApiError`) + tests | Add trace-context integration when recorder lands |
| Shared error shape | done | `lib/api-error.ts` (`ApiError`, code→status map, envelope) + tests | — |
| Shared trace schema | done | `lib/trace.ts` types + `db/schema.ts` tables + `server/trace` repository/recorder, tested | Wire recorder into features as they land |
| Shared log/trace export | done | `jsonDownload` (`server/http.ts`) + `buildTraceBundle`/`buildTraceListBundle` (`server/trace/service.ts`) + `app/api/traces/[id]/bundle` & `app/api/traces/bundle` routes + `DownloadButton`; single + filtered bundle downloads verified live (attachment headers, `trace-bundle@1` envelope) | — |
| Shared dashboard layout | done | `components/layout/AppShell` (responsive rail + mobile drawer), `Sidebar` (config-driven, active state), `Topbar`; theme toggle + tokens | Add breadcrumbs + per-route topbar title as routes grow |
| UI kit tokens/primitives | done | `app/globals.css` semantic tokens (Tailwind v4 `@theme`, `.dark`); `components/ui/*` (Button/Card/Badge/Avatar/Progress/Separator/StatCard/EmptyState/Skeleton/**PageHeader**) + `lib/cn.ts`; barrel is the single entry point (`PageHeader` moved into the kit 2026-07-12; feature UIs like `PersonalitiesManager` compose from `Card`/`Field`, no bespoke chrome); verified live | Extend with Tabs/Dialog/Toast when features need them |
| Shared form components | done | `components/ui` `Input`, `Textarea`, `Select`, `Label`, `Field` (label+hint+error+aria wiring), `Switch`, `Checkbox`; first consumed by `features/settings/ui/SettingsForm.tsx` | Extract a form-state/submit helper if a 2nd feature form duplicates the fetch/status pattern |
| Shared table/filter components | in-progress | Shared `components/ui/Table` primitives (`Table`/`TableHead`/`TableBody`/`TableRow`/`TableHeaderCell`/`TableCell` — scroll container, borders, header typography, `interactive`/`header` row variants, align/valign). Both `components/debug/TraceList` and `features/known-users/ui/KnownUsersTable` compose from it (no bespoke table markup). Verified live | Add filter/pagination primitives (Debug still uses `DebugFilters`); adopt in new feature tables |
| Shared debug components | done | `components/debug/*` (barrel): `TraceExplorer` (uncapped list + filters + live + export), `TraceList` (clickable rows), `TraceDetail`, `TraceTimeline` (per-step timing), `JsonBlock` (collapsible, theme-aware `react-json-view-lite`), `TraceStatusBadge`, `DownloadButton`, `DebugFilters`; consumed by `/debug`, `/debug/[id]`, `/settings/debug`; verified live (JSON tree, timings, full bodies, theme switch) | Add per-feature Debug pages as thin `TraceExplorer` wrappers (e.g. a bot-messaging section when it gets a dashboard route) |
| Shared realtime (SSE) | in-progress | `lib/realtime.ts` (event contract) + `server/realtime/hub.ts` (in-process pub/sub singleton) + `GET /api/events` SSE stream + `components/realtime/useLiveRefresh` hook + `LiveIndicator` pill; trace recorder publishes `traces` events → Debug list refreshes live. Decision: SSE not polling/WS (user) | Publish `bot`/`status` topics from the bot manager + status probes; consume on Overview |
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
| Prompt model (priority 2) | done | user | **Full personalities CRUD feature** (corrected from an initial single-field approach). The base system prompt stays a fixed code constant; personas are a `personalities` table with a **dedicated `/personalities` page** (create/edit/delete + **set active**) and `settings.active_personality_id`. The active persona's prompt is composed into every reply. Mood (priority 9) will build on this table. |
| Migration workflow | done | user | `generate` committed SQL files; applied via `drizzle-kit migrate` (`npm run db:migrate`), run by the Docker entrypoint before `next start`. No in-app auto-migration (instrumentation approach rejected as non-standard). |
| DB test strategy | done | user | Real Postgres via Testcontainers (integration suite) |
| MVP data import | done | agent default | Out of scope for v1 (fresh DB) — reconfirm with user if import is needed before cutover |
| Telegram webhook vs polling | done | user | **Long polling, in-process** (started from `instrumentation.ts`), not a webhook and not a separate worker. Rationale: self-hosted single container behind NAT (no inbound HTTPS needed); I/O-bound handlers already run concurrently on the event loop, so a worker/thread buys nothing now. Isolated behind a bot-manager singleton so moving to a dedicated worker later (multi-replica / CPU-bound) is a contained change. |
| Telegram poller lifecycle | done | user | **Autostart on boot** (fails gracefully and surfaces on the dashboard when no token) **+ dashboard Start/Stop** controls. Token lives in DB settings; a token change requires restart (poller binds token at start). |
| Realtime polling vs SSE vs WebSocket | done | user | **SSE via standard Route Handlers** (a single `GET /api/events` stream + client hook), not polling and not WebSockets. Rationale: all current live needs (bot/LLM health, jobs, debug traces) are one-way server→client; SSE is Next-standard, runs under `next start` and the standalone Docker image with no custom server, whereas WebSockets would require a custom Node server / separate service + sticky sessions. In-process hub (`server/realtime/hub.ts`, `globalThis` singleton) fans out to subscribers; matches the single-container model. WebSockets revisited only if a feature needs client→server streaming (e.g. browser-agent control at priority 13). |
| Background job operating model | todo | — | undecided |

## Blockers

No blockers recorded.

## Next Agent Notes

- Read `NEXTJS_REWRITE_PLAN.md` first.
- Confirm v1 scope before implementation.
- Do not copy MVP modules by default.
- Keep shared patterns ahead of feature-specific code.

### Current state (2026-07-12)

- Phase 1 done; Phases 2/3/4/6/11 in-progress and verified: `npm run lint`,
  `npm run typecheck`, `npm run test` (81 unit), `npm run test:integration`
  (40, Testcontainers), `npm run build` (0 warnings) all pass. Priority-1 bot
  messaging (text receive/reply) and priority-2 (system & personality prompts —
  a full personalities CRUD feature with active selection) are built and verified
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
- **Next best task: priority 3 — History feature.** Store, retrieve, and inject
  conversation history into replies. This is the first feature to add per-message
  persistence (chats/messages tables) — design the schema (see Phase 2's entity
  list and `../ollama-tg-bot` `features/history/*` for behavior), a service to
  append/retrieve, and the injection point in `buildSystemPrompt`/the message
  assembly in `features/bot-messaging/server/service.ts` (history rides the user
  turn in the MVP, not the system prompt — keep the system prompt cache-stable).
  Trace history retrieval; add its Debug view via a `TraceExplorer` wrapper.
  The remaining feature-1/feature-2 gate is an operator-run live test with a real
  bot token (do not create Telegram credentials).
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
