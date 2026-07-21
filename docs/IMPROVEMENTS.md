# Improvements

A full feature-by-feature code review of the application (v1.8.1, 2026-07-18).
Each item states the problem, where it lives, and a suggested direction. Nothing
here is a decision — items marked **needs decision** touch areas the project
rules reserve for the user (new infrastructure, new dependencies, behavior
changes).

Legend: **[H]** high value · **[M]** medium · **[L]** low / polish.
Categories: security, correctness, performance, scalability, refactoring, DX/UX.

Status (see the session log in `NEXTJS_REWRITE_PROGRESS.md` for proof):

- 2026-07-18, pass 1 — the no-decision quick wins ✅: 1.4, 1.8, 2.1, 2.3, 3.1,
  3.3, 4.2, 8.1, 9.1(2), 9.2's `getHourMessages` half.
- 2026-07-18, pass 2 ✅: 1.2 (SSRF DNS + redirect checks), 1.5's windowing
  (retention still open — it deletes data, so it needs a decision), 1.6 (the
  daily-scheduler factory).
- 2026-07-19, pass 3 ✅: 1.7 (`withTrace`), 4.3 (reply splitting), 5.1 (trgm
  index, migration 0030), and the small fixes 2.2, 2.4, 3.4, 4.6, 6.2, 7.2.

- 2026-07-20, pass 4 ✅: 2.5 (CHECK constraints, migration 0031), 2.6 (trace
  SSE throttling), 4.5 (`buildDeps` options object), 10.1 (SettingsForm split),
  11.3 (backup + trace-dir privacy docs).

- 2026-07-20, pass 5 ✅: 3.2 (a round's tool calls run concurrently, capped)
  and 9.2's remaining due-scan half (the insight scan floor). Also a status
  correction: 9.1(1) — range-aware `scanTraces` — had in fact already landed
  with 1.5's windowing in pass 2; the 9.1 header was stale.

- 2026-07-20, pass 6 ✅ — **the held decisions were put to the user (all seven
  recorded in Decision Notes) and implemented**: 1.1 auth (DB password +
  session), 1.3 concurrency (`@grammyjs/runner`), 1.9 notices (English,
  system-labeled), 4.4 markdown → Telegram HTML, 7.1 one-shot
  retry-then-disable, and 1.5/11.1's retention question (decided as **manual
  prune only** — a Debug-page action, nothing automatic). 4.1's name-shaped
  pre-filter shipped too but was **reverted the same day by the user** (it
  weakened detection); the analyzer runs on every undecided group message
  again.

- 2026-07-21, pass 7 ✅: 12.1(1) concurrency coverage — two updates in flight
  through the pipeline (cross-chat overlap, same-chat ordering, same-chat
  out-of-order completion) and advisory-lock contention from two separate
  pools.

Still open: 4.1's cost concern (the pre-filter was reverted; the unchosen
verdict-cache / per-group-flag mitigations need a new decision if analyzer
volume ever bites), the 6.1 bytea-media migration (a session of its own), and
the deferred-by-design bits: 5.2 and 10.2 (extract on second use / when a consumer
appears), 9.1(3) and 9.3 (when data volume demands), 10.3 Debug paging, 11.2
Dockerfile lockfile, and §12.1(2) trace-store scale (partly covered by the
multi-month corpus tests). Deliberate omission: no change-password flow —
resetting means clearing the DB column (README).

---

## 1. Cross-cutting

### 1.1 ✅ [H] security — No authentication on the dashboard or API (done 2026-07-20: DB password + signed session cookie; proxy optimistic redirect + real checks in the dashboard layout and `defineRoute`)

There is no `middleware.ts`, no auth check in any Route Handler, and no session
concept. Every endpoint is open to whoever can reach the port: reading the full
chat history (`GET /api/history/export`), rewriting settings and secrets
(`PATCH /api/settings`), starting/stopping the bot, editing memory, downloading
trace bundles containing full conversation bodies.

Today this is defensible for a LAN-only self-host, but `docker-compose.yml`
publishes the port and the plan mentions Traefik, so exposure is one config away.

Suggestion (**needs decision** on the mechanism): a single shared operator
credential is enough for a one-operator app — e.g. an `OPERATOR_TOKEN`
bootstrap env var (or a DB-backed password set on first run) checked in
`middleware.ts` with a cookie session, plus the same check inside `defineRoute`
so API calls are covered even if middleware is bypassed. At minimum, document
loudly in the README that the dashboard must not be exposed unauthenticated.

### 1.2 ✅ [H] security — SSRF guard does not cover DNS resolution (done 2026-07-18)

[url-safety.ts](features/link-fetch/url-safety.ts) blocks bad schemes,
credentials, localhost names, and *literal* private IPs, and its own comment
says "a DNS-rebinding defense (re-checking the resolved address) belongs at the
fetch layer" — but the fetch layer
([playwright.ts](features/link-fetch/server/playwright.ts)) never does that
check. A model-supplied URL whose hostname resolves to `192.168.x.x` /
`10.x.x.x` / `169.254.169.254` sails through, and headless Chromium will happily
fetch internal services. Redirects to private addresses are likewise unchecked.

Suggestion: before navigation, resolve the hostname (`dns.lookup` with
`all: true`) and reject if any resulted address is private/loopback/link-local;
also intercept navigation redirects in Playwright (`page.on("response")` or a
route handler) and abort when a hop lands on a private address. The pure
`isPrivateIp` helper already exists — export it and reuse it at the fetch layer.

### 1.3 ✅ [H] performance — Updates are processed strictly sequentially (done 2026-07-20: `@grammyjs/runner` + per-chat `sequentialize`)

`bot.start()` in [bot-manager.ts](server/telegram/bot-manager.ts:246) uses
grammy's built-in polling, which awaits each update's handler before fetching
the next. One reply can legitimately take minutes (120 s completion timeout ×
several tool rounds × a 300 s image generation), and during that time **every
other chat is frozen** — no replies, no reactions, no feedback menus, and the
addressing-analyzer backlog piles onto the same queue.

Suggestion (**needs decision** — new dependency / concurrency model):
`@grammyjs/runner` gives per-chat sequential, cross-chat concurrent processing,
which is exactly the right semantics here (order preserved within a chat, chats
independent). The pipeline is already transport-agnostic and DB-backed, so it
should tolerate concurrency; the things to audit are the tool context
(`AsyncLocalStorage` — safe) and the typing loop.

### 1.4 ✅ [H] performance — The settings row is re-read on every use (done 2026-07-18)

[repository.ts](features/settings/server/repository.ts) `getSettingsRecord` has
23 call sites and no caching. Handling one message reads the singleton settings
row roughly 5–8 times (`getBotPolicy`, `getActivePersonalityPrompt`,
`getTimezone`, language lookup, `getLlmRuntime`, `getToolset`'s key reads,
vision's `resolveToken`…), and every scheduler tick re-reads it once a minute
per job.

Suggestion: a tiny TTL cache (1–5 s) inside `getSettingsRecord`, invalidated by
`upsertSettings` — one function, no call-site changes, and "read at call time so
changes take effect without restart" still holds. Alternatively resolve settings
once per update in `processUpdate` and pass them down (larger refactor, better
purity).

### 1.5 ✅ [H] scalability — Trace store loads all history into RAM and keeps it (windowing/eviction/sort/spread done 2026-07-18; retention decided 2026-07-20: **manual prune only**, a Debug-page action — no automatic deletion)

[store.ts](server/trace/store.ts) `ensureAllLoaded` reads **every** monthly
NDJSON file into memory the first time any Debug/analytics read happens, and the
`months` cache is never evicted. Traces carry complete LLM request bodies
(including the full 24-hour transcript per reply), so months of operation means
hundreds of MB pinned in the Node heap, plus a re-parse of everything on each
boot's first read.

Related issues in the same file:

- `scanTraces` takes a `startUtc`/`endUtc` range but still calls
  `ensureAllLoaded`. File names are `traces-YYYY-MM.ndjson`, so the range maps
  directly to the month keys — load only intersecting months.
- `flushedTraces()` does `out.push(...list)`; a spread of a very large array
  can throw `RangeError: Maximum call stack size exceeded`. Use a plain loop.
- `listTraces` re-sorts the full array on every call (every Debug poll and SSE
  refresh). Months are already chronological on disk; keep them sorted and
  merge, or cache the sorted view until the store changes.
- There is **no retention policy**: the files and the cache grow forever.

Suggestion: month-windowed loading with LRU eviction of old months (headers can
stay, events dropped), range-aware `scanTraces`, and a retention/pruning setting
(e.g. "keep N months of traces", enforced at flush time). The store is behind a
clean API, so all of this is internal.

### 1.6 ✅ [M] refactoring — Four copies of the daily-scheduler boilerplate (done 2026-07-18)

[summary-scheduler.ts](features/history/server/summary-scheduler.ts),
[memory/scheduler.ts](features/memory/server/scheduler.ts),
[self-improvement/scheduler.ts](features/self-improvement/server/scheduler.ts),
and [analytics/scheduler.ts](features/analytics/server/scheduler.ts) each repeat
the same ~120 lines: a `globalThis` store with `lastDailyRunAt` / `forceNext` /
`lastResult`, a `runTick` that reads timezone + `dailyJobsRunTime`, calls
`isDailyRunDue`, computes "waiting (next run …)", and a `getXJobInfo` that
recomputes the same due/next math. Per the project's own rule ("by the third
use, make it shared"), this is overdue at four.

Suggestion: a `createDailyScheduler({ name, feature, runJob })` factory in
`server/jobs/` that owns the store, the tick, `runNow`, and a generic
`getJobInfo` (next-run instant, last result); each feature keeps only its
`runJob` body and its extra info fields (backlog counts, config flags).

### 1.7 ✅ [M] refactoring — Repeated trace-wrapping boilerplate in services (done 2026-07-19; mechanical sites converted, job runners keep bespoke fail-without-rethrow handling)

Nearly every traced mutation repeats the same shape (`startTrace` → `try` →
`trace.event(input)` → work → `trace.succeed` → `catch` → `trace.fail` →
`rethrow`): settings, personalities (×4), history edit, memory edits, scheduled
tasks, etc.

Suggestion: a helper in `server/trace`:

```ts
withTrace({ feature, action, trigger, inputSummary }, async (trace) => { … })
```

that owns the try/fail/rethrow contract. Call sites shrink by ~10 lines each and
the settle-exactly-once rule is enforced in one place.

### 1.8 ✅ [M] DX — `defineRoute` swallows unexpected errors silently (done 2026-07-18)

[http.ts](server/http.ts:128) maps any thrown value to a JSON 500 but never
logs it. An operator seeing "Internal server error" in the UI has nothing in the
server output to correlate. Suggestion: `console.error` (with the route path)
for non-`ApiError` throws — traces don't cover route-level failures that happen
before a service opens one.

### 1.9 ✅ [M] UX — Static bot replies ignore the per-chat language (decided + done 2026-07-20: keep English, framed as a system notice)

`ERROR_REPLY` and `MAINTENANCE_REPLY` in
[service.ts](features/bot-messaging/server/service.ts:34) are hard-coded
English, while the feature contract promises the bot is "strictly" in the
configured chat language. A Ukrainian-language chat gets an English maintenance
notice. Suggestion: either translate via a small static map keyed by the
configured language when it matches a known set, or generate once per language
and cache — or simply state in the message that it is a system notice (needs
decision on tone).

---

## 2. Shared infrastructure

### 2.1 ✅ [M] db — `pg` Pool is not HMR-safe (done 2026-07-18)

[pool.ts](db/pool.ts) keeps the pool in a module-local variable, unlike every
other process-wide singleton in this codebase (hub, trace store, bot manager,
MCP registry) which deliberately use `globalThis` to survive dev hot-reload and
bundle duplication. Each re-evaluation of this module in dev can create a new
pool and leak connections. Suggestion: adopt the same `Symbol.for` +
`globalThis` pattern for consistency and safety.

### 2.2 ✅ [L] api-error — Zod v4 deprecations (done 2026-07-19)

`err.flatten()` ([http.ts](server/http.ts:75),
[env.ts](server/env.ts)) is deprecated in Zod 4 in favor of
`z.treeifyError` / `z.flattenError`. Migrate before a future Zod major removes
it.

### 2.3 ✅ [L] http — CSV BOM as a literal character (done 2026-07-18)

[http.ts](server/http.ts:61) embeds the BOM as an invisible literal character in
the template string (`` `﻿${csv}` ``). It works, but any editor/formatter that
normalizes the file can silently strip it. Use the escape: `"﻿" + csv`.

### 2.4 ✅ [L] lib — `build-info.ts` imports all of `package.json` into the client (done 2026-07-19)

Importing `pkg from "@/package.json"` in a client-safe module ships the whole
manifest (dependency list and versions) to the browser bundle. Harmless-ish, but
it leaks stack details and bloats the bundle. Suggestion: inline only
`name`/`version` via `next.config.ts` `env`, or a codegen'd constant.

### 2.5 ✅ [L] schema — Missing CHECK constraints for enum-like columns (done 2026-07-20, migration 0031)

`chat_messages.role`, `message_media.status`, `scheduled_tasks.schedule_kind`,
`users_feedbacks.status`/`reaction`, `period_insights.granularity` are free-text
columns whose valid values live only in app code, while `memory_entries` got
proper CHECK constraints. Low risk (single writer), but cheap to add at the next
migration and it documents the contract in the schema.

### 2.6 ✅ [L] realtime — Per-event publishing is chatty (done 2026-07-20)

`startTrace`'s recorder publishes a `traces` SSE event for **every appended
trace event** ([recorder.ts](server/trace/recorder.ts:137)) — a single reply
with tool rounds emits a dozen notifications, each triggering (debounced)
`router.refresh()` in every open Debug tab. The 400 ms client debounce absorbs
most of it, but each refresh is a full server re-render of an uncapped trace
list (see 1.5). Suggestion: throttle server-side (e.g. coalesce publishes per
trace per second), or publish per-event only while a trace-detail view is
subscribed.

---

## 3. LLM core (`server/llm`)

### 3.1 ✅ [M] correctness — Stall guard doc promises a "forced final answer" it never makes

The header comment of [tool-loop.ts](server/llm/tool-loop.ts:29) says a stall
"takes the tools away for one final forced answer" — the MVP behavior. The
implementation instead returns `loopDetected` with empty content, and
`chatCompletionWithTools` turns that into a thrown 503, so the user gets the
generic error reply. Either fix the comment, or (better, and what the comment
already argues for) implement it: on stall, re-send the conversation once with
`tools` omitted and an instruction to answer from what it has. That converts a
hard failure into a degraded answer.

### 3.2 ✅ [M] performance — Tool calls within a round run sequentially (done 2026-07-20; concurrent, capped at 4, results reported in call order)

[tool-loop.ts](server/llm/tool-loop.ts:181) awaits each tool call in order. A
model that emits three independent lookups (three `history_search` calls, a
search + a link read) pays them serially. Trace ordering is the only consumer of
the sequence, and `onToolCall` could still be invoked in completion order.
Suggestion: `Promise.all` over the round's calls (optionally capped), keeping
the `conversation.push` order aligned with the call list.

### 3.3 ✅ [L] performance — Tool list is rebuilt per turn (done 2026-07-18)

`getToolset()` → `registry.listOpenAiTools()` does an MCP `listTools` round trip
plus schema conversion on **every reply**. The registry is append-only after
boot. Suggestion: cache the OpenAI-shaped list in `BotMcpRegistry` after
`finishRegistration()`.

### 3.4 ✅ [L] API — `maxRounds` is unbounded by default (done 2026-07-19)

`runToolLoop` treats unset `maxRounds` as infinite, protected only by the stall
guard — which a model that keeps inventing *novel* tool calls never trips
(each new argument string resets the streak). The reply path passes no cap.
Suggestion: a generous default cap (e.g. 16 rounds) in
`chatCompletionWithTools`.

---

## 4. Telegram runtime & bot messaging

### 4.1 [M] performance/cost — The addressing analyzer runs on every undecided group message (pre-filter built 2026-07-20, **reverted same day by the user** — it weakened detection; verdict cache / per-group flag remain unchosen options)

[addressing.ts](features/bot-messaging/server/addressing.ts) returns
`needsAnalyzer` for *any* group text that doesn't deterministically reference
the bot — i.e. nearly all ordinary group chatter — and each one costs an LLM
classification call plus a trace. In a busy group that's an inference per
message (and with 1.3, each blocks the queue). Tokens may be free locally, but
latency and trace volume are not.

Suggestions (compoundable):
- Cheap pre-filter: only run the analyzer when the message contains a token
  with some plausible similarity to the display name (e.g. shared prefix after
  transliteration tables, or length-bounded Levenshtein against the name) —
  the analyzer only ever confirms *name* references, so text that contains
  nothing name-shaped can skip it.
- Cache verdicts for identical texts (stickers/`+1`-style repeats).
- Make the analyzer opt-in per group (a `known_groups` flag), so quiet DMs and
  name-shaped groups pay nothing.

### 4.2 ✅ [M] performance — Reply context loads are sequential (done 2026-07-18)

[service.ts](features/bot-messaging/server/service.ts:411-486) awaits
`loadChatContext` → `loadMemory` → `loadSenderPreferences` → `loadCurrentTurn`
→ `loadHistory` → `loadVision` one after another; all are independent DB (or
vision-LLM) reads. Parallelize with `Promise.all` and emit the trace steps
after resolution, in the fixed order. Saves several round trips per reply on
the hottest path.

### 4.3 ✅ [M] UX — Long replies are truncated, not split (done 2026-07-19; scheduled-task fires still truncate — their trace correlates on one message id)

[reply.ts](features/bot-messaging/server/reply.ts) cuts at 4096 chars with an
ellipsis, silently losing content. Telegram allows multiple messages;
suggestion: split on paragraph/sentence boundaries into ≤4096-char chunks and
send sequentially (first as the reply, rest as follow-ups). The transport
already returns message ids, so mirroring can store each chunk.

### 4.4 ✅ [L] UX — Replies are plain text while models emit Markdown (decided + done 2026-07-20: Markdown → Telegram HTML at the transport, plain-text fallback)

Deliberate v1 scope, but the effect is visible daily: `**bold**` and code fences
render literally. When revisited, prefer converting model Markdown to Telegram
HTML with escaping (the MVP had this) over `parse_mode: MarkdownV2`, whose
escaping rules are notoriously fragile.

### 4.5 ✅ [L] refactoring — `buildDeps` takes 10 positional parameters (done 2026-07-20)

[process-update.ts](server/telegram/process-update.ts:119) threads policy,
persona, correction, time, language, image sink, vision, overrides positionally.
An options object would make call sites readable and future additions
non-breaking.

### 4.6 ✅ [L] correctness/doc — "Best-effort" capture actually blocks and can fail handling (done 2026-07-19)

The comment above the passive capture in
[process-update.ts](server/telegram/process-update.ts:374) says remember/mirror
are "best-effort and must not block handling", but `rememberUser`,
`rememberGroupActivity`, and `recordIncomingMessage` are awaited bare — a DB
hiccup rejects the whole update instead of degrading to a reply without
history. Wrap them in a `.catch` (with a trace/warn) or make the comment honest.

---

## 5. History

### 5.1 ✅ [M] performance — `history_search` is an un-indexed ILIKE scan (done 2026-07-19, migration 0030)

[repository.ts](features/history/server/repository.ts) `searchChatMessages`
does `content ILIKE '%…%'` — a sequential scan over the chat's full mirror per
query (and the tool accepts arrays of queries). Fine at thousands of rows,
painful at hundreds of thousands. Suggestion: a `pg_trgm` GIN index on
`chat_messages.content` (extension is available — pgvector image ships it), or
route lexical search through the same `to_tsvector` path the summaries use.

### 5.2 [L] refactoring — Two near-identical CSV panels

`HistoryTransferPanel.tsx` (472 lines) handles both export and import with a lot
of inline state machinery; if a second feature ever needs file import/export UI
(analytics export is plausible), extract the file-picker/progress/result shell
into `components/ui` first, per the "extract before second use" rule.

---

## 6. Vision

### 6.1 [M] scalability — Base64 frames in `jsonb`

`message_media.frames_base64` stores up to `VIDEO_FRAME_COUNT` JPEG frames as
base64 strings inside a `jsonb` column, and `data_base64` a full image as
base64 `text`. Base64 inflates bytes by ~33 % and jsonb adds parsing overhead;
big values TOAST but still make every `SELECT *` on the table expensive (the
dashboard list already avoids bytes only by projecting in `toView` *after*
loading full rows). Suggestion: `bytea` columns (or a `media_blobs` side table
keyed by media id, so listing rows never touches bytes). The bytes are dropped
after describe, which bounds the damage — but a backlog of pending videos is
exactly when the table is hottest.

### 6.2 ✅ [L] performance — Pending-media dashboard list loads bytes it may not render (done 2026-07-19)

`listRecentMedia` returns full rows including `data_base64`/`frames` for up to
100 rows; `toView` then throws away bytes for described rows. Project the
columns conditionally in SQL instead.

---

## 7. Scheduled tasks

### 7.1 ✅ [M] correctness — A one-shot that fails to fire is deleted (decided + done 2026-07-20: retry up to 5 ticks, then disable — never delete; migration 0032)

[scheduler.ts](features/scheduled-tasks/server/scheduler.ts:166): the schedule
is settled "regardless of fire success", and a spent one-shot is **deleted** —
so a one-time reminder that came due while the LLM was down is gone forever,
recorded only in a trace nobody was watching. Recurring tasks self-heal; one-
shots don't. Suggestion (**needs decision** — behavior change): retry a failed
one-shot for a bounded window (e.g. keep `next_run_at`, add an `attempts`
column, give up and disable after N tries) so a transient outage doesn't eat
reminders.

### 7.2 ✅ [L] robustness — Chat-kind detection by id sign (done 2026-07-19)

`task.chatId.startsWith("-")` selects group vs. DM language lookup. It's
correct for Telegram today, but the same fact is already modeled properly
elsewhere (`known_groups` membership). A `isGroupChatId()` helper in one shared
place would keep the assumption single-sourced.

---

## 8. Memory & self-improvement

### 8.1 ✅ [L] refactoring — `embedForStorage` / `embedQuery` are duplicates (done 2026-07-18)

Same body, different names ([service.ts](features/memory/server/service.ts:55)).
One `tryEmbed(text)` with the two call sites keeps the intent without the copy.

---

## 9. Analytics

### 9.1 [H] performance — Every dashboard read re-scans all trace history (1. range-aware `scanTraces` ✅ landed with 1.5's windowing, pass 2; 2. scan-once ✅ done 2026-07-18; 3. deferred until volume demands)

[trace-source.ts](features/analytics/server/trace-source.ts): `readUsageRows`,
`readTrafficTotals`, and `readTraceAvailability` each call `scanTraces`
independently — three full-store scans per metrics request, on top of 1.5's
load-everything behavior, re-triggered by SSE refreshes while the bot is
active. Suggestions, in order of leverage:

1. Make `scanTraces` range-aware (only load intersecting months — see 1.5).
2. Scan once per request: fetch the period's traces once in the service layer
   and pass rows into the three aggregators (they are already pure after the
   scan).
3. If the dashboard is still heavy at scale, maintain a small in-memory
   aggregate per (month, model, callKind) built at flush time — but only after
   1 and 2, which are nearly free.

### 9.2 ✅ [M] performance — Hour queries filter on computed expressions (`getHourMessages` done 2026-07-18; due-scan floor done 2026-07-20)

`getHourMessages` and `listHoursNeedingInsight`
([repository.ts](features/analytics/server/repository.ts:357)) filter/group by
`to_char(date_trunc('hour', sent_at at time zone $tz), …)`, which can never use
the `(chat_id, sent_at)` index and re-derives the hour for every row of the
chat (or the whole table, for the due-scan CTE, on every nightly run *and*
every `/jobs` page load via `countHoursNeedingInsight`). Suggestion: compute
the hour's UTC bounds in code (the zone logic already exists in
`period.ts`/`schedule.ts`) and filter with `sent_at >= $from AND sent_at <
$to`; for the due-scan, bound it with a watermark (oldest unscored hour) so it
stops re-grouping years of history nightly.

### 9.3 [L] performance — Missing indexes for common filters

Per-user drill-down filters `chat_messages.user_id` and global series scan by
bare `sent_at`; neither is indexed (`chat_messages` only has
`(chat_id, sent_at)` and the unique pair). Add `(user_id, sent_at)` and
`(sent_at)` when data volume starts to matter.

---

## 10. Settings & UI

### 10.1 ✅ [M] refactoring — `SettingsForm.tsx` is an 849-line monolith (done 2026-07-20)

28 `useState` hooks, three connection-test state machines, and three
near-identical "endpoint + key + model + Test" blocks (LLM, embeddings, image)
in one client component. The three blocks are the same pattern with different
endpoints — extract a `ConnectionSection` component (fields + probe button +
status line) and a `useProbe` hook; the form shrinks to composition + save
logic. This will also pay off when the next connection type arrives.

### 10.2 [L] consistency — Jobs board vs. per-feature job cards

There are both a consolidated `/jobs` registry
([registry.ts](features/jobs/server/registry.ts)) and per-feature job cards
(`SummaryJobCard`, `MemoryJobCard`, `AnalyticsJobCard`…). The mappers are
duplicated knowledge (each feature's info shape → card view). Consider having
the per-feature cards consume the same `JobView` mappers the board uses, so a
new job field appears everywhere at once.

### 10.3 [L] UX — Debug list is uncapped by design, but renders uncapped too

`getTraceList` deliberately returns all headers; with months of traces that is
a lot of DOM. The store already supports `limit`/`offset` — add incremental
rendering (virtualized list or "load older" paging) before trace volume makes
the Debug page itself the slow thing. Pairs with 1.5's retention.

---

## 11. Deployment & operations

### 11.1 ✅ [M] ops — No retention/rotation for the trace volume (docs done in pass 4; decided + done 2026-07-20: manual prune on the Debug page — deliberately no automatic retention)

`data/traces` grows without bound (see 1.5) and holds full conversation bodies.
Add retention (delete/compact month files older than N months) and mention the
privacy weight of that directory in the README (it is effectively a chat-log
archive; back it up / protect it like the DB).

### 11.2 [L] build — `npm install` in the image forfeits lockfile reproducibility

The Dockerfile documents why (`npm ci` + cross-platform optional native deps),
but the cost is unpinned transitive updates at image build time. Alternative
that keeps both: `npm ci` plus explicit `npm install --no-save` of the musl
variants, or generate the lockfile in-container once. Low priority; the
tradeoff is at least documented.

### 11.3 ✅ [L] ops — No database backup story in compose (done 2026-07-20; README, incl. the trace-dir privacy note from 11.1)

`db` data is a bind mount, but there's no documented dump/restore path, while
the cutover plan (Phase 12) assumes backups exist. A `pg_dump` sidecar/cron or
a documented one-liner in the README would close the loop.

---

## 12. Testing

The unit/integration split (Vitest + Testcontainers), injected collaborators,
and the transport-seam simulation harness are genuinely strong. Gaps worth
filling, in priority order:

1. ✅ **[M] Concurrency** (done 2026-07-21): two updates genuinely in flight
   through the pipeline — cross-chat overlap with no cross-talk, same-chat
   in-order processing observed in order, same-chat out-of-order completion
   losing nothing
   ([process-update.concurrency.integration.test.ts](../server/telegram/process-update.concurrency.integration.test.ts)) —
   and two schedulers contending for the advisory lock from separate pools
   ([lock.integration.test.ts](../server/jobs/lock.integration.test.ts)).
2. **[L] Trace store scale**: store tests cover correctness, not behavior with
   a large multi-month corpus (would catch 1.5 regressions).

---

## Suggested order of attack

Quick wins (an afternoon each, no decisions needed): 1.4 settings cache ·
1.8 route error logging · 2.1 pool singleton · 3.3 toolset cache · 3.1 stall
comment/behavior · 4.2 parallel context loads · 9.1(2) scan-once ·
9.2 hour-bounds filters · 2.3 BOM escape · 8.1 dedupe.

Bigger, high-value (some need a user decision): 1.1 auth · 1.2 SSRF DNS check ·
1.3 concurrent updates · 1.5 + 9.1(1) + 11.1 trace-store windowing & retention ·
1.6 daily-scheduler factory · 4.3 reply splitting · 7.1 one-shot retry.
