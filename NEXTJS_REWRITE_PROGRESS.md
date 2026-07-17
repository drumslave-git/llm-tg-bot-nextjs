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
Owner: agent/2026-07-17
Last updated: 2026-07-17

> **Dev LLM tokens are free** (operator, 2026-07-16): the dev LLM is **local and
> self-hosted**, so token spend is not a reason to skip anything — *"you can test as
> much as you want"*. Several older entries below carry gates like *"Not run
> (operator's call): a real 'Run now' spends tokens on their data"* — **those gates
> are void**; they traded real verification coverage for an imaginary cost. Run the
> LLM-backed jobs when verifying. A genuine "not verified" reason must be a real
> blocker (no browser, no Docker, a live Telegram send), never cost.
Proof: `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (459 unit), `npm run test:integration` ✓ (247 passed / 21 skipped, real Postgres via Testcontainers — **no failures**; the long-standing `process-update.integration.test.ts:111` failure was fixed by commit `81c08ce`), `npm run build` ✓.

**Memory extraction accuracy (priority 10, 2026-07-17, done — found by the operator reading the prod `/memory` page):** the General knowledge document had filled up with confident biography about one person, most of it wrong. Two user decisions shaped the fix (see the two *Memory accuracy* rows in Decision Notes).

- **The model did not hallucinate, which is the whole finding.** The wrong line *"Ігор worked at big companies such as LastPass"* traces to a real message in the mirror: one person **speculating about a third party**, in which *"like LastPass"* was an **example**, not an employer. Diagnosed by querying the traces, not by reading the prompt: every `memory-extraction` `llm_response` was checked for the bad strings and **none contained them in its `facts` array** — the matches were in `reasoning_content` scratchpads. So extraction was faithfully recording what was said, and "improve accuracy" meant fixing *what we let it record*, not making it invent less. Chasing "the model is lying" would have burned the session on the wrong layer.
- **Root cause 1 — the roster was alias-blind.** `known_users.aliases` is operator-curated and *already* injected into DM replies via `formatUserContext`, but `buildExtractionRequest` built its roster from `formatKnownUserLabel` alone (`First Last (@username)`). A group speaks only in nicknames, so the model saw statements it could not tie to any offered id. Extraction was the one consumer that dropped identity data the project already had. Roster is now `[id:N] Label — also called: …`.
- **Root cause 2 — an escape hatch laundered gossip into shared knowledge.** *Both* queue producers, on failing to resolve a person, instructed the model to re-file the fact as `general` with the name written in, and extraction said *"Never drop such a fact"* outright. `general` is one merged document with **no identity model**, so the merge fused name-keyed lines about different people into one subject — that is how a nickname became a person who inherited someone else's job history. Now dropped at both producers; `general` is knowledge about **nobody**; `GENERAL_MERGE_PROMPT` prunes biography out of the existing document and is forbidden from concluding two names are the same person.
- **Shared policy, not per-producer patches.** `FIRST_PERSON_EVIDENCE_RULE` and `UNIDENTIFIED_PERSON_RULE` live in `features/memory/prompt.ts` next to `DURABLE_FACT_KINDS`, so the `memory_save` tool and the nightly job cannot drift on *what is worth remembering* — the property that module already existed to protect.
- **Two rules added on my own judgement, not asked for** (easy to revert, both from the same trace evidence): `NON_DURABLE_FACT_KINDS` now excludes **values that are only true right now** (version/model/port/setting) — a trace shows the model visibly agonizing (*"Is the port thing 'durable'? … Usually, these are okay"*) before storing *"the app starts on port 3000"* as permanent memory, because the policy gave it no guidance; and extraction is told **it is not a person** and must never store facts about itself or its own configuration, which is what put the bot's own model swaps and feedback mechanism into the document as biography.
- **Tests (+8 → 464 unit ✓, 39 memory integration ✓; lint ✓, typecheck ✓).** The prompt is the whole enforcement surface here (`parseExtractedNotes` cannot tell hearsay from testimony by looking at a string), so the rules are asserted directly to stop a later edit quietly deleting one. The alias roster is covered end-to-end in the integration test — **that test caught my own bad assertion**, not a code bug: the roster lists *speakers*, and I had asserted on someone who never spoke.
- **Prod is not self-healing — the operator must clean it up.** The general merge only runs `if (generalBatch.length > 0)`, so the existing bad document is only rewritten once a new `general` note is queued — and the new rules make those rarer by design. The bad lines need removing on the `/memory` page (or a `general` note has to arrive) before the pruning prompt can act.

**Provider error bodies were being thrown away (2026-07-17, done — found by the operator's first live image draw):** the bot reported *"LLM endpoint error (500): 500 status code (no body)"* while the server had, in fact, explained itself precisely. **The "no body" was our bug, not the provider's** — and it spanned every LLM call (chat, embeddings, images), not just this feature.

- **Root cause is in the SDK's error parsing, and it punishes well-formed errors.** `openai/client.js` reads the error body, and then: `const errMessage = errJSON ? undefined : errText` — if the body parsed as JSON, the raw text is dropped. What survives is only `errorResponse['error']` (`APIError.generate`), i.e. **OpenAI's own `{error: {…}}` shape**. A backend answering FastAPI-style `{"detail": "…"}` (llama.cpp/DMR/vLLM territory — exactly what this project talks to) therefore yields `error === undefined` → `makeMessage` falls through to the literal string `"500 status code (no body)"`. Perversely, a **plain-text** error body survives intact; a **JSON** one does not.
- **Fix at the single choke point:** `createOpenAiClient` now passes a `fetch` wrapper (`fetchWithErrorDetail`) that, on a non-2xx JSON body **lacking** an `error` key, rewrites it to `{error: {message}}` — preferring `detail`, then `message`, else the whole object stringified rather than inventing a summary. A body that already has `error` is passed through untouched, so a real OpenAI endpoint behaves exactly as before. `apiErrorDetail` now prefers `error.message` over `JSON.stringify(error)`, so the detail reads as a sentence instead of arriving wrapped in braces.
- **What it recovered, live:** `LLM endpoint error (500): Image generation failed: Input type (c10::Half) and bias type (float) should be the same` — a precise, actionable dtype fault that had been invisible.
- **Confirmed in the real bot path** (trace `3973ae49…`, after a dev-server restart — the first post-fix trace still showed "no body" because the boot-bound MCP registry was still holding the pre-fix module graph; **an edit to `client.ts` does not reach the tool without a restart**). Unplanned but telling: with a real reason in hand the *bot itself* explained the fault to the operator in chat (*"It's throwing a type mismatch error—Half vs float"*), where before it could only say "It failed. Typical." Better provider errors improve the product, not just the trace.
- **Tests (+7 → 459 unit ✓).** New `server/llm/error-detail.test.ts` drives the **real** OpenAI SDK against a stubbed `fetch` (mocking `openai` would test nothing — the SDK's parsing *is* the behaviour under test): `detail` and bare `message` bodies surface, an unrecognized shape falls back to the whole body, a real OpenAI error is untouched, plain text still works, a 200 passes through, and the detail reads as a sentence. **Verified the tests have teeth**: commenting out the `fetch` option reproduces the operator's exact string (`expected 'LLM endpoint error (500): 500 status …' to contain 'c10::Half'`) and fails 3 cases.
- **Lesson (a repeat of the 2026-07-16 DMR one, in the other direction):** last time we blamed the provider for our own bug; this time the provider *was* broken, but our error mapping hid the evidence that proved it. Either way — read the raw body before concluding anything about a third party. This time the body was not even in the trace to read, which is what took a manual probe.

**Image generation (priority 12, done 2026-07-17):** the bot can draw a picture when asked and send it to the chat. Three decisions were taken by the user before any code (see the three *Image generation* rows in Decision Notes); the third one is what shaped the feature.

- **The image is stored as *media*, not in a store of its own** (user: *"send image, we have to store vision recognition of that image, similar to user sent media"*). This turned out to delete most of the feature rather than add to it: no images table, no gallery, no retention setting, no new describer. A delivered photo lands in `message_media` (`pending`, keyed by the `file_id` Telegram mints on send) and the existing vision path recognizes it exactly like a received picture — verified, not assumed: `listPendingMedia` filters on `status = 'pending'` alone, so the backfill picks these rows up with no wiring. The bytes drop on describe because that is already the rule. **The payoff is that the bot's own drawing enters history as a description**, so a later turn knows what it drew instead of finding a hole in the transcript.
- **Bytes never travel through the tool result.** The MVP returned base64 in `structuredContent`; here that would put ~1MB into the model's context *and*, verbatim, into two trace rows (`tool-trace.ts` records structured content as-is). Instead the turn binds a `collectImage` sink on the existing `McpToolContext` (the same AsyncLocalStorage the chat scoping already uses) and the pipeline delivers after the reply. So the recorded structured content is `{ok, count, size}` — complete *and* small, honoring `debug-show-full-raw-bodies` with **no redaction step to forget**, unlike the vision exception. No sink bound (e.g. a text-only scheduled-task fire) → the tool refuses *before* generating rather than spending minutes on bytes nothing can send.
- **Provider is the embeddings pattern, not a new one.** `server/llm/images.ts` (`/v1/images/generations`, `b64_json`) + `image_base_url`/`image_api_key`/`image_model` (migration `0025`, **applied**) resolving through `toImageRuntime` — a twin of `toEmbeddingRuntime`, falling back to the LLM connection, key-follows-host. The Settings probe deliberately **does not generate**: unlike the embedding probe (where a real call is the only way to learn the vector width) nothing about an image is knowable only by drawing one, and a diffusion model would hang the button for minutes. It lists models and checks the configured one is served.
- **The describer is not told the prompt.** Tempting, and wrong: a describer told what the picture is *supposed* to contain paraphrases the prompt instead of recognizing the image, and diffusion models routinely miss parts of a prompt. The stored hint states provenance only ("generated by the bot itself"), so the recognition answers the question actually being asked. Pinned by an integration test.
- **Shared, not duplicated:** `recordAssistantMessage` gained `hasMedia`, reusing the `recordMediaMessageSchema` that already existed for incoming media — the bot can now send a media-only message, and the picture *is* the message. Delivery lives in `features/image-gen/server/deliver.ts` rather than swelling `process-update.ts` (which also made it directly testable). `ReplyTransport` gained `sendPhoto`, implemented by the grammy adapter and by the simulator's capturing sink.
- **Tests (+14 → 452 unit ✓; +6 image-gen integration, +5 settings integration ✓).** Unit: the two lies the result text exists to prevent (describing an unseen image; claiming one was sent), the core's never-throw contract, and the sink contract (bytes reach the sink, `JSON.stringify(result)` does **not** contain them, no-sink refuses without generating). Integration (real Postgres): pending media row + provenance hint, bytes normalized to JPEG like received media, media-only history mirror, per-image ordering, a send failure storing nothing and not throwing, and a missing file id storing no media but still mirroring the message.
- **Live**: the Settings probe answered against the operator's real endpoint — `docker.io/ai/stable-diffusion:Q4 — served (7 models)` (their LLM host already serves a diffusion model). **Live tool-selection 3/3 ✓** against the real local LLM (`LLM_LIVE=1`): draws when asked, expands a terse request into a real prompt rather than echoing it, and stays silent for casual chat that merely mentions a picture — the tool description is the one part no unit test can vouch for, so both directions are asserted.
- **Checks:** lint ✓, typecheck ✓, unit 452 ✓, integration 247 passed / 21 skipped ✓, build ✓ (0 warnings, `/api/settings/test-images` in the route list).
- **Verified live end-to-end by the operator the same day, and the app half works** (trace `8d117ce3…`, model `docker.io/ai/stable-diffusion:Q4`): "generate an image of a cat" → the model chose `image_generate`, **expanded the request into a real prompt** unprompted (*"A cinematic, high-detail portrait of a cat with piercing eyes, moody lighting, and a dark, textured background"*), the tool ran, and when the provider failed **the honesty rules held** — the reply was *"It failed. Typical."*, with no claim of an image and no description of one. That is every layer of this feature except the provider.
- **The provider itself is broken, and it is not ours:** `ai/stable-diffusion:Q4` answers **500** to *every* request shape — with and without `response_format`, with and without `size`, at 512 and 1024, and to a bare `{model, prompt}` — always with the same body: `{"detail":"Image generation failed: Input type (c10::Half) and bias type (float) should be the same"}`. That is a **dtype mismatch inside the operator's image backend** (fp16 weights against an fp32 bias); the model never executes. Nothing in this repo can fix it — it is a deployment/model-packaging problem for that DMR image model. **Ruled out by probing rather than by reasoning**: five request variants against the live endpoint, all identical, which is what proves the request shape is irrelevant.
- **Still not verified:** a **successful** draw, end to end — no image has ever come back from this endpoint, so the delivery half (`sendPhoto` → `message_media` → the describer recognizing the bot's own picture) has only been proven against real Postgres with a synthetic PNG, not against a real generation. Needs a working image backend: fix the `stable-diffusion:Q4` dtype fault, or point Settings → Images at a host that can actually draw (the connection is separable precisely for this).

**Mood feature deprecated (user, 2026-07-16, done — docs only):** *"remove feature mood (which was affecting bot behavior) from plan - it is deprecated."* The bot-facing Mood feature — mood/personality state and its injection into replies, carried over from the MVP and already de-prioritized to lowest on 2026-07-14 — is **dropped from the plan permanently**. Do not implement it; re-adding needs a new user decision.

- **No code changed, and none needed to.** The feature was never started (priority 14, `todo`, no tables, no service, no page), so this is a planning-document change only: there is no mood state to migrate away from and nothing to revert. Reply behavior remains base system prompt + active personality.
- **Removed from the forward-looking plan** in `NEXTJS_REWRITE_PLAN.md`: the priority-14 row (now a **Dropped features** table stating it is deprecated), the `mood/personality state` entity, the `mood/personality` context block in prompt assembly, the `mood cooldown` background job, the mood dashboard page and `mood/personality injection` bot behavior in the Phase 1 inventory, and the "Mood and memory both depend on…" dependency note. `AGENTS.md` priority list ends at 13 with an explicit do-not-implement note. In the tracker: the feature row is struck through and marked deprecated, and the stale "Mood (priority 9) extends this table" / "Add memory/mood context blocks" forward pointers on Personalities, Prompt model, Phase 2, and Phase 5 are gone.
- **Kept deliberately — the analytics mood score (priority 11) is a different thing and stays.** It is an LLM-derived observation *about* a chat, rendered on the dashboard; it never fed the bot's behavior and shares no tables with the dropped feature. The two only ever shared a word. Also left intact: the MVP description under "Current Reference System", which is a factual record of what the old app does, not a scope list.

**General memory becomes one injected document (user-requested 2026-07-16, done):** *"and if its not — general memory have to be one document, injected in prompt for every reply"* — said in answer to the `known_users` ceiling below. It **reverses two of the original memory decisions** and, in doing so, lifts that ceiling.

- **What it solves.** A fact about someone with no `known_users` row could not be stored at all: `memory_entries.user_id` references `known_users`, so the person has nowhere to live. Now it is not filed under a person — it is kept in general knowledge, *named* ("Bob lives in Porto"). Nothing is dropped for want of an id. And because general knowledge is injected, the bot actually knows it rather than having to think to look it up.
- **Reversal 1 — storage: rows → one document.** `general_memories` was N independently embedded fact rows; it is now a **singleton document** (migration `0022`), a structural twin of `user_memories` with no person attached. Deleted with the rows: the `embedding` column, the HNSW index, the hand-added FTS GIN index, `findSimilarGeneralMemories`, `insertGeneralMemory`/`deleteGeneralMemories`, `GENERAL_RECONCILE_PROMPT`, `parseGeneralDecision`, the `POST /api/memory/general` + `PATCH|DELETE /api/memory/general/[id]` routes, and the dashboard's "Add fact" form.
- **Reversal 2 — injection: tool-only → every reply.** The original rationale was that general memory spans every chat and grows without bound, so a reply could only afford the few facts relevant to the question — hence a vector per fact. Overridden, and the trade is real (it costs context on *every* reply). Two things justify it: knowledge the model must *choose* to look up is knowledge it mostly does not use, and the nightly merge already bounds a document by deduplicating and resolving contradictions — exactly as it always has for the per-person documents, which are injected and uncapped too.
- **The nightly general pass is now a merge, not a reconcile.** Same shape as the user merge, sharing `parseMergedDocument`, and it **fails closed** the same way: an empty merge is treated as a failed pass, never as "general knowledge is now empty", so a garbage response cannot erase the shared document. Cost dropped from **one LLM call per pending note** to **one per run**.
- **Tools: `memory_get`/`memory_search` are user-scope only; `memory_save` keeps both scopes** — it is how a general fact gets written. `memory_get` lost its `scope` parameter entirely (it read one thing). `searchMemories` no longer fuses the general half: the model already has that document in context, so searching it would spend a round-trip to hand back its own prompt. What remains worth searching is what is *not* injected — the documents of people who are not in this conversation.
- **The general fallback is wired at both producers, not just one.** Extraction: `EXTRACTION_SYSTEM` now says a fact about someone off the roster becomes a **general** fact naming them, instead of "skip it". Tool: `memory_save`'s description tells the model that a rejected `user` save should be retried as `general` with the name written into the fact, and the `resolveSubjectId` rejection message now names that way forward instead of just refusing.
- **The migration is hand-written past drizzle-kit.** The generated version dropped the columns but left every fact as its own uuid-keyed row — which a singleton read (`id = 'singleton'`) would never find, silently orphaning the whole store. It now collapses the rows into the document **first**, ordered by `created_at` (so it must run before that column is dropped). The aggregate deliberately spans *every* row including any already keyed `singleton`, since excluding it would let the `ON CONFLICT` overwrite that row's own content with a document omitting it; `HAVING count(*) > 0` keeps it a clean no-op on an empty table rather than inserting a NULL-content row.
- **Verified the collapse against real Postgres before running it on real data.** The integration suite migrates an *empty* database, so the collapse branch — the one that must not lose the operator's facts — is untested there. Proved it separately in a rolled-back transaction over a temp table: 5 facts → one document, all preserved in order; empty table → clean no-op; pre-existing singleton + a loose fact → both folded in (this last case is what caught the `WHERE` bug above). Then applied for real: the operator's **5 general facts survived as 5 lines of one `singleton` document**, columns now `id / content / updated_at`.
- **Tests (440 unit ✓, 38 memory integration ✓).** `prompt.test.ts` swaps the reconcile parser for the merge builder (+ a check that the prompt demands every line name its own subject — the general document has no subject of its own). Integration: merge folds notes in, the existing document is shown to the merge, **one LLM call for the whole backlog**, an empty merge leaves the document *and* the notes alone, a fact about an unkeyable person is kept, general is injected alongside the sender's own memory, injected **even when the bot knows nobody** and **even with no identified sender**, still nothing when it knows nothing at all, and general is deliberately **not** searchable. The old "does not inject general knowledge — that is tool-only" test now asserts the opposite.
- **Verified live**: `/memory` renders the collapsed document under "Injected into every reply" with Edit / Forget-all and no stale "Add fact"; the People card shows a real document the passive extraction built. Build ✓ (`/api/memory/general/[id]` gone from the route list).
- **Checks:** lint ✓, typecheck ✓, unit 440 ✓, memory integration 38 ✓, full integration ✓ except the one pre-existing failure below, build ✓.

**Passive memory extraction (user-requested 2026-07-16, done):** *"memory is too weak. bot remembers something only in case it is addressed. we need passive memory extraction."* The bot now learns from the whole conversation, not just the turns aimed at it.

- **The bottleneck was structural, not the prompt.** `memory_entries` had exactly **one producer** — the `memory_save` tool — and a tool only runs while the model is composing a reply, which only happens when `checkAddressed` says yes. In a group that meant the bot mined the handful of turns aimed at it and learned nothing from the conversation around it, which is where people actually say where they live and what they do.
- **Nothing about addressing changed.** `recordIncomingMessage` already mirrors **every** message regardless of addressing, so the raw material was already in `chat_messages`. The fix is a **second producer** reading the mirror, not a loosening of when the bot speaks — the bot is exactly as quiet as before, it just stops being amnesiac about what it heard.
- **Decisions (user, AskUserQuestion — both in Decision Notes):** (1) **nightly, folded into the existing memory job** rather than a new scheduler or an idle trigger; (2) **all chats, all human messages** (not groups-only).
- **The run is now two passes, in order** (`features/memory/server/scheduler.ts`): *extract* → *consolidate*, sharing one advisory lock. Extraction first so a day's facts reach durable memory the **same** night rather than waiting for the next. An extraction failure does **not** skip consolidation: the queue may hold tool-saved notes, and a dead extraction pass is no reason to leave them pending another day.
- **Shaped as a twin of the history summarizer** (`features/memory/server/extract.ts`), because it is the same problem: one LLM pass per finished chat-day over an id-anchored transcript. New `memory_extraction_days` marker table (migration `0021_previous_wendell_rand`) mirrors `chat_summary_days`, including `message_count` — which makes the job **self-healing** (a day that gains rows later is re-read; an unchanged day is never re-spent) and **retroactive by construction**: the due-scan cannot tell yesterday from a day predating the feature, so **the first run mines the entire history the mirror has ever stored**. There is no separate backfill to run or forget.
- **Facts are attributed by id, never by name.** The prompt shows a roster (`[id:…] Label`) and id-tagged transcript lines; `parseExtractedNotes` **discards any `user` fact whose id was not in that roster**, and every surviving note still goes through `saveMemoryNote` — the same known-user check the tool clears. Two people in a group can share a first name; the id is what the store is keyed by. The bot's own rows carry no id, so no fact can be attributed to it.
- **One durability policy, not two.** The "what counts as durable / what never does / write it self-contained" rules now live once in `features/memory/prompt.ts` (`DURABLE_FACT_KINDS`, `NON_DURABLE_FACT_KINDS`, `SELF_CONTAINED_FACT_RULE`) and are composed into **both** the `memory_save` tool description and the extraction prompt. Otherwise the same sentence would be worth remembering when the bot was spoken to and not when it was not. The tool's tuned "push to actually use it" framing is untouched around them.
- **Shared, not copy-pasted:** `loadDay` was private to `summarize.ts`; it is now `loadChatDayTranscript` in the history service, used by both jobs, and `SummarizableMessage` gained `userId` (the summarizer ignores it). Extraction reuses `batchMessages` / `currentSummaryDate` / `summaryDayBounds` rather than restating them.
- **Its own feature id `memory-extraction`** (following `history-summaries` vs `history`), so an operator asking *"what did the bot decide to remember from Tuesday"* can filter to that half alone. Every day is traced with full request/response bodies.
- **Dashboard:** the card is now **"Memory"** (it is no longer consolidation-only), with **two backlog badges** — days-to-read and notes-pending — because they are different units at different stages, and one number would hide which half is behind. **Bug avoided:** `Run now` was gated on `pendingNotes === 0`, which would have left a pile of unread chat-days with no way to trigger the extraction that turns them into notes; it now needs *both* backlogs empty.
- **Tests (+21 → 443 unit ✓, 31 memory integration ✓).** New `extract-prompt.test.ts` (16: roster/id rendering, unstorable speaker kept off-roster, unknown-id rejection, unknown scopes, length bounds, case-insensitive de-dup, same sentence for two people, fenced/junk responses → `[]`). Memory integration (+7, real Postgres): **facts learned from a day the bot was never addressed in** (the whole point), extraction→consolidation reaching a durable document, marker stops a re-read but a new message re-triggers one, today skipped, stranger-id dropped, unregistered sender kept off the roster, traced under its own feature.
- **Verified live against the real local LLM + the operator's real dev history**, not only mocks. The dev server was killed and restarted first, because the scheduler is a boot-bound `globalThis` singleton and HMR cannot replace the captured `runJob` closure — the first `Run now` after editing silently ran the *old* one-pass job (`lastResult` was `"nothing to consolidate"`, with no extraction half). After the restart: `/memory` showed **14 days to read / no notes pending**, `Run now` **enabled** (the `runDisabled` fix, proven on real data — the old gating would have made it dead), the run reached `Running…`, the backlog ticked 14 → 13, and `/debug?feature=memory-extraction` showed a real `extract` trace (28 messages, 27.4s, 8.4k tokens, full bodies).
- **A real bug the tests could not have caught, found by that live run — and it was the same weakness in miniature.** The model correctly harvested a durable fact about a person and `saveMemoryNote` **refused it**: *"No known person has id …"*. Cause: the roster was built from the transcript's `chat_messages.user_id`, but `memory_entries.user_id` references **`known_users`** — and history holds senders that were never registered (imported history does this routinely; the tell is a fallback `User <id>` label). So extraction was offering the model ids it could never store against, and binning good facts. **Fix:** the roster is now the *storable* subset (resolved via `getKnownUsersByIds`); an unregistered speaker stays in the transcript as **context** (what they say is evidence about people who *are* storable) but is rendered **without an id**, so the model has nothing to attribute to. Unstorable speakers are named on the trace (`unstorableSpeakers` + a `warn` step) — otherwise "the day was quiet" and "the bot cannot remember these people" look identical in a note count of 0. Pinned by a unit test and an integration test.
- **Ceiling found here, then closed by the next change (2026-07-16):** the dev DB has **1 `known_users` row against 4 distinct senders in history**, so a *per-person document* can only ever exist for that one person. As first shipped, facts about the other three were dropped. That is what prompted the operator's follow-up — general knowledge is now one injected document, and a fact about someone with no `known_users` row is kept **there**, named, instead of being lost (see the entry above). `known_users` coverage therefore no longer caps what the bot can remember, only how it is filed.
- **Checks:** lint ✓, typecheck ✓, unit 443 ✓, memory integration 31 ✓, build ✓, live run ✓.
- **Pre-existing failure, not from this work** (proved by stashing and re-running on clean `main`): `server/telegram/process-update.integration.test.ts:111` expects un-addressed chatter to leave 0 `bot-messaging` traces but gets 1 — commit `9f04e87`'s analyzer opens a trace on the `needsAnalyzer` path. The test and the code disagree; **left for a separate decision** rather than folded in here.
- **Outstanding, operator's call (2026-07-16):** the pre-fix live run stamped **3 chat-days** (`2026-07-03/04/05`) as read, at 0/0/1 notes, and left **1 pending note**. Asked whether to clear those markers so the fixed roster re-reads them; the operator chose to **leave them**. They stay skipped until their message count changes — deleting those rows from `memory_extraction_days` re-opens them at any time. The other 11 days are untouched and get read correctly on the next run.

**LLM addressing check (user-requested 2026-07-16, done):** the bot now answers when someone calls it **by name** — including the name in another alphabet or an inflected/vocative form ("Ариа, ответь…"). This closes the last-listed feature-1 deferral (the MVP's `addressing-detection` analyzer). Decisions: see the three *LLM addressing check* rows in Decision Notes.

- **Layered, cheapest-first** (`features/bot-messaging/server/addressing.ts`). Order: private → reply → `/command@bot` → @mention → **literal display-name match** (new, free, `source: "name"`) → **LLM analyzer** (new, `source: "analyzer"`). `checkAddressed` stays **pure and sync**: when the deterministic rules find nothing but the message could still be naming the bot, it returns `needsAnalyzer` (undecided) rather than a verdict, and the service settles it. So the pure check keeps its unit-testability and only a genuinely ambiguous group message costs a completion.
- **The name is `getMe.first_name`**, carried on `BotIdentity.displayName` (a required field — `bot-manager.onMessage`, `test/simulate`, and the test mock all supply it). `displayNameMatchable` refuses names under 3 chars or in a generic blocklist (`bot`, `ai`, `assistant`, …): a bot called "Bot" would otherwise answer every message mentioning bots, *and* pay for an analyzer call on each miss.
- **Boundary regex is `\p{L}\p{N}`-based, not `\b`** — a real bug avoided, not a style choice. `\w` is ASCII-only, so an ASCII-boundary regex treats every Cyrillic letter as a word boundary: a bot named **"Бот" would have answered to "работа"**. Pinned by a test. The same lookbehind stops the name matching inside someone else's @handle (`@AriaFanClub`).
- **The analyzer classifies, it does not vote** (`address-analyzer.ts`, pure prompt+parse). The model returns `name_match: exact | other_alphabet | inflected | absent`; `addressed` is derived **in code** from that enum, so a hedging model cannot talk its way into a reply and an unreadable answer is a silent "no". Follows the repo's JSON-only + `extractJsonObject` convention (`chatCompletion` has no `response_format` plumbing; the MVP's json-schema path was not ported). A provider failure → **not addressed**: barging into a group on a failed call is worse than missing one summons.
- **Every analyzer call is traced, verdict either way.** The trace now opens **lazily and once** (`openTrace`), shared by the analyzer/maintenance/reply paths — which also removed a duplicated `startTrace` block. A rejected message records request + response + `addressing check` and settles as `skipped`; an accepted one continues on the *same* trace into the reply. Chatter rejected by the cheap checks still leaves nothing behind. `addressing check` event data changed shape: `{addressed, source, reason}` (was `{addressed, reason: <source>}` — `reason` now carries the analyzer's explanation).
- **Deviation from the MVP, deliberate:** the analyzer prompt omits the MVP's `Sender:` line. The question is whether *the bot's* name is present; the sender's name is not evidence for it, and plumbing a label into the service would duplicate `labelForTelegramUser` across a module boundary for no decision it changes.
- **Tests (+41 → 425 unit, all ✓).** `addressing.test.ts` (+16: name match, case, undecided handoff, captionless media, generic names, the Cyrillic false-positive guard); new `address-analyzer.test.ts` (12: prompt contents, every enum, fenced/prose/shouted answers, unreadable → silent); `service.test.ts` (+9: other-alphabet + inflected → replied, rejected → traced-and-skipped with full bodies, analyzer throws → silent and trace *not* failed, one trace per message, no analyzer call when already addressed or in a DM, "called you by name" hint).
- **Verified against the real local LLM + real DB**, not only mocks (`LLM_LIVE=1 npm run test:integration -- live-flow`, 3/3 ✓ in 27s): "Ариа, ответь одним словом." in a supergroup → **replied**; "Как у вас прошли выходные?" → **ignored, `not_addressed`**. The prompt is the one part unit tests cannot vouch for — its whole job is judging a form no rule of ours enumerates — so both directions are asserted live.
- **Checks:** lint ✓, typecheck ✓, unit 425 ✓, live-flow integration 3 ✓, **`npm run build` ✓** (compiled in 4.2s, 0 warnings, 30/30 static pages). The dev server was live on :3200, so it was **killed, built, and restarted** — a running server is not a reason to skip a check.
- **The live poller is running the new code:** the restart re-bound the boot-time `globalThis` singleton (`Telegram bot @… started (long polling)` in the dev log), so real Telegram traffic now takes the new addressing path — no "restart pending" caveat outstanding.
- **The operator's bot clears the matchability bar** (probed via `getMe` against the configured token): display name is 4 chars and not in the generic blocklist → the free literal-name path is live for it, and the analyzer only backstops it. Worth re-checking if the bot is ever renamed: a rename to something under 3 chars or generic (`Bot`, `AI`, …) would silently disable **both** name paths by design, leaving only @mention/reply/command.

**LLM model attribution fix (2026-07-16, done — found by the operator reading the new Model performance card):** the card showed `gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf` (116 calls) *and* `gemma4:26B` (21). The operator only ever configured `gemma4:26B`. **Both rows were the same model, and the split was our bug — not the provider's.**

- **Root cause: two completion paths disagreed about what `ChatCompletionResult.model` means.** `client.ts` recorded `completion.model || input.model` (the provider's answer); `tool-loop.ts` recorded `input.model` (the requested id), discarding the provider's. So *enabling tools silently changed the recorded model name*. Proof in the data: replies flipped to `gemma4:26B` at `07-13 11:25`, one minute before the settings audit shows `tavilyApiKey` added — the moment a toolset existed, replies went through the loop. Vision and the background jobs never use tools, so they kept recording the provider's answer. Nothing to do with images, multimodal routing, or provider inconsistency.
- **Docker Model Runner is blameless and consistent.** It returns the *same* string on every response: `/models/bundles/sha256/95c8f7ac…/model/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf`. The decisive row: `body.model` = that path while `usage.model` = `docker.io/ai/gemma4:26B` — the provider answered honestly and *we* stored something else. **The digest in the path IS the model id**: `docker model inspect gemma4:26B` → `sha256:95c8f7ac704f…`, identical. DMR resolves a tag to the artifact it loaded and reports that; `gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf` is simply the weights file packaged inside the `ai/gemma4:26B` bundle.
- **Fix.** `ChatCompletionResult.model` is now unambiguously **the requested id** (a call's stable identity — what the operator chose, what matches the dashboard), and new `servedModel` carries the provider's answer instead of discarding it (a drift between the two means the endpoint is serving something else — real information, now visible in Debug). Both paths use one shared `servedModelOf`. New shared `llmUsageOf(result)` replaces **seven byte-identical hand-built `usage: {…}` blocks** across analytics/bot-messaging/history/memory/scheduled-tasks/self-improvement/vision — that duplication is *how* the two paths drifted unnoticed: every site faithfully copied `result.model` while its meaning silently differed. `llmUsageSchema` gained `servedModel`.
- **Historical rows** still hold the served path in `model` (there is no record of what was requested). `attributedModelExpr` renders those as **`bundle 95c8f7ac704f`** rather than the filename: the digest identifies the bundle exactly and maps straight back to the tag via `docker model ls`, whereas the filename is a packaging detail and the tag would be a guess. New calls record the tag, so they merge into one `gemma4:26B` row.
- **Tests (398 unit, +8).** `client.test.ts`: requested-id identity + `servedModel` from a real DMR bundle path, absent when the provider reports nothing, `llmUsageOf`, `servedModelOf` edge cases. `tool-loop.test.ts`: a new `chatCompletionWithTools` suite (mocked OpenAI SDK) pinning **the invariant that broke — turning tools on must not change how a call is identified** (`withTools.model === plain.model`). **Verified the test has teeth**: reverting `client.ts` to the old line makes it fail with exactly the operator's mismatch (`expected 'docker.io/ai/gemma4:26B' to be '/models/bundles/sha256/95c8f7ac…'`), and pass with the fix.
- **Verification.** Read side confirmed live on the operator's dev server: the card now renders `bundle 95c8f7ac704f`, matching their `docker model ls` MODEL ID. **Write side not confirmed end-to-end**: the schedulers and Telegram poller are `globalThis` singletons bound at boot, so HMR does not replace their captured `chatCompletion` — new calls keep recording the old way until the operator restarts the dev server. Covered by the unit tests above instead.
- **Lesson recorded:** two earlier messages in this session blamed DMR for "inconsistent labelling" before checking the raw `responseBody` and the digest. The raw bodies were in the traces the whole time (`debug-show-full-raw-bodies`). Read the stored evidence before attributing a bug to a third party.

**Analytics rework (user-requested 2026-07-16, done):** four operator-driven corrections to the analytics dashboard, plus the bug that prompted them.

- **The bug that started it:** "Mood of the day" read *"Weighted across 2 day(s)"*. `sourceDays` was set from `days.length` — the roll-up's rows are **(chat, day) pairs**, so a *global* day bucket returns one row per active chat and reported two chats as two days. Now `distinctDays()` (a `Set` of `insightDate`). Regression test: two chats on one day → `sourceDays === 1`, `messageCount === 4`.
- **Self-healing removed, explicit regenerate added** (user decision). Both scans are gone: the missing-period reconciliation (`listAllInsightDays` × `periodsForDay` minus `listExistingPeriodKeys`) and the day-level re-score on message-count drift. A day is now owed **only when it has never been scored**, so the nightly token spend is a function of visible state. Correcting a score is an operator action: `regenerateAnalyticsInsights` + `POST /api/analytics/insights/regenerate` + a `RegenerateCard` (period + bucket picker, two-step destructive confirm). Semantics per the user: **always everything** — the day scores *and* the roll-ups are dropped for the chosen period, then recomputed by a full LLM pass. Deletion of roll-ups is deliberately **wider than the requested bucket** (`periodOverlapFilter` compares each stored row's own first/last day): dropping a day invalidates every period containing it, at every granularity. Deleting the day rows is also what re-arms the work — a half-failed regenerate is picked up by the next nightly run through the ordinary unscored-day path, so it fails safe. Routed through the scheduler's `pendingRegenerate` so it reuses the advisory lock, progress reporting, and job status rather than running beside them.
- **Per-card filters** (user decision: period tabs **+** chat/user, per card). The global URL filter bar (`AnalyticsFilters.tsx`) is deleted. Each card owns its filters and fetches itself via new `useCardData` + `FilterableCard` + a shared `SegmentedControl` primitive. `getMetrics`'s single payload is split into per-card reads (`getMetricTotals`, `getSeries` with a `section`, `getSystemStats`) behind `GET /api/analytics/metrics|series`, so a card that moves re-queries only itself. The four traffic tiles share one filter set (agent call: a filter bar per tile would exceed the tile). Exceptions per the user — **Bot health, Model performance, Top users** take no filters and cover **all history**; they stay server-rendered.
- **Chat health → Bot health**, reworked (user decision): the composite `Health n/100` badge, Active users, and Feedback tiles are **gone**. The score averaged satisfaction, error rate, and latency using weights nobody chose; the other two duplicated the Users tile and satisfaction. Three honest measurements remain. `avgReplyLatencyMs` is now scoped to `bot-messaging`/`reply` calls — it previously averaged *every* LLM call, so nightly summaries and image descriptions inflated the "Avg reply" figure.
- **Model performance by request type.** `getModelStatsRaw` groups by **(model, feature, action)** — the trace's own taxonomy — instead of by model alone, with `percentile_cont` p50/p95 alongside the mean, because a mean over a heavy-tailed mix reports which workload happened to run. The model name is normalized **in SQL** (`normalizedModelExpr`, mirroring `normalizeModelName`, same JS↔Postgres agreement pattern as `period.ts`): percentiles are computed by the aggregate, and two groups' medians cannot be merged in JS afterwards. The table nests request types under each model and shows `—` for model-level latency by design.
- **Drift, examined and accepted (user, 2026-07-16).** The operator asked whether running the job mid-day could freeze a partial day. It cannot: `listDaysNeedingInsight` filters `insight_date < today` in the configured timezone (the same tz that buckets `sent_at`), so only finished days are ever scored — which is what makes "a scored day is final" safe. The real exposure is different: messages *can* land on an already-finished day via CSV import (`/history/transfer` writes the CSV's own `sentAt`), message edits, or a timezone change re-bucketing boundaries. That is exactly what the deleted `message_count` self-heal used to catch. Offered a read-only staleness signal (live-vs-stored count → a badge + "regenerate stale days"); **user chose no machinery — regenerate is enough**. So drift is silent by design: after a history import, affected days keep their old scores until someone regenerates the period. Also declined: a re-scorable partial "today" (finished days only stands). Accepted consequence recorded here so the next agent does not "fix" it. Only change made: the insight cards now name the bucket they show (`periodLabel` → "Day 2026-07-15", not "the day"), because the newest day bucket is normally *yesterday* and a card reading "Mood … of the day" implied today. `PERIOD_NOUN` deleted (no callers left).
- **`year` is now a first-class granularity** (user decision) — `day/week/month/year/all` through `types.ts`, `period.ts` bucket math, the SQL date filter, and the insight roll-ups (a scored day now writes 10 roll-ups, not 8).
- **Shared-SSE fix (real bug, found by driving the page).** `/api/events` is designed as *one connection per tab*; giving each card its own `EventSource` meant 9 concurrent streams against the browser's ~6-per-origin HTTP/1.1 limit, which starves the page's own fetches. New `components/realtime/event-stream.ts` is a ref-counted singleton stream; `useLiveEvent` (new, extracted) fans out from it and `useLiveRefresh` is now a thin `router.refresh()` consumer of it. Also moved `ApiOkBody` from server-only `server/http.ts` to client-safe `lib/api-error.ts` beside `ApiErrorBody`, so client code can read the success envelope without reaching through the server wall.
- Tests: `analytics.integration` rewritten (16 ✓) — the `sourceDays` regression, request-type grouping + percentiles, reply-only latency, no-score health, year buckets/roll-ups, no-re-score-on-count-drift, and four regenerate cases (drop+recompute, wider roll-ups rebuilt, days outside the period untouched, `all/all` re-scores everything).
- **Verified against the operator's real dev data (server-side, not in-browser).** The Browser pane was wedged all session (navigate/screenshot/JS all timed out, including against a freshly restarted server; a control navigation to untouched `/settings` never reached the server) — so verification was done by fetching the dev server directly from Node (`dangerouslyDisableSandbox`, which *does* reach `localhost:3200`; the `dont-clobber-running-dev-server` note about curl does not apply to this path). Results: `/analytics` **200**, 114 KB; **9 `role="radiogroup"`** = 8 per-card period bars + the regenerate picker, with 8 `aria-label="Period for …"`; every card title present; **`Health n/100` absent**. Bot health renders exactly three tiles (Satisfaction 67% · 2 up/1 down, Error rate 0% · 0/35, Avg reply 12.4 s). Model table renders `Model / request type | Calls | Avg | p50 | p95 | Tokens/s | Prompt | Completion` with request types nested and `—` for model-level latency. Series API correct at every granularity (day 30 / year 10 / month 24 / week 26 buckets) and **mood at week returns 26 buckets with only 3 non-null points — the null-gap handling works** (unscored periods are gaps, not zeros). Scoping real: global all-time 1320 msgs vs one DM chat 7 (`scope=chat`) vs one user 451 (`scope=user`).
- **What the real data proved about the two reworked cards.** For the main model (92 calls), request types split: `History summaries · summarize` avg **65.1 s** (p50 65.8 / p95 111.2), `Analytics insights · insights` **16.9 s** (p50 12.7 / p95 38.2), `Vision · describe` **13.8 s**, `Bot messaging · reply` **8.5 s** (p50 6.8). The old single per-model mean was **~27 s** — a figure matching no workload the model performs; and the old all-calls "Avg reply" tile read **~24.8 s** against the reply-only truth of **12.4 s**, i.e. the dashboard overstated reply latency ~2×. Confirms the operator's premise (vision ≈ 1.6× a text reply) and that the mean was hiding the tail.
- **Regenerate executed for real against the dev LLM, and it proves the original bug end-to-end.** (Operator, 2026-07-16: the dev LLM is **local self-hosted — tokens are free**, so *"you can test as much as you want"*. Earlier ledger entries gating verification on token spend were based on a cost that does not exist; do not write that gate again — see `dev-llm-tokens-are-free`.) `POST /api/analytics/insights/regenerate {granularity:"day", bucket:"2026-07-14"}` → run summary **"2 day score(s) dropped, 2 day(s) scored, 15 period(s) rolled up"**. That summary *is* the diagnosis: **two** day scores existed for one date because two chats were active, and those two (chat, day) rows are exactly what the old `days.length` counted as "2 days". 15 roll-ups = 5 granularities × (global + 2 chats). The card from the operator's screenshot went **`sourceDays=2` → `sourceDays=1` with `msgs=137` unchanged** (mood 45→40, re-read by the LLM). A separate `day 2026-07-15` regenerate moved week `4→3` and month/all `14→13`, message counts identical (217 / 1319) — one date in each range had two chats. It also rebuilt `month`/`year`/`all` from a **day** request, confirming `periodOverlapFilter` live.
- **Correction to an earlier claim in this entry's first draft.** "`year` roll-ups populated" and "`sourceDays` fix confirmed on real rows" were both wrong when first written: `computedAt` showed those rows predated the change. The `year` row was a **stale leftover from the first-cut year implementation** (removed 2026-07-15, rows never cleaned), and `day 2026-07-15` reads `sourceDays=1` under *either* code because only one chat was active that day. The fix is proven by the regenerate above and by the integration test, not by reading pre-existing rows. Lesson for the next agent: check `computedAt` before treating a stored row as evidence your code produced it.
- **Still unverified:** only the *visual* layout of eight filter bars (spacing/wrap at real widths) and the regenerate card's two-step confirm — no browser could be driven this session.

**Background Jobs page (user-requested 2026-07-16, done):** a consolidated **`/jobs`** dashboard showing every background job (running / scheduled / idle / paused / stopped) in one place, with **live progress for whatever is running now** — the current step **and** an `n / total` bar. Decisions (user, AskUserQuestion): **full progress instrumentation** and the page lists **the 6 background jobs only** (not the Telegram bot / other services). New shared progress channel: pure `server/jobs/progress.ts` (`JobProgress = {step, current?, total?}`); both scheduler primitives gained `progress` on their status snapshot + a `reportProgress` on the run context (`idle-scheduler.ts` `JobRunContext`, `interval-scheduler.ts` new `IntervalRunContext`, cleared to null when the run settles), fanning out over the existing `onStatusChange`→`publishEvent` SSE path for free. Each of the 6 job bodies now reports per-unit progress (vision per media, tasks per due task, memory per person/note, summary per chat-day, analytics per day/period, self-improvement per fold). New `features/jobs/*`: client-safe `types.ts` (`JobView`), server `registry.ts` (`getAllJobs` — calls each feature's existing `getXJobInfo`, normalizes idle/interval status + backlog/pause into one `JobView` via **pure, exported, unit-tested mappers**), UI `JobsBoard.tsx` (subscribes to all 6 job topics at once) + `JobProgressBar.tsx`. Shared reuse: `useLiveRefresh`/`LiveIndicator` extended to accept **multiple topics**; the shared `JobStatusCard` gained an optional `progress` slot and a `detailsHref` link. Nav gained a **Background jobs** item. **No new traces / Debug page** (deliberate, honest deviation from the generic feature-contract checklist): the board performs no mutating action of its own — "Run now" reuses each feature's existing already-traced run endpoint, and each row links to its feature page. Tests: `features/jobs/server/registry.test.ts` (mapper normalization: activity derivation, backlog, last-run + progress passthrough, paused/no-LLM notices, errored rows) + progress-channel cases added to `idle-scheduler.test.ts`/`interval-scheduler.test.ts` (→ 390 unit, all green). Verified live on 3200: `/jobs` renders all 6 jobs with correct badges/next-run/backlog/last-result/Details; "Run now" on Analytics flips the row **Running** live over SSE (badge + backlog + "1 job running now" all update with no reload). **Live progress bar not captured in-browser this session** — the interval/idle scheduler singletons started at boot predate this change (HMR preserves `globalThis` singletons across edits, so their running instances lack the progress channel — confirmed: `GET /api/history/summaries` returns a `status` with **no `progress` field**), and the fresh-code schedulers had their backlogs drained by the verification runs. A **dev-server restart** makes every scheduler new-code and renders the live bar (also arms the two that currently read **Stopped**). Risk: none functional; only that live progress is unverifiable in-browser until the operator restarts the dev server.

**Per-chat/group reply language (user-requested 2026-07-15, done):** each chat may have an operator-configured reply language; unset → default **English**; the bot is **strictly** instructed to reply in that language, overriding the language of the incoming message, quoted text, history, tool output, and the active personality. Stored as a nullable free-text `language` column on **`known_users`** and **`known_groups`** (migration `0018`) — a private chat's id equals the user id, so a user's column is their DM language; passive profile upserts never touch it (same as `notes`/`aliases`). Shared `lib/language.ts` owns the default, normalization, `resolveRequiredLanguage` (unset → English), the strict `buildLanguageInstruction`, and the `languageField` zod input. Configured on the existing per-chat admin surfaces (user decision — **not** a separate page): a **Language card** on `/groups/[chatId]` and an inline **DM language** column on `/users`, both saving via the existing `PATCH /api/groups|users/[id]` (now dispatched by whichever field the body carries, via new `readJsonBody`), each a `update-language` traced action. Resolved per reply in `process-update` (group → group's column, private → user's column) and injected by the bot-messaging service as the **final system directive before the current turn** (a `language directive` trace step); **scheduled-task fires** honor it too (chat-id sign selects the registry). Tests: `lib/language` unit; schema unit (both features); integration `updateLanguage`/`get*Language` incl. survives a later profile upsert; bot-messaging directive-injection + omit-when-absent unit.

**Priority 11 — Analytics dashboard (done, 2026-07-15):** a rich stats dashboard at **`/analytics`** (ECharts). The period selector is **day / week / month / all-time** and drives **every** metric. **Numeric metrics are aggregated live with SQL** (`date_trunc` + `GROUP BY` over `chat_messages` / `trace_events` / `known_users` / `message_media`) — no stored rollups, so they are exact and self-heal on edits/imports: message volume (human/bot), **tokens processed (prompt) vs generated (completion)**, active/new users, per-model **speed** (avg latency, tokens/s) + token volume, and deterministic **chat health** (👍/👎 satisfaction, error rate, reply latency → a composite score). Weeks are ISO weeks (Monday-keyed). Tokens are the conversation's (`feature='bot-messaging'` reply traces) so they read as processed/generated and drill down by **chat** (trace `correlation_id = <chatId>:<msgId>`) or **user** (trace `trigger_actor`). Drill-down is **global + per-chat + per-user** (URL-param filters → server re-query, the SSR-first pattern). **LLM-derived insight** (the only precomputed part) comes from a **nightly job** (`features/analytics/server/insights.ts`, the shared interval-scheduler + advisory-lock model): one LLM call scores each finished chat-day's **mood** (0–100) + **top topic** + **word of the day** → `chat_day_insights` (self-healing on message-count change, like `chat_summary_days`), then a roll-up pass writes **word of the period + top topic + weighted mood** into `period_insights` for **every period the day touches — day, week, month, all-time — × global/per-chat** (a single-day roll-up copies the scored word/topic; no LLM). So "word of the day/week/month/all time" and "most-discussed topic" exist at every granularity the selector offers. Fails **closed** — a garbled response leaves stored rows untouched. New feature module `features/analytics/*` (pure `period.ts`/`mood.ts`/`format.ts`/`types.ts`, server `repository.ts`/`metrics.ts`/`insights.ts`/`prompt.ts`/`scheduler.ts`), routes `GET /api/analytics/metrics|insights` + `GET/POST /api/analytics/insights/run`, UI `Chart.tsx` (client-only ECharts via `next/dynamic({ssr:false})`, validated per-mode palette + light/dark), `AnalyticsCharts`/`AnalyticsFilters`/`AnalyticsPanels`/`AnalyticsJobCard`. Live over the new `analytics` SSE topic; shared Debug at `/debug?feature=analytics-insights`; migrations `0019` (+`0020` for the per-day `word`). Two SSR gotchas hit and fixed (see session log): the shared `JobStatusCard` must be driven from a **client** wrapper (never a Server Component with JSX `badges`/`notice` props), and ECharts must be kept off the server entirely. Tests: `period`/`mood`/`prompt` unit (incl. ISO-week math) + `analytics.integration` (metrics aggregation + token chat-scope + model-name merge; insight job produces/rolls-up across all four granularities, idempotent, self-heals, fails-closed). **Not run (operator's call):** a real "Run now" (spends tokens on their data) and the boot-bound scheduler start (needs a dev restart — shows **Stopped** until then). **Reworked same session after operator feedback:** the first cut shipped hour/day/month/year/all periods, insights only at month/year/all, and a "characters" metric — corrected to day/week/month/all everywhere, insights at every period, and tokens.

**Priority 10 — Memory feature (done, 2026-07-15):** durable knowledge across conversations. Storage is **split by scope** (user decision): `user` memory is **one merged document per person**, *injected* into the replies of the chats they take part in; `general` memory is **individual embedded fact rows**, *retrieved* by tool and never injected. The model writes with a **`memory_save`** tool mid-reply, notes queue in `memory_entries`, and a **nightly job** folds them in — one LLM merge per *person* (so contradictions are resolved by rewriting the document, not appending to it) and one reconcile per *general note* (insert/skip/replace against its most-similar existing facts). The job **fails closed**: an unusable model response leaves memory untouched and the note pending. **Memory is strictly what survived consolidation** (user correction): the pending queue is **neither injected into replies nor readable by the tools** — nothing is lost by that, since a note saved today was said in today's conversation, which every reply already carries verbatim via the 24-hour history window, and it buys the invariant that *what a tool returns is exactly what the operator sees stored*. Tools `memory_save`/`memory_get`/`memory_search` (hybrid RRF across both consolidated scopes); `memory_save`'s description is written to drive **active, proactive** use (it is the only way anything is remembered — an unsaved fact is lost permanently); a `user` fact's subject is checked against known users, so a hallucinated id is rejected rather than filed under a stranger. Reply injection is a new `loadMemory` dep traced as **`long-term memory loaded`**, injected right after the chat context. `/memory` dashboard (shared `JobStatusCard`, pending queue, per-person documents, general facts — all editable, with re-embedding on edit) live over a new `memory` SSE topic; migration `0017`. See the top session-log entry, which also records **two real bugs the tests caught** (the general-fact candidate lookup was vector-only, so unembedded facts could never be superseded; and its lexical half ANDed terms, so a correction never matched the fact it corrected) and a **shared fix**: `test/db.ts`'s truncate list is now derived from the Drizzle schema instead of being hand-maintained. **Scheduled-tasks bug fix (2026-07-15, user-reported "never got a message"):** the poller was ticking fine but **maintenance mode pauses every fire**, and that was invisible on the dashboard — an enabled task with an elapsed run time simply never arrived and the page gave no reason. Per user decision the blanket pause **stays** (maintenance means no scheduled message reaches any chat); what changed is that `/scheduled-tasks` now shows a **Task poller card** (Paused badge, overdue count, a notice naming maintenance as the cause and Settings as the fix) and badges each overdue row "Overdue — firing paused / Was due: … — not delivered". The four background-job status cards (vision backfill, summaries, self-improvement, tasks) are now **one shared `components/jobs/JobStatusCard.tsx`** with a `notice` slot for "why this job is not doing its work". The fire path itself was never broken — its simulated-fire integration tests pass — so the operator's overdue tasks fire on the next tick once maintenance is off. **History CSV import/export (done, user-requested):** a `/history/transfer` page (linked from History) with operator-configurable column mapping + data preview on import, duplicate-skipping writes, chat-scoped or all-chats export, and traced imports — see the top session-log entry, which also records a **dev-environment fix**: the dev `DATABASE_URL` points at the old MVP database, whose pre-existing `chat_messages` table had silently blocked migration `0006` (`CREATE TABLE IF NOT EXISTS`) so history reads failed there; the operator dropped that table and `0006`'s DDL was replayed by hand, so the dev DB now serves history correctly (empty mirror). **Priority 2 — system & personality prompts (done):** the base system prompt is a fixed code constant (`BASE_SYSTEM_PROMPT` in `features/bot-messaging/server/prompt.ts`); the operator manages personas as a **full personalities CRUD feature** (user decision — corrected from an initial single-field approach). A `personalities` table (migration `0005`: id/name/prompt/timestamps) + `settings.active_personality_id` (FK, `on delete set null`). New `features/personalities/*` (repository/schema/service/ui) with a **`/personalities` page** (create/edit/delete + set-active) and **`/personalities/debug`**; routes `GET/POST /api/personalities`, `PATCH/DELETE /api/personalities/[id]`, `PUT /api/personalities/active`; every mutation traced. Composition (`buildSystemPrompt`/`hasPersonality`, pure) is unchanged: base alone, or base + `---\nAdditional instructions:\n<persona>`; the bot-messaging service records a **`system prompt composed`** step (`personalityApplied` + full composed prompt) between `addressing check` and `request`; the runtime injects the **active** personality's prompt via `getActivePersonalityPrompt()`. Verified live: created a persona on `/personalities`, set it active (Active badge + `activeId` via API), deleted it (list emptied and active auto-cleared via the FK), all four mutations traced `success` on `/personalities/debug`; no console errors. **Known users + owner-by-dropdown**: a `known_users` table (migration `0004`) capturing everyone who messages the bot, a `/users` page with inline alias editing, and the owner is now chosen from a **dropdown of known users** (id stored directly — the earlier lazy @username→id resolution is removed). **Maintenance mode + owner checks** built and verified live (a pure `bot-messaging/policy.ts`; blocked-but-addressed messages traced as skipped). The **shared Debug UI** is now built and verified live — the last feature-contract gap for both `settings` and priority-1 `bot-messaging`. A global `/debug` page (filter by feature/status, pagination, "Download all") plus a shared `/debug/[id]` detail view (metadata panel, error panel, ordered event timeline with LLM usage, per-trace JSON download) and a feature-scoped `/settings/debug`. Backed by `server/trace/service.ts` (list/detail/bundle) over the existing recorder/repository, thin `app/api/traces/**` handlers, and reusable `components/debug/*`. Verified live against the running dev server on real recorded traces: list renders 11 traces; a bot reply detail shows LLM usage (`prompt 38 · completion 184 · total 222 · 5741ms`); an error trace shows the error panel + timeline; `/settings/debug` shows only settings traces; single + filtered bundle downloads return the `llm-tg-bot/trace-bundle@1` envelope with attachment headers; no console errors.
Realtime: the dashboard now updates **live over SSE** (user decision — not polling/WebSockets). Shared layer: in-process `server/realtime/hub.ts` pub/sub, `GET /api/events` SSE stream, `useLiveRefresh`/`LiveIndicator` client; the trace recorder publishes on create/settle. Verified live: with the page untouched, a newly recorded `test-connection` trace appeared at the top of `/debug` on its own; the `/api/events` stream stays open (200); no console errors. Debug rows are now fully clickable (stretched link) — clicking any cell opens the trace.
**Priority 3 — History feature (done):** a **1:1 conversation mirror** (`chat_messages`, migration `0006`) capturing every human message and every bot reply with full metadata (chat id, Telegram message id, sender id, reply-to pointer, content, sent/edited/deleted timestamps). New `features/history/*` (repository/schema/format/service/ui). Messages are captured **passively** on every incoming message (even un-addressed group chatter) in `bot-manager.onMessage`; the delivered reply is mirrored via a `recordReply` dep. Per reply, `getConversationWindow` loads the **current UTC day's** messages and injects them as **structured prior turns** (`user`/`assistant`) between the cache-stable system prompt and the current message — the bot-messaging service records a `history window loaded` step. In groups, human turns are prefixed with the sender's known-user label. **Edits** are mirrored (`bot.on("edited_message")` → `applyMessageEdit`, traced). **Deletes:** the Telegram Bot API delivers no deletion update for ordinary chats, so user-initiated deletes cannot be mirrored — a `deleted_at` column exists to represent deletions we *can* know about (bot's own / Business-connection events) and the constraint is recorded in Decision Notes. Pages: `/history` (chat list), `/history/[chatId]` (full mirror with edited/deleted badges), `/history/debug` (shared `TraceExplorer`, edit traces). Verified live: seeded two chats → `/history` lists both (most-recent first, correct counts), `/history/777` shows the metadata mirror incl. reply pointer + an `edited` badge, `/history/debug` renders; no console errors; dev DB left clean. Base system prompt gained a short Conversation section (history-awareness).
**Priority 4 — MCP tools basic support (done):** tools use the **real MCP SDK** (`@modelcontextprotocol/sdk`, in-process — user decision, MVP parity): one shared `McpServer` with per-feature tool registrars, linked to a `Client` over an in-process transport pair (`server/mcp/*`: `in-process-transport`, `registry` `BotMcpRegistry`, `openai-tools` conversion, `context` per-turn `AsyncLocalStorage` chat binding, `runtime` `globalThis` singleton). A **bounded, stall-guarded tool-call loop** (`server/llm/tool-loop.ts` — pure `runToolLoop` core + `chatCompletionWithTools`) appends tool results to the same `messages` array the history window feeds, so a reply that needs no tool is still a single cache-friendly inference. The **first history MCP tools** ship (user decision): `history_search` + `history_get_in_range` (`features/history/server/mcp-tools.ts`) — deeper-than-today lookups scoped to the current chat via the tool context (the model never passes a chat id). **All registered tools are always available** — there is **no per-tool on/off** (user decision, follow-up 8): the runtime always offers every registered tool via `getToolset()`. The **`/tools` page** is a read-only registry listing (grouped by feature); `GET /api/tools`. Tool **calls** are recorded as full `external_call` events on the bot-messaging **reply** trace (args + result), so they show in `/debug` — the MCP-tools feature owns no traces of its own, so it has no dedicated Debug page. Verified via the test suite (the `getToolsView`/`getToolset` unit test drives the real in-process registry end to end) + typecheck/build; an earlier live check confirmed the page renders and traces record before the on/off mechanism was removed. The remaining feature-1..4 gate is an operator-run live LLM+token round-trip.
**Priority 5 — Search MCP tool (done):** a Tavily-backed **`search_web`** MCP tool, registered through the same `server/mcp` registrar pattern (`features/web-search/*`: pure `types.ts`/`format.ts`, server `search.ts` (`runWebSearch` — Tavily `POST /search`, `search_depth: basic`, `include_answer`, injectable `fetch`, never throws → always a model-ready success/failure context) + `mcp-tools.ts` (`registerWebSearchMcpTools`, `readOnlyHint`/`openWorldHint`)). Wired into `server/mcp/runtime.ts`, so it is **always available** (no on/off) alongside the history/known-users tools. The **Tavily API key lives in DB-backed settings** (`config-in-db-not-env`): a masked `settings.tavily_api_key` column (migration `0008`), server-only `getWebSearchApiKey()` read **at call time** (a key change takes effect without re-registering), client `webSearchConfigured` boolean, and a **Tavily API key** field on the Settings form (write-only, mirrors the LLM/bot-token secrets; redacted from traces). When the key is unset the tool returns a clear `isError` "web search unavailable" message rather than a broken search. Tool **calls** are traced as `external_call` events on the bot-messaging **reply** trace (same as the history tools) — the feature owns no mutations, so no dedicated Debug page. Verified live: `/tools` lists `search_web` under a **Web-Search** group; `/settings` shows the Tavily API key field; no console errors. Server-side masking/persist/clear/redaction proven by integration tests. Not verified: a real LLM tool-call + live Tavily round-trip — shares the operator-run gate.
**Priority 6 — Visit/read link MCP tool (done):** a Playwright-backed **`read_page`** MCP tool that reads ONE public web page in headless Chromium and returns its readable text for the model to answer from (user decision: **Playwright / MVP parity** over lightweight fetch — see Decision Notes). New `features/link-fetch/*`: pure client-safe `types.ts` (`FetchedPage`) + `format.ts` (`formatLinkFetchContext`/`formatLinkFetchFailure` — model-ready result text, always honest on failure) + `url-safety.ts` (`isSafePublicUrl` SSRF guard — blocks non-http(s), credentials, localhost, the Docker host gateway, private/loopback/link-local IPv4+IPv6; `normalizeUrl`); server-only `server/playwright.ts` (shared headless Chromium on a **`globalThis` singleton** — `getSharedChromium`/`closeSharedChromium`/`fetchPageWithPlaywright`, per-read isolated context, 60s nav timeout, 12k-char text cap), `server/fetch-link.ts` (`fetchLink` — the boundary: normalize → SSRF-check → read → format; **never throws**; injectable `fetchPage` for tests), `server/mcp-tools.ts` (`registerLinkFetchMcpTools`, `read_page`, `readOnlyHint`/`idempotentHint`/`openWorldHint`). Registered in `server/mcp/runtime.ts` under feature `link-fetch`, so it is **always available** (no on/off) and every call runs in its own **`mcp-tools-link-fetch`** trace scope automatically (via the existing `tracedToolCall` wrapper) — no dedicated feature Debug page, matching the other read tools. Added `mcp-tools-link-fetch` to `lib/features.ts` (label "Link reader tool") and `serverExternalPackages: ["playwright"]` to `next.config.ts` (never bundle the native browser pkg). Verified live: the `/debug` feature filter now lists **"Link reader tool"** (`mcp-tools-link-fetch`); no console errors. The `/tools` group + a real LLM tool-call round-trip require a dev-server restart (boot-time MCP registry singleton) + the operator-run live-bot gate (no credentials created).

**Priority 7 — Bot messaging: vision (done):** the bot receives image/sticker/media and reads it with the **same configured model** (user decision — no separate vision model). New `features/vision/*`: pure client-safe `types.ts` (`MediaKind`/`ImagePayload`/`MediaAnnotation`/`MediaView`), `detect.ts` (`detectMessageMedia` — photo/sticker(static→webp, animated/video→thumbnail)/image-document/animation(gif→file, else thumbnail)/video-frame; `findReplyMediaMessage` depth-4; `messageHasVisionMedia`), `describe-prompt.ts` (the exhaustive MVP describe prompt), `format.ts` (`renderMediaSuffix`, `toImagePart`, `buildVisionContent`); server-only `normalize.ts` (`sharp` → bounded JPEG, `VISION_MAX_DIMENSION=768` code constant), `telegram-files.ts` (token-based file download), `repository.ts` (`message_media` table, migration `0009`), `describe.ts` (`buildDescribeMessages`), `service.ts`. **Data model:** `message_media` (id/chatId/telegramMessageId/kind/fileId/fileUniqueId/mimeType/**dataBase64**/visionHint/description/**status**/timestamps; unique `(chat_id,telegram_message_id)`, status index). **Lifecycle (user decision):** media is **stored as base64** on ingestion (`status=pending`); media **on the answered message** is attached to the reply pass (the model sees it immediately), then **described and resaved** — `markDescribed` writes the text description, **drops the base64**, sets `status=described`; **other media** (unaddressed/group chatter) stays pending for the **backfill job (priority 8)**. Unloadable media → `status=unavailable`. **LLM multimodal:** `ChatMessage.content` is now `string | ChatContentPart[]` (text/image_url parts); only the current `user` turn carries images; `sanitizeMessagesForTrace` replaces inline base64 with `data:<mime>;base64,<N bytes>` in traces (the real image is on `/vision`, not a base64 wall — deliberate exception to full-raw-bodies for binary blobs). **Runtime (`bot-manager`):** ingests media passively, records media-only messages in history (`recordIncomingMessage` `hasMedia` flag → empty-content allowed), resolves the reply attachment (current message, or a replied-to image with a "asking about the … they replied to" note), and after a delivered reply runs `describeAndStore` for the current message's media (traced under feature **`vision`**). **History transcript** now carries media: past image turns render ` [photo: <description>]` via `getConversationWindow`'s injected `loadMediaSuffixes` (history stays decoupled — the suffix strings are built by the runtime from vision annotations). **Dashboard:** `/vision` page (media gallery — pending rows show the stored image, described rows show the text description; kind + status badges), nav **Vision** item, `vision` SSE topic, shared Debug via `/debug?feature=vision`. Verified live (dev server on 3200): `/vision` renders (nav item, LiveIndicator, Debug link, empty state), `/debug` feature filter lists **Vision**, no console errors. **Not verified live:** a real Telegram photo → reply round-trip — same operator-run gate (real bot token + poller restart; no credentials created).

**Priority 8 — Vision backfill background job (done):** the `pending` media rows (`message_media.status='pending'`, bytes intact) are captioned in the background by an **in-process idle-debounced scheduler** — the newly-decided **shared background-job operating model** (user decision; establishes the pattern for priorities 9–13). New shared primitive `server/jobs/idle-scheduler.ts` (`createIdleScheduler` — job-agnostic phase machine + debounce timer; `onActivity`/`runNow`/`getStatus`/`stop`; cooperative abort via `ctx.isAborted()`) and `server/jobs/lock.ts` (`withAdvisoryLock` — cross-process Postgres advisory lock on a pinned pool connection). The job body `features/vision/server/backfill.ts` (`runVisionBackfill`) wraps the lock, iterates `listPendingMedia` batches, calls the existing `describeAndStore` per row (which drops the bytes on success), respects abort, caps at 200 rows/run, and traces the batch under a new **`vision-backfill`** feature (per-row describes still trace under `vision`). Idempotency = the existing `status='pending'` gating (a described/unavailable row is never re-fetched; `describeAndStore` re-checks before spending an LLM call). Trigger = **idle-debounced (MVP parity)**: `features/vision/server/backfill-scheduler.ts` is a `globalThis` singleton wiring the primitive to the job (45s debounce code constant, LLM conn read fresh per run); `bot-manager.onMessage` calls `pokeVisionBackfill()` on every message to re-arm the wait and yield a running batch to live traffic; `register-node.ts` starts it on boot (arms an initial backlog-clearing run) and stops it on shutdown. Dashboard: a **Backfill card** on `/vision` (phase badge, backlog count, last-run summary, "Run now") backed by `GET/POST /api/vision/backfill`; live via the existing `vision` SSE topic (the scheduler publishes on every status change); shared Debug at `/debug?feature=vision-backfill`. Tests: `idle-scheduler.test.ts` (+6 unit, fake timers: debounce, re-arm, runNow, mid-run abort+re-arm, error, stop → **208 unit**), `backfill.integration.test.ts` (+7: describe-all + run/row traces, idempotent second run, empty-desc→unresolved, abort-early, lock-skip, `withAdvisoryLock` acquire/release + held-skip). Verified live on the running dev server: `/vision` shows the Backfill card ("Idle", "2 media rows awaiting a description", Run now) with no console errors; `GET /api/vision/backfill` returns `{status:{phase:"idle",…},pending:2}`. **Not run:** a real "Run now" against the operator's live pending media (irreversibly drops their stored image bytes + spends tokens — left to the operator) and the idle auto-run/poke wiring, which needs a dev-server restart (scheduler + bot-manager are boot-bound singletons). `next build` not run (dev server live on 3200 — `dont-clobber-running-dev-server`).

**Priority 9 — Scheduled tasks (done):** user-configurable standing directives (`scheduled_tasks` table, migration `0011`) that fire on a wall-clock schedule — the LLM writes an in-character message *performing* the directive and it is posted to the chat. New `features/scheduled-tasks/*`: client-safe `types.ts` + `schedule.ts` (dependency-free `Intl` once/daily/weekly wall-clock math — `computeNextRun`/`describeSchedule`/`normalizeSchedule`, ported from the MVP); server `repository.ts`/`schema.ts`/`service.ts` (CRUD + schedule validation + next-run computation in the operator timezone + trace recording), `fire.ts` (compose base+persona system prompt + directive → generate → deliver → mirror to history → trace under `scheduled-tasks`; capped `recentDeliveries` seeds wording variation for recurring fires), `scheduler.ts` (`globalThis` singleton), `mcp-tools.ts` (5 tools). **Trigger = a new shared in-process periodic primitive** `server/jobs/interval-scheduler.ts` (fixed-interval ticker + overlap guard — the sibling of `idle-scheduler.ts`, since time-based firing can't idle-defer), wrapped by the feature scheduler: each 30s tick, under the `withAdvisoryLock` cross-process lock, scans due tasks, fires each, advances `next_run_at` (a spent one-shot → null → disabled); firing pauses during maintenance. Started from `register-node`. **Creation = MCP tools + dashboard, NOT owner-gated** (user decision — any chat participant manages that chat's tasks): `tasks_create/update/delete/list/get` bound to the current chat via the extended tool context (`chatId`+`userId`+`threadId`); `/scheduled-tasks` page (create with a known-chat picker, edit, enable/disable, delete, "Run due now") live over the `tasks` SSE topic; `GET/POST /api/scheduled-tasks`, `PATCH/DELETE /api/scheduled-tasks/[id]`, `GET/POST /api/scheduled-tasks/run`. New operator `settings.timezone` (IANA, default UTC) + a Settings field. Verified live on the dev server: `/scheduled-tasks` renders with the real chat dropdown (a DM + a group); created a daily task (correct next-run, `success` create trace on `/debug?feature=scheduled-tasks`, 77ms), then deleted it (dev DB left clean); no console errors. **The full fire path is proven by a simulated-fire integration test** (`runDueScheduledTasks` extracted as the testable due-run core; a capturing reply sink + deterministic generator drive due-scan → fire → deliver → mirror-to-history → advance against real Postgres, no bot/LLM) — covering delivery, wording variation, one-shot self-disable, empty-output skip, and nothing-due. The only sliver not exercised in-process is the thin grammy `sendChatMessage` adapter calling Telegram's API.

**Self-improvement system (user-requested 2026-07-14, extended 2026-07-16, done):** the bot learns from 👍/👎 reactions on its replies. New `features/self-improvement/*`: a reaction on a bot reply opens a `users_feedbacks` row and posts an **inline options menu** (5 predefined like/dislike options + free-text "Other"; in groups only the reactor can answer — presses from others get a toast; "Other" → "reply to this message", captured by the pipeline and **not** answered by the LLM). An answer leaves **no confirmation message** (user decision 2026-07-16): the menu is deleted and a button press is acknowledged by a **toast** only. Each answer is then **self-reflected on** — an LLM pass reads the reply's own trace (prompt, tools, reply) plus the feedback and writes what went right/wrong **and why** onto the same row (`reflection`), which is what both folds reason from. A **daily incorporation job** (interval-scheduler singleton, due at `settings.self_improvement_run_time` in the operator timezone, default 04:00, advisory-locked, "Run now" on the dashboard) folds completed feedbacks — **one LLM call per feedback**, persona stated once per call, exchange text from the history mirror — into versioned **`users_communication_preferences`** (per user, seeded from the previous version) and versioned global **`self_corrections`**, stamping each feedback with the versions that incorporated it. Every reply then injects the **latest correction into the system prompt** (like the personality) and the **sender's latest preferences as a system context** (like the known-user block), both traced. `model` columns are informational and always a **clean model name** (`normalizeModelName` strips `docker.io/ai/…` prefixes; resolved from the reply trace's `usage.model`, falling back to settings). Tables in migration `0013`; features `user-feedback` + `self-improvement`; `feedback` SSE topic; `/self-improvement` page (job card, feedback table, preferences, correction) + `GET/POST /api/self-improvement(/run)`; Telegram intake via `allowed_updates` += `message_reaction`/`callback_query` (poller restart needed; groups additionally need the bot to be **admin** to receive reactions — Telegram constraint).

**History is now feature-complete (2026-07-14, user-directed):** it gained **daily topic summarization, pgvector semantic recall, and the `history_recall_topics` MCP tool** — see the top session-log entry. Recall spans the whole conversation: the last 24 hours are injected verbatim, the literal tools (search / date range / by id) handle exact lookups, and the recall tool searches embedded daily topic summaries by meaning for anything older, handing back message ids to read the originals. Embeddings are DB-configured (own URL/key/model, falling back to the LLM connection) with a real probe that verifies the model's vector width against the stored column width.

Next: **Priority 12 — Image generation** (Analytics landed 2026-07-15 as the new priority 11, ahead of Image generation per the user; the remaining order is Image generation → Browser agent → Mood, now 12 → 13 → 14). Image generation: generate images through a configured provider with dashboard/debug visibility and downloadable traces — the provider boundary is the open design question (which is a decision to put to the user, per `decisions-ask-dont-document`), and it should reuse the DB-backed settings pattern (`config-in-db-not-env`) rather than an env key. Flows are verified with the **bot-less simulation harness** (`simulateUpdate` / injected deps against real Postgres) — a real bot token is not a testing gate, only the live Telegram send/receive adapters remain out of in-process scope.

### Session log

- 2026-07-16 (Self-improvement follow-up, user-requested): **feedback answers are
  acknowledged by a toast, and every answer is self-reflected on (done).**
  - **Decisions (user, AskUserQuestion — recorded in Decision Notes):** (1) an
    answered menu is **deleted**, not rewritten to a confirmation ("no need for
    confirmation message after feedback, its annoying"); (2) the reflection runs
    **detached from the Telegram flow, with a backfill in the daily job** (grammy
    handles updates one at a time, so an inline inference would stall the bot for
    every other chat); (3) the reflection reads a **curated rendering** of the
    reply trace, not the raw events (context discipline).
  - **No confirmation message:** `menuConfirmationText` → `MENU_RECORDED_TOAST`; a
    press answers the callback query with the toast and `deleteMenu`s the message
    (new op on the `FeedbackTransport` seam + the grammy adapter,
    `ctx.api.deleteMessage`). The free-text flow has no callback to toast, so it
    sends **nothing** — `process-update`'s `editFeedbackMenu` override became
    `deleteFeedbackMenu`, and the answer is acknowledged by the menu vanishing.
    Both deletes are best-effort at the dep site (Telegram refuses >48h; the
    answer is already stored, so a stale menu is cosmetic and must not fail).
  - **Data model (migration `0023_deep_komodo`, additive):** `users_feedbacks`
    += `reflection` + `reflection_model`, both cleared on a repeat reaction (the
    row reopens, so the old reasoning no longer applies).
  - **Self-reflection (`server/reflect.ts`):** `reflectOnFeedback` renders how the
    reply was produced, asks the model what went right/wrong **and why** (persona
    stated once, as in the folds), and stores the text + clean model name on the
    row. Its own `user-feedback`/`reflect` trace records every outcome, so a
    missing reflection is always explained in Debug; it never throws.
    `scheduleReflection` is the detached kickoff from both answer paths (resolves
    the LLM runtime itself; no LLM configured → no-op, the daily job retries).
  - **New `server/exchange.ts`:** `getReplyTrace` (the trace behind a bot reply —
    extracted from `resolveReplyModel`, now its second consumer), `renderExchange`
    (moved out of `analyze.ts`, now shared by the folds and the reflection's
    no-trace fallback, and it carries the reflection line), and `renderReplyTrace`
    (curated: prompt messages, tool calls + results, the sent reply, failures;
    clipped at 3k/message, 1k/tool payload, 16k total).
  - **Folds read the reflection:** `runSelfImprovement` gained a **pass 0** that
    reflects on any completed feedback that has none (deduplicated across the two
    backlogs, counted in the job's live progress bar), then carries the fresh text
    onto both backlogs. A reflection that still fails is **not** a fold failure —
    the feedback folds from the user's words alone rather than being held back.
    Both fold prompts now say they are given the reflection.
  - **Dashboard:** the reflection renders under the user's words in the
    `/self-improvement` feedback table (no new column).
  - Tests: `self-improvement.integration.test.ts` **9 → 14** (+5 new: reflect from
    the reply trace incl. prompt/tool/reply/feedback reaching the call + clean
    model stamping + `relatedIds`; reflect from the exchange alone when there is
    no trace, with the warn event; failed call leaves it null + `skipped` trace;
    no reflection for an unanswered feedback and **no trace at all**; the fold
    backfill skipped for an already-reflected feedback), 4 rewritten for the
    toast/delete flow and the backfill's call count. `menu.test.ts` lost its
    confirmation-text case.
  - **Operator-reported failure + the two gaps it exposed (same session):** the
    operator restarted the bot, reacted 👍, and the flow died on
    `Failed query: insert into "users_feedbacks" …`. Root cause: **the migration
    was generated but never applied** to the dev DB, so new code ran on the old
    schema and `upsertFeedback`'s `ON CONFLICT … DO UPDATE` set columns that did
    not exist. Applied `0023`; the repeat-reaction path works. Two real gaps came
    out of the trace they sent:
    - **The trace could not say why.** `toTraceError` recorded only
      `error.message` and dropped `error.cause` — where Drizzle keeps the reason
      (`column "reflection" … does not exist`). It now walks the `cause` chain
      (`\ncaused by: `, depth-capped at 5, duplicate-suppressed, cycle-safe),
      which improves **every** feature's error traces and closes a gap against
      the recorder's own stated intent. +3 trace integration tests.
    - **The reflection ran blind on the reacted message.** It was a
      *scheduled-task fire* ("Hey. Just checking in.", `reply_to_message_id` null),
      and `getReplyTrace` only followed reply pointers → fell back to the
      exchange, which prints `User message: (not available)`. Fixed via the two
      Decision Notes rows above (settle-with-correlation + producer scoping).
      `renderReplyTrace` needed **no change** — being curated generically, it
      renders a fire trace as-is. +2 integration tests.
  - **Verified live** (dev server on 3200, real Postgres, real local LLM): "Run
    now" → `success :: 1 user profile(s) updated, corrections updated, 1
    feedback(s) incorporated`; the backfill reflected the orphaned feedback in
    9.5s and folded to prefs v3 + corrections v3. Migration `0024` re-keyed the
    historical fire traces (`0f7882bc-…` → `312973896:919`), and the live lookup
    now resolves the **fire** trace where the unscoped one resolved the
    **reflect** trace — the self-reference, demonstrated on real rows.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 439 ✓, integration 235 ✓
    (self-improvement 9 → 16, trace 7 → 10). `build` **not run** — a dev server is
    live on 3200 (`dont-clobber-running-dev-server`); typecheck covers type validity.
  - **Pre-existing failure, not from this work:** `process-update.integration.test.ts`
    > "ignores un-addressed group chatter" expects 0 `bot-messaging` traces but the
    addressing analyzer (commit 9f04e87) opens one. Confirmed failing on a clean
    tree at 39f3396 by stashing this work; flagged separately, left untouched.

- 2026-07-15 (Priority 11): **Analytics dashboard (done)** — a rich ECharts stats
  dashboard, inserted ahead of Image generation at the user's request.
  - **Decisions (user, AskUserQuestion — all four in Decision Notes):** (1) mood =
    **LLM sentiment** + deterministic health; (2) word of the period + top topic =
    **both LLM-derived**; (3) breakdown = **global + per-chat + per-user**; (4)
    **build now**, ahead of Image generation.
  - **Architecture (mine, flagged in the plan and approved).** Numeric metrics are
    **live SQL aggregation**, not stored rollups — `date_trunc(unit, ts at time zone
    tz)` + `GROUP BY`, bucketed by the operator wall clock, with the **exact same
    bucket-key format** produced in JS (`period.ts`, for the dense gap-free axis) and
    by Postgres `to_char` (the repository, for the grouping); the agreement is unit-
    tested. Only the LLM-derived insight is precomputed (nightly job), because it
    costs tokens and can't be recomputed per page view. This honors "idle jobs like
    vision backfill" for exactly the metrics that need it while keeping the numeric
    side exact and self-healing.
  - **Data model (migration `0019`):** `chat_day_insights` (per chat-day mood + top
    topic + `message_count` self-heal trigger) and `period_insights` (month/year/all
    roll-up: word of the period + top topic + weighted mood, keyed
    `(granularity, bucket, scope, chat_id)` with `chat_id=''` sentinel for global so
    the unique key is a clean upsert target).
  - **Two Next 16 / React 19 SSR gotchas cost the live-verify time; both fixed:**
    - **`JobStatusCard` from a Server Component 500s.** The shared card is a Client
      Component; every other feature drives it from a `"use client"` wrapper. I
      rendered it directly from the page (a Server Component) and passed JSX
      `badges`/`notice` props across the server→client boundary — a hard 500 with no
      client-visible message (Next 16 hides the server error, so it was found by
      bisecting the render tree, the API routes all being 200). Fixed with a
      `features/analytics/ui/AnalyticsJobCard.tsx` client wrapper (matches
      `extract-shared-before-second-use`), which required moving the `AnalyticsJobInfo`
      type from the server-only scheduler into client-safe `types.ts`.
    - **ECharts must stay off the server.** Split the pure theme tokens into
      `ui/chart-theme.ts` and load the canvas `Chart` via
      `next/dynamic(() => import("./Chart"), { ssr: false })` so the ~1 MB lib and its
      `window`/`document` access never enter the server render.
  - **Verified live on 3200 (the operator's dev server):** `/analytics` renders 200
    in dark mode with the operator's real data; the three numeric charts paint (3
    canvases); the period/chat/user filters drive a server re-query
    (`?granularity=month&chatId=…` scoped correctly); the three JSON APIs return
    correct shapes; Debug link → `/debug?feature=analytics-insights`. **Not run:** a
    real "Run now" (spends tokens on the operator's data) and the boot-bound
    scheduler start (needs a dev restart — shows **Stopped**; the job logic is proven
    by the 6 integration tests). `next build` not run (`dont-clobber-running-dev-server`).
  - **Reworked same session after operator feedback (3 corrections).** (1) Periods
    are **day / week / month / all-time**, not hour/day/month/year/all — the first
    cut had the wrong set and was missing **week**; the selector drives everything.
    (2) **Word of the period and most-discussed topic exist at every period** (day/
    week/month/all), not only month/year/all — the day scoring now also produces a
    **word** (`chat_day_insights.word`, migration `0020`) and the roll-up writes
    `period_insights` for day/week/month/all × global/per-chat (a single-day roll-up
    copies the scored word/topic, no extra LLM). (3) The **"characters" metric is
    replaced by tokens** (processed = prompt, generated = completion), read from
    `bot-messaging` usage events and chat/user-filterable via the trace
    `correlation_id`/`trigger_actor`. Verified live on 3200: `/analytics` shows the
    Day/Week/Month/All-time selector and Tokens tiles/chart with real data; the week
    view (`?granularity=week`) renders and re-queries server-side.
  - **Production diagnosis + self-heal fix (operator-reported "missing data despite
    Run now").** Read the live deploy's own API (not assumed): the insight job HAD
    run (trace "12 day(s) scored, **6** period(s) rolled up") and `granularity=all`
    returned a real card (word "Gaming", mood 51) — so data was present at
    all/month/year, but the dashboard **defaults to Day**, which was empty
    (`Run now` → `pendingDays:0` → "nothing to compute"). Root cause: the first
    deploy (old code, 6-period month/year/all roll-up) scored the 12 days; the
    reworked build added Day/Week but **Pass 2 only rolled up periods for days it
    re-scored that run**, and those days were already scored — so the new
    granularities never backfilled. Fix: Pass 2 now **self-heals** — it computes the
    periods every scored day *should* have (`listAllInsightDays` × `periodsForDay`)
    minus what exists (`listExistingPeriodKeys`) and backfills the missing ones,
    independent of what was scored this run; a run with 0 pending days still
    backfills, and a steady state (0 pending, 0 missing) still no-ops without a
    trace. Makes any future granularity change auto-populate. Integration test added
    (drop the `day` roll-ups, re-run with 0 pending → backfilled). **Needs a redeploy
    to take effect on production**; until then, the computed insight is visible under
    All time / Month.
  - **Checks:** lint ✓, typecheck ✓, `npm run test` ✓ (376 unit),
    `vitest run --config vitest.integration.config.ts features/analytics` ✓ (7).

- 2026-07-15: **Fixed the Docker boot crash + provisioned Chromium for `read_page`
  on Alpine** (user-reported: after deploy the container logged `An error occurred
  while loading instrumentation hook: Failed to load external module playwright…:
  Cannot find module '/app/node_modules/playwright-core/browsers.json'`).
  - **Root cause (boot crash):** `features/link-fetch/server/playwright.ts` did a
    **top-level** `import { chromium } from "playwright"`. Because `playwright` is a
    `serverExternalPackage` it becomes a real `require` at boot, and this module is
    reachable from `instrumentation.ts` → `registerNode` → the MCP registry graph
    (`runtime.ts` → `registerLinkFetchMcpTools`). Next's file tracer copied only the
    statically-resolvable JS into `.next/standalone/node_modules/playwright-core/`
    (`lib/` + `index.js`) and **missed `browsers.json`**, which playwright-core reads
    from disk on load — so the boot-time `require` threw and the **whole
    instrumentation hook failed**, not just link-fetch.
  - **Fix 1 — lazy load (contains the failure):** `playwright` is now imported only
    as a type at module top, and the runtime value is loaded via a dynamic
    `import("playwright")` inside `getSharedChromium()`. This pulls playwright out of
    the server boot graph entirely, so a browser/provisioning problem can no longer
    crash startup — it is confined to the moment `read_page` actually runs. Matches
    the file's own "expensive to launch" intent.
  - **Fix 2 — ship the full package:** the Dockerfile runner now `COPY`s the complete
    `playwright` + `playwright-core` packages from the builder over the partial traced
    copies, so `browsers.json` (and any other runtime data file) is present.
  - **Fix 3 — Chromium on Alpine (user decision: stay Alpine + system chromium):** the
    runner `apk add`s `chromium nss freetype harfbuzz ca-certificates ttf-freefont
    font-noto-emoji`, sets `ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser`
    (path confirmed against the Alpine `chromium` package contents), and
    `getSharedChromium()` passes that as `executablePath` (unset in dev → Playwright's
    own download, unchanged). Playwright is officially unsupported on musl/Alpine, but
    the distro Chromium + `executablePath` + the existing `--no-sandbox` args is the
    accepted tradeoff for the smaller image.
  - **Files:** `features/link-fetch/server/playwright.ts` (lazy import,
    `CHROMIUM_EXECUTABLE_PATH`, `executablePath` on launch), `Dockerfile` (apk chromium
    + fonts, `CHROMIUM_EXECUTABLE_PATH` env, full playwright package copy). No schema
    or code-behavior change to other features.
  - **Checks:** lint ✓ (0 warnings), typecheck ✓, `vitest run features/link-fetch` ✓
    (19). `npm run build` **not run** — a dev server is live on 3200 and a production
    build would clobber its `.next` (`dont-clobber-running-dev-server`); the fix is
    Docker/standalone-boot behavior a dev preview can't exercise. **Not verified
    in-container:** a real image build + a live `read_page` round-trip against the
    distro Chromium — left to an operator deploy (no image built this session).

- 2026-07-15 (Priority 10): **Memory feature (done)** — durable knowledge the bot
  keeps across conversations, written by the model mid-reply and consolidated
  nightly.
  - **Superseded in part on 2026-07-16 by passive memory extraction** (see Current
    Summary). Decision (4) below — *writes go through a `memory_save` tool +
    nightly job* — described the **only** producer at the time, and that was the
    weakness the operator hit: a tool only runs inside a reply, and a reply only
    happens when the bot is addressed, so the bot remembered nothing from a group
    conversation it was not part of. `memory_entries` now has **two** producers,
    the tool and the nightly extraction pass over the history mirror.
  - **Superseded again the same day by the general-document change** (see Current
    Summary): general knowledge is no longer a set of embedded fact rows read by
    tool, but one merged document injected into every reply. The parts of this
    entry describing general storage, the general reconcile pass, and the general
    half of the tools are **history**. The pending queue, the per-person merge, and
    the fail-closed rule are unchanged.
  - **Decisions (user, AskUserQuestion — all four recorded in Decision Notes).**
    Three of the four have since been **superseded** (2026-07-16); read them as
    history, not as the current design:
    (1) ~~storage is **split by scope** — one merged **document per user**, but
    **individual embedded fact rows** for general knowledge~~ → **both scopes are
    merged documents**; (2) scopes are **`user` + `general`** (MVP parity, no
    per-chat scope) — *still true*; (3) ~~**the relevant people's memory is
    injected** (sender + group participants), while general memory is
    **tool-only**~~ → **both are injected**, general on every reply, and the read
    tools no longer cover it; (4) ~~writes go through a **`memory_save` tool +
    nightly job**~~ → the nightly job still merges, but the tool is no longer the
    only producer — **passive extraction** feeds the same queue.
  - **Why the split storage (superseded 2026-07-16 — the reasoning that lost).**
    User memory is *injected* and read as a whole, so a person must be one coherent
    document; general memory is *retrieved* and grows without bound across every
    chat, so each fact needs its own vector — and one wrong fact must be deletable
    without rewriting everything around it. What this missed: knowledge the model
    must choose to look up is knowledge it mostly does not use, and the unbounded
    growth it feared is held in check by the same nightly merge that has always
    bounded the per-person documents. Both scopes are merged documents now.
  - **Data model (migration `0017_aberrant_frightful_four`):** `memory_entries`
    (the pending queue: scope/user_id/content/chat_id, with CHECK constraints
    binding `scope='user'` ⇔ `user_id is not null`), `user_memories` (one row per
    person: merged document + `vector(1024)` + HNSW), `general_memories` (fact rows
    + `vector(1024)` + HNSW). GIN full-text indexes on both `content` columns were
    **hand-added** to the migration — an expression index has no Drizzle column to
    hang off (same as `chat_summaries`).
  - **The nightly job** (`features/memory/server/consolidate.ts`, feature `memory`):
    one LLM **merge per person** (all their pending notes at once, so the model sees
    the whole document it is rewriting — which is what makes "moved to Lisbon"
    supersede "lives in Porto" instead of appending a contradiction), and one
    **reconcile per general note** (insert / skip / replace, decided against the
    existing facts most similar to it). Fails **closed**: an unusable model response
    leaves memory untouched and the note pending, so a garbage response can never
    erase a document that took months to accumulate. Runs on the shared daily model
    (`interval-scheduler` + `withAdvisoryLock` + `isDailyRunDue`), at the one
    `settings.daily_jobs_run_time`.
  - **Pending notes are not memory yet (user correction, applied same session).**
    My first cut folded the pending queue into both the injected context and the
    tool reads, so that "remember X" would be honored on the very next turn. The
    user corrected this: **the queue is neither injected nor searchable** — memory is
    strictly what survived consolidation. Nothing is actually lost, because a note
    saved today was *said* in today's conversation, and that conversation is already
    carried into every reply verbatim by the 24-hour history window; folding the raw
    note back in merely restated what the model could already read. The rule also
    buys a real invariant: **what a tool returns is exactly what the operator sees
    stored on the dashboard**, with no shadow set of facts living only until the next
    nightly run. Consequence, accepted: a fact becomes recallable *across*
    conversations only once consolidated. (Removed with it: `mergeFactLines`, the
    `pending` flag on `MemoryMatch`, and the repository's pending-queue search.)
  - **Tools** (`mcp-tools-memory` scope): `memory_save`, `memory_get`,
    `memory_search` (hybrid RRF across **both** consolidated scopes — the model
    should not have to guess which scope a fact landed in). Chat/speaker come from
    the per-turn tool context, never the model; the *subject* of a `user` fact is a
    model argument (a fact can be about someone else in a group) and is **checked
    against known users**, so a hallucinated id is rejected to the model rather than
    filed under a stranger where it would never surface.
  - **`memory_save` is written to be actively used (user requirement).** The
    description does not merely permit saving, it pushes for it: this is the ONLY way
    anything is remembered, so an unsaved fact is lost permanently and "I'll remember
    that" without a call is a false promise. A MUST trigger (any ask to remember /
    note / not forget) plus an explicit proactive list (name or preferred name,
    location, work or studies, family and pets, stable tastes, skills, health
    constraints, boundaries, recurring plans, standing instructions about behavior),
    stated as **expected, not optional** — prefer saving a minor fact over losing one
    that mattered. Balanced by a do-NOT list (guesses/vibes, passing moods, jokes,
    insults, one-off plans, chit-chat, re-saving) and a one-fact-per-call,
    self-contained-sentence rule. Per `tools-self-describe-atomic` this lives entirely
    in the tool description; the system prompt neither lists nor describes tools.
  - **Reply injection:** a new `loadMemory` dep on the bot-messaging service,
    injected right after the chat context (the roster says *who* is here; memory says
    what is known *about* them) and traced as a **`long-term memory loaded`** step.
  - **Dashboard `/memory`:** shared `JobStatusCard` (backlog badge + an
    embeddings-unconfigured notice) + pending queue (discard), per-person documents
    (edit / forget), general facts (add / edit / forget). Every operator mutation is
    traced; an edit **re-embeds** rather than keeping a vector that describes text
    the row no longer contains. Live over a new `memory` SSE topic.
  - **Two real bugs found by the tests, both fixed:** (1) the general-fact candidate
    lookup was **vector-only**, so a fact stored without an embedding (embeddings
    unconfigured, or a failed embed) could never be offered as a reconcile candidate
    — the job would store a contradictory duplicate beside it instead of superseding
    it; both halves now always run and are unioned. (2) the lexical half used
    `websearch_to_tsquery`, which **ANDs** terms — a correction shares only *some*
    words with the fact it corrects ("Standup moved to 10:00" vs "Standup is at
    09:30"), so it demanded the word "moved" appear in the stored fact and matched
    nothing; it now ORs the note's lexemes and ranks by overlap.
  - **Shared fix (bit this feature first, would have bitten the next one):**
    `test/db.ts`'s `truncate()` was a **hand-written table-name list** that silently
    went stale whenever a feature added a table — rows leaked between tests and
    surfaced as a baffling duplicate-key error in an unrelated assertion. It now
    **derives the table list from the Drizzle schema**, so a new table is isolated
    the day it exists.
  - **Proof.** `npm run lint` ✓ (0 warnings), `npm run typecheck` ✓, `npm run test`
    ✓ (**341** unit, +18: prompt parsers fail-closed, context formatting),
    `npm run test:integration` ✓ (**190** passed / 15 skipped-live, +24 memory
    against real Postgres **with pgvector**: save path incl. unknown-user rejection;
    injection — consolidated memory injected, a **pending note explicitly NOT
    injected**, group participants, sender marking, general *not* injected;
    per-person merge, contradiction rewrite, garbage-response no-op, one-person
    failure not sinking the run; general insert/skip/replace, unembedded candidate,
    and refusal to delete a fact it was never offered; no-embedding degradation;
    hybrid search plus a **pending note explicitly NOT found** by it; `memory_get`
    returning the document without pending notes; operator edits; tracing).
    `db:generate`/`db:migrate` ✓ (`0017`). **Verified live** on the operator's dev
    server (3200): `/memory` renders with the nav item, the job card ("Next run
    2026-07-15 04:00:00 GMT+3" — the configured daily-job time in their timezone),
    and all three empty states; **added a general fact through the UI** → it appeared
    live with no reload and **no "not searchable by meaning" badge**, i.e. the real
    embedding call against their configured endpoint succeeded and the vector was
    written; the trace shows `memory · create-general-memory · success · 1.7s` on
    `/debug?feature=memory`, whose filter now lists **Memory** and **Memory tools**;
    deleting the fact restored the empty state. No console errors. **Dev DB left
    clean** — the test fact and both of its traces were removed afterwards
    (confirmed: all memory tables at 0 rows).
  - **Not done (operator's call, deliberately not taken):** no real consolidation run
    was triggered (it would spend tokens on their real data), and the memory tools do
    not enter the MCP registry — nor does the memory scheduler start (it shows
    **Stopped**) — until the **dev server restarts**: both are boot-bound `globalThis`
    singletons, the same restart gate link-fetch and `history_recall_topics` hit. The
    registry wiring itself is proven by the `getToolsView` unit test, which drives the
    real in-process registry. `npm run build` **not run** — the operator's dev server
    is live on 3200 (`dont-clobber-running-dev-server`); typecheck covers type validity.

- 2026-07-15 (user bug report — "scheduled tasks do not work, had 2 tasks, never
  got a message"): **diagnosed as maintenance mode silently pausing every fire;
  behavior kept, the pause made visible; the four job cards extracted into one
  shared component (done).**
  - **Diagnosis.** The poller was healthy — `GET /api/scheduled-tasks/run`
    reported `{running: true, ticking: false, lastSummary: "paused
    (maintenance)"}` with `lastTickAt` seconds old — but **every tick
    short-circuited**: `runTick` returns early while
    `settings.maintenance_mode_enabled` is on, and the operator's settings had it
    on. Confirmed from the trace log: the `scheduled-tasks` feature had only
    `create` traces and **zero `fire` traces, ever**. Both of the operator's tasks
    were still `enabled` with `next_run_at` in the past — due tasks are *skipped,
    not advanced*, so they stay due indefinitely.
  - **Decision (user, asked): keep the blanket pause.** Maintenance genuinely
    means "no scheduled fire reaches any chat", including the owner's own DM. The
    firing behavior is therefore **unchanged**. The defect being fixed is that the
    pause was **invisible**: `/scheduled-tasks` showed a green "Enabled" badge and
    a next-run time for a task whose message would never arrive, with nothing on
    the page explaining why. (The alternative — letting owner-chat tasks fire
    during maintenance, mirroring `bot-messaging/policy.ts` — was considered and
    declined.)
  - **Pause is now surfaced.** New `getTaskSchedulerInfo()` on the feature
    scheduler returns the ticker status **plus the policy/backlog around it**:
    `paused` (maintenance is on), `overdue` (enabled tasks whose instant has
    passed), `nextRunAt` (earliest upcoming run across enabled tasks, via a new
    `nextUpcomingRunAt` repository query), and `asOf` (the snapshot instant that
    "overdue" is measured against — so the flag can never disagree between the
    server render and hydration). `GET/POST /api/scheduled-tasks/run` now return
    this info instead of a bare status. `/scheduled-tasks` renders a **Task poller
    card**: a `Paused` badge, an `N overdue tasks` badge, and a warning notice
    naming the cause and the fix ("Firing is paused: maintenance mode is on … due
    tasks are skipped, not dropped … turn maintenance off in Settings"). Each
    overdue task row is badged **"Overdue — firing paused"** and its line reads
    **"Was due: <time> — not delivered"** instead of "Next run".
  - **Shared job card (`components/jobs/JobStatusCard.tsx`).** Vision backfill,
    history summaries, and self-improvement each had their own near-identical
    status card; scheduled tasks would have been the fourth. Per the "shared by the
    third use" rule they are now **one component** — activity badge, "Run now"
    mechanics (POST + error body + `router.refresh()`), and the next/last/result
    grid — with a `notice` slot for *why a job is not doing its work*, which is the
    generalizable lesson from this bug. `JobActivity` adds `paused`/`stopped` to
    the idle scheduler's existing `idle`/`scheduled`/`running` phases;
    `intervalJobActivity()` maps the interval scheduler's status onto it. The three
    old cards are now thin wrappers (each ~35 lines, down from ~120). Vision gained
    a "Next run" row it previously dropped despite having the data.
  - **Proof.** `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (323
    unit). `npm run test:integration` ✓ for scheduled-tasks (17 passed, 6 skipped —
    the skips are the opt-in live-LLM tool-selection tests), including **3 new
    `getTaskSchedulerInfo` tests** (upcoming run + no pause by default; an elapsed
    instant counts as overdue and is excluded from the next run; maintenance
    reports `paused` while the task stays due). The pre-existing 5
    `runDueScheduledTasks` simulated-fire tests still pass, so **the fire path
    itself is proven working** — delivery, history mirror, schedule advance,
    one-shot self-disable — meaning the operator's two tasks will fire on the next
    tick once maintenance is off. Verified live on the dev server: `/scheduled-tasks`
    renders "Task poller · Paused · 2 overdue tasks", the maintenance notice, "Last
    result: paused (maintenance)", and both tasks badged "Overdue — firing paused"
    with "Was due: … — not delivered"; `/vision`, `/history`, and
    `/self-improvement` still render their (now shared) cards at 200 with the right
    activity; no console errors. `npm run build` **not run** — a dev server is live
    on 3200 and a production build would clobber it
    (`dont-clobber-running-dev-server`).
  - **Follow-up (user directive): a spent one-shot is now DELETED, not disabled.**
    Previously a fired `once` task was left as a row with `next_run_at = null` and
    `enabled = false` — a permanent corpse on the dashboard that could never be
    revived anyway (creation/edit reject a one-shot whose date has passed). The
    fire loop now settles a task one of two ways: a recurring task is advanced via
    `markScheduledTaskRun` (whose `nextRunAt` is consequently **non-null** — the
    `enabled: nextRunAt != null` flip is gone), and a task with **no future run**
    is `deleteScheduledTask`d. Deletion happens **even when the fire failed**: the
    task can never fire again, so keeping it would leave a permanently-due row
    retried on every 30s tick forever — the attempt is preserved in its `fire`
    trace either way. A user *disabling* a task still keeps its row
    (`updateScheduledTask` with `nextRunAt: null`) — that path is untouched. Proof:
    the one-shot integration test now asserts the row is **gone**, plus a new test
    covering the failed-fire deletion; `npm run test:integration` for
    scheduled-tasks ✓ (18 passed, 6 skipped live).
  - **Not done (deliberately):** maintenance mode was **not** turned off and the
    two overdue tasks were **not** fired — that delivers real Telegram messages to
    the operator's chat and flips a settings toggle, both the operator's call.

- 2026-07-14 (Priority 3 follow-up — three user corrections to the summarization
  work below): **separate-embedding-backend toggle, fully retroactive
  summarization, and one shared run time for every daily job (done).**
  - **(1) "Separate embedding backend" toggle.** The Embeddings tab now leads with
    a switch: **off** (default) = embeddings are requested from the **same backend
    as the LLM** and no URL/key fields are shown at all; **on** = the URL field
    appears and is **required** (inline error + the probe/Save are blocked while it
    is blank), with the optional key beside it. The toggle is **derived from the
    stored URL**, not a new column — a stored embedding URL *is* the flag, so the
    two can never drift out of sync. Turning it off clears the URL **and its key**
    (that key authenticated a host we no longer call; leaving it would resurrect on
    re-enable). The probe and the save resolve the endpoint through the same
    expression, so a passing "Test embeddings" is a test of what will actually be
    stored.
  - **(2) Summarization is now fully retroactive.** It already scanned from the
    oldest day (the due-scan asks "which finished days hold messages but have no
    summary at their current message count" — equally true of yesterday, of a
    CSV-imported day, and of a day predating the feature), but the run was **capped
    at 25 days**, so a long history would have trickled in over many nights. The run
    now **drains the entire backlog in one go**, oldest day first: the scan is
    re-asked each iteration (summarizing a day removes it from the results, which is
    also how the loop terminates), days that fail are excluded from further
    iterations so they cannot spin the loop, and `MAX_DAYS_PER_RUN = 2000` remains
    only as a safety valve. Proven by a new integration test that seeds **60 days**
    (more than one scan page) and asserts one run summarizes all 60 back to the
    oldest, leaving zero pending.
  - **(3) One run time for all daily jobs.** `settings.self_improvement_run_time`
    and `settings.history_summary_run_time` are replaced by a single
    **`settings.daily_jobs_run_time`** (default 04:00, operator timezone), read by
    both schedulers via `getDailyJobsRunTime()`; Settings shows one **"Daily jobs
    run time"** field. Migrations **`0015_sticky_malcolm_colcord`** (add the column
    + a hand-added `UPDATE` carrying the operator's existing self-improvement time
    across, so a customized value is not silently reset) and
    **`0016_dazzling_captain_cross`** (drop the two old columns) — split in two
    because drizzle-kit's add+drop resolver prompts interactively for a possible
    rename, which cannot be answered in a non-TTY shell. **Pitfall for future
    schema work:** never add and drop columns on the same table in one generate.
  - **Verified live** (dev server on 3200, migrations applied): Settings shows
    exactly one run-time field ("Daily jobs run time"), and `GET /api/settings`
    exposes only `dailyJobsRunTime` (both old keys gone); the Embeddings toggle
    starts **off** with the URL/key fields absent, and switching it **on** reveals
    the URL with its required error and disables the probe until filled; both job
    APIs report the same `runTime: "04:00"` from the one setting; `/history` renders
    "Runs daily at 04:00 · 11 chat-days awaiting a summary". No console errors (the
    only entries are stale HMR messages from the pre-fix compile).
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit **323** ✓, integration —
    summarize **19** ✓ (+1 retroactive 60-day drain), settings **19** ✓,
    `db:generate`/`db:migrate` ✓ (`0015`, `0016`).

- 2026-07-14 (Priority 3 completion, user-directed — "lets finish history feature
  first, we need summarization, vector, tools"): **daily topic summarization +
  pgvector semantic recall + the recall tool (done).** History had a 24-hour
  window and three *literal* lookup tools (`history_search` was a plain `ILIKE`
  substring scan); it had no summarization and no vectors at all, so anything
  older than today was effectively unrecallable unless the query happened to use
  the same words the chat did.
  - **Decisions (user, AskUserQuestion — all four recommendations accepted;
    recorded in Decision Notes):** (1) embed **daily topic summaries only**, not
    every message; (2) embeddings get their **own base URL + key + model**,
    falling back to the LLM connection when the URL is blank; (3) vector width is
    a **code constant (1024)**, not a setting; (4) old context reaches a reply via
    **tools-only recall**, not an always-injected block.
  - **Data model (migration `0014_absurd_wither`):** `CREATE EXTENSION vector`
    (hand-added — drizzle-kit emits the `vector(1024)` column but never the
    extension, so a fresh DB would fail), `chat_summaries` (chat/date/content/
    `message_ids bigint[]`/`embedding vector(1024)`, HNSW cosine index + a
    hand-added GIN index on `to_tsvector('simple', content)` — an expression index
    has no Drizzle column to hang off), and `chat_summary_days` (the processing
    marker: `message_count`/`topic_count`, unique per chat+day). Settings gained
    `embedding_base_url`/`embedding_api_key` (masked)/`embedding_model` and
    `history_summary_run_time` (default **04:30**, offset from self-improvement's
    04:00 so the two never contend for the LLM).
  - **The marker table is what makes the job self-healing.** The due-scan compares
    each finished day's *live* message count to the count recorded when it was
    summarized, so a day that gains messages later (a CSV import, a late edit) is
    re-summarized, an unchanged day is never re-spent on the LLM, and a day of
    pure noise (0 topics) still stamps its marker instead of being rescanned
    forever. There is no separate backfill path — normal operation *is* backfill.
  - **New:** `lib/embeddings.ts` (`EMBEDDING_DIMENSIONS`, client-safe — schema,
    server, and form all need it), `server/llm/embeddings.ts` (`embed`/`embedOne`/
    `probeEmbeddings`; **validates the model's width against the column width** and
    reports a mismatch as a clear bad-request instead of an opaque Postgres error
    inside a background job), `features/history/summary.ts` (pure: prompt, lenient
    topic parsing, operator-timezone day bounds, transcript batching —
    `SUMMARY_BATCH_CHARS = 24_000`, since feeding a whole busy day at once overran
    the MVP's model into a repetition loop), `server/summaries-repository.ts`
    (idempotent day replace, due-scan, **hybrid RRF search** — cosine + full text
    fused by rank, degrading to pure full text when no embedding model is set),
    `server/summarize.ts` (traced per day, full request/response bodies; one bad
    day never sinks the run), `server/recall.ts`, `server/summary-scheduler.ts`
    (interval ticker + `withAdvisoryLock`, daily at the configured local time).
  - **New MCP tool `history_recall_topics`** (feature `history`, so it traces under
    the existing `mcp-tools-history` scope): searches the summaries by meaning
    *and* wording, returns topics + the message ids to read the originals.
    Self-describing, names no other tool (`tools-self-describe-atomic`).
  - **Shared extractions (per `extract-shared-before-second-use`):**
    `lib/json.ts` `extractJsonObject` (lenient LLM-JSON parsing — self-improvement's
    `parsePrefsJson` was the first copy, this was about to be the second) and
    `server/jobs/daily-due.ts` `todaysRunInstant`/`isDailyRunDue` (moved out of the
    self-improvement scheduler, now shared by both daily jobs).
  - **UI:** a Summaries job card on `/history` (next/last run, pending chat-days,
    "Run now", a warning badge when no embedding model is configured), the topics
    themselves on `/history/[chatId]` (grouped by day, message ids shown so a bad
    recall can be checked against the mirror above), an **Embeddings tab** on
    Settings with a **real probe** ("Test embeddings" actually embeds and reports
    the width), and `GET /api/history/summaries` + `POST …/run`. Live over the
    existing `history` SSE topic; new feature `history-summaries` in
    `lib/features.ts`.
  - **Tests:** unit `features/history/summary.test.ts` (+16: prompt/anchoring,
    batching incl. an oversized single message, lenient parsing + junk-id
    filtering, zoned day bounds, "never summarize today") → **323 unit**.
    Integration `summarize.integration.test.ts` (+18, real Postgres **with
    pgvector**: summarize/embed/store, idempotent re-run, embedding failure still
    stores the summary, noise-day marker, multi-batch busy day, traces; due-scan
    excludes today, buckets by the operator's clock, re-offers a day that gained
    messages; whole-backlog run, no-op second run, one failing day doesn't stop
    the rest; hybrid search — found by wording alone, by meaning alone, both-halves
    ranked first, and never leaking another chat) + settings (+7: embedding
    persistence/masking/trace-redaction, LLM-connection fallback, own-key path,
    unconfigured-without-a-model, run-time) → **163 integration** (+15 skipped
    live). `test/db.ts` now starts **`pgvector/pgvector:pg17`** (plain `postgres`
    has no pgvector — every embedding test would have failed against it). A live
    tool-selection case for `history_recall_topics` was added (opt-in `LLM_LIVE=1`).
  - **Verified live** (operator's dev server on 3200, migration applied): `/history`
    renders the Summaries card ("Idle", "No embedding model — keyword search only",
    next run in Europe/Kyiv); `GET /api/history/summaries` reports **`pendingDays: 11`**
    — the due-scan finding 11 real chat-days from the operator's own history;
    the Settings **Embeddings tab** probe against their live endpoint returned
    **`bge-m3 → 1024 dimensions`** (a real embed call, matching the column width
    exactly), traced as `settings · test-embeddings · success · 1.6s`; `/debug`
    lists **History summaries**. No console errors.
  - **Not done (operator's call, deliberately not taken):** the embedding model was
    **probed but not saved** — which model to run is the operator's decision; and no
    real summarization run was triggered, since "Run now" would spend tokens
    summarizing 11 days of their real conversations. Both are one click each on
    `/settings` and `/history`. `history_recall_topics` will not appear on `/tools`
    (nor be offered to the model) until the dev server restarts — the MCP registry
    is a boot-bound `globalThis` singleton, the same restart gate link-fetch hit;
    the registry wiring itself is proven by the `getToolsView` unit test, which
    drives the real in-process registry.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 323 ✓, integration 163 ✓ (+15
    skipped live), `db:generate`/`db:migrate` ✓ (`0014_absurd_wither`). `build`
    **not run** — the operator's dev server is live on 3200
    (`dont-clobber-running-dev-server`); typecheck covers type validity.

- 2026-07-14 (Cross-cutting UI fix, user-requested): **every dashboard date/time
  now renders in the configured operator timezone (done)** — previously the UI
  showed three different clocks: `lib/format.ts` hardcoded **UTC**
  (`getUTCHours()` + a literal `" UTC"` suffix — Debug, History, Groups, Vision
  gallery), three feature cards had their own `toLocaleString()` helper
  (**viewer-local**, locale-dependent — Vision backfill, Self-improvement panel +
  job card), and only `ScheduledTasksManager` used `settings.timezone`, threaded
  down as a prop.
  - **Shared layer (the fix, per `extract-shared-before-second-use`):**
    `lib/format.ts` `formatTimestamp(iso, timeZone)` / `formatTime(iso, timeZone)`
    are now `Intl.DateTimeFormat`-based (cached per zone, `hourCycle: "h23"`,
    `timeZoneName: "short"` → `2026-07-14 21:29:48 GMT+3`), falling back to UTC
    when the runtime does not know the zone so a mistyped setting cannot break
    every page. New `components/time/TimezoneProvider.tsx` (client context, seeded
    once per request by the root layout from `getTimezone()`, UTC on DB failure)
    and `components/time/Timestamp.tsx` — a `<Timestamp iso timeOnly? fallback? />`
    that emits a semantic `<time dateTime>` and renders from Server **and** Client
    Components alike. **`<Timestamp>` is now the one way to render an instant**;
    no component formats a date itself, and the zone is never passed as a prop.
  - **Converted:** `TraceList`, `TraceDetail`, `TraceTimeline` (time-only),
    `ChatSummaryList`, `ChatHistoryTable`, `KnownGroupsList`, `GroupMembersCard`,
    `MediaGallery`, `VisionBackfillCard`, `SelfImprovementPanel`,
    `SelfImprovementJobCard`, `ScheduledTasksManager` (its `timezone` prop and the
    page's now-redundant `getTimezone()` read are gone — it reads the context).
  - **Proof:** `npm run lint` ✓, `npm run typecheck` ✓, `npm run test` ✓ (307
    unit — `lib/format.test.ts` gained zone-shift, cross-midnight, and
    unknown-zone cases). Verified live on the dev server (operator zone
    Europe/Kyiv): `/history` and `/debug` now read `… GMT+3` where they read UTC
    before; a trace detail's timeline (`21:29:48`) matches the **time context the
    bot itself injects** (`2026-07-14 21:29 … Europe/Kyiv`) for the same trace —
    the UI and the bot finally agree; `/self-improvement` shows "Next run
    2026-07-15 04:00:00 GMT+3", matching the configured 04:00 local run time;
    `/scheduled-tasks` and `/vision` render correctly. No hydration warnings (the
    only console errors are the pre-existing `ThemeScript` inline-script notices).
    `npm run build` not run — the dev server is live on 3200
    (`dont-clobber-running-dev-server`).
  - **Remaining risk:** timestamps in **downloaded JSON trace bundles** are raw
    ISO/UTC by design (machine-readable payloads, unchanged); only rendered UI is
    zone-aware.

- 2026-07-14 (History follow-up, user-requested): **CSV import/export for the
  history mirror (done)** — a `/history/transfer` page reachable from History,
  with operator-configurable column mapping and a live data preview on import.
  - **Decisions (user, AskUserQuestion):** (1) duplicates are **skipped**, never
    overwritten (the mirror's `(chat_id, telegram_message_id)` unique key makes a
    re-import idempotent rather than destructive); (2) `telegram_message_id`
    **must be mapped** — no synthetic ids, so every row still traces back to a real
    Telegram message; (3) export covers **both** all chats and a single chat.
  - **Fixed values for columns the file does not have (user follow-up).** Each field's
    source is now a discriminated `ColumnSource` — `{kind:"column",header}` **or**
    `{kind:"constant",value}` — so a file that lacks a column (a per-chat export with
    no chat id, an all-human log with no role, a one-person log with no sender) can
    still be imported by giving that field one value used for **every** row. The
    mapping select gains a "— fixed value for every row —" option plus an inline
    input. **`telegram_message_id` is the one field that cannot take a constant** (it
    is the per-chat unique key — one value would collapse the file into a single
    message); the option is not offered, and the server rejects it if sent anyway.
    A constant is held to exactly the **same validation as a column** (shared
    `validateFieldValue` — the single definition of what each field accepts, used by
    both row coercion and constant checking), and an unusable one is reported as a
    **mapping problem** (`invalidConstants`, one inline error) rather than as N
    identical row errors. `MAX_CONTENT_CHARS` now lives in the client-safe `csv.ts`
    and is re-exported by `server/schema.ts` (it had been duplicated).
    Verified live on the operator's dev server with a `mid,body,when` file: fixed
    Chat ID/Role/Sender applied to every previewed row, a bad fixed role (`alien`)
    produced exactly one inline error and blocked the import, and the corrected
    import wrote 2 rows that exported back with the constants in place (test rows +
    traces deleted afterwards — dev DB left clean).
  - **Shared pure module** `features/history/csv.ts` (client-safe, dependency-free):
    RFC 4180 `parseCsv` (quotes, `""` escapes, embedded newlines, CRLF, BOM) +
    `detectDelimiter` (`,` `;` tab `|` — Excel's European dialect and TSV),
    `toCsv`/`rowsToCsv`, the `HISTORY_CSV_FIELDS` column model (label/required/hint/
    aliases), `guessMapping` (alias-based auto-detection), and `mapCsvRows`
    (per-row coercion → `{rows, errors, missing}`; ISO **or** Unix-seconds/ms dates,
    `human`/`bot` role aliases, sender nulled on assistant rows). **The browser and
    the server run the same module** — the preview cannot disagree with the write,
    and the server re-parses the raw text rather than trusting the client's parse.
  - **Server:** `features/history/server/transfer.ts` — `exportHistoryCsv(chatId?)`
    (canonical header, deleted rows included/flagged, so an export round-trips
    straight back through import) and `importHistoryCsv` (**traced** under
    `history`/`import`: parse → validate → chunked bulk insert with
    `onConflictDoNothing` → `{totalRows, imported, skippedDuplicates, errors,
    chatIds}`; invalid rows reported per line instead of failing the file; an
    all-invalid/empty/unmapped file is rejected). Repository gained
    `appendChatMessages` (bulk, conflict-skipping, returns only what it inserted)
    and `listChatMessagesForExport`. New shared `csvDownload` in `server/http.ts`
    (sibling of `jsonDownload`; UTF-8 BOM for Excel — the parser strips it again).
  - **Routes/UI:** `GET /api/history/export?chatId=`, `POST /api/history/import`;
    `/history/transfer` page + `HistoryTransferPanel` (export scope picker; file →
    auto-mapping → per-column selects → preview table of the coerced rows → per-line
    error list → import → result summary). "Import / export" button on `/history`,
    "Export CSV" on `/history/[chatId]`. Import publishes the `history` SSE topic.
  - **Verified live end to end** (see the DB note below — verification ran against a
    throwaway `csv_verify` database on a second dev server, since the operator's dev
    DB cannot serve history at all; the scratch DB and its launch config were removed
    afterwards): a semicolon-delimited foreign CSV (`Conversation;MsgId;Who;Text;
    When;Author;ReplyTo`) auto-mapped all 7 columns → "5 rows · 3 valid · 2 invalid"
    → preview rendered the coerced rows (Unix-seconds date, quoted/multi-line
    content, assistant row with no sender + reply pointer) and listed both bad rows
    by line → **3 imported, 0 skipped, 2 invalid**; re-importing the same file gave
    **0 imported, 3 skipped** (idempotent); `/history/4242` showed the mirror;
    `GET /api/history/export?chatId=4242` returned `text/csv` +
    `attachment; filename="history-chat-4242.csv"` + a `EF BB BF` BOM and the exact
    round-trippable rows; both imports traced `success` on `/debug?feature=history`
    with a `CSV parsed` (headers/mapping/delimiter) → `rows validated` (warn, full
    error list) → `messages imported` timeline. No console errors beyond the
    pre-existing theme-script warning (present on untouched pages too).
  - **Two defects found *by* the live run and fixed:** the unmapped-required-column
    case was being surfaced as a fake `line 0` **row** error (and counted as an
    invalid row) — `mapCsvRows` now returns a separate `missing` list, and the UI
    shows a mapping message with human labels; and `Author` was winning the **role**
    alias before `Who` could (in real exports that column is the sender id), so
    `author` moved from `role`'s aliases to `user_id`'s.
  - **Environment finding (not caused by this change) — found, then resolved:** the
    dev `DATABASE_URL` points at the **old MVP's database** (`bot`), whose
    pre-existing `chat_messages` table had the MVP shape (`entity_id`, `message_id`,
    `tsv`, bigint `created_at`). Drizzle's `CREATE TABLE IF NOT EXISTS` silently
    no-op'd for migration `0006`, so the new app's history table was **never created
    there** and every history read failed ("column chat_id does not exist"); the
    other tables were created fresh, which is why the rest of the dashboard worked.
    **Resolution:** the operator dropped the MVP table, and migration `0006`'s SQL
    was then replayed by hand against the dev DB (the drizzle ledger already had
    `0006` marked applied, so `db:migrate` alone would not restore it; `0006` is the
    only migration touching this table). The dev DB now has the correct table
    (identity PK + both indexes) and `/history` + `/history/transfer` render there
    with no console errors. The mirror starts empty — the MVP rows went with the
    dropped table; a dump of them can be re-imported through the new CSV page
    (`entity_id`→Chat ID, `message_id`→Message ID, `created_at`→Sent at, which the
    importer accepts as a Unix timestamp).
    **Pitfall for future migrations:** a fresh table in a database that already
    holds a same-named legacy table will be skipped silently — check
    `information_schema.columns`, not just table existence, when history/schema reads
    fail on a DB that was previously the MVP's.
  - **Tests:** unit `features/history/csv.test.ts` (+20: parse/quotes/BOM/delimiter,
    `toCsv` round-trip, alias mapping incl. the live foreign-header shape, coercion,
    Unix dates, assistant-sender nulling, per-line errors, empty content, the
    `missing` contract, and fixed values — applied to every row, satisfying a
    required column, rejected when unusable, refused for the message id, still
    nulling the sender on assistant rows) → **304 unit**. Integration
    `features/history/server/transfer.integration.test.ts` (+12, real Postgres:
    export all/scoped/empty, full round-trip preserving quotes+newlines+reply
    pointers, duplicate-skipping incl. a mixed re-import, a foreign CSV through an
    operator mapping, a file with no chat/role/sender columns imported via fixed
    values, rejection of an unusable constant and of a fixed message id before any
    write, per-line invalid rows, rejection of unmapped/empty/all-invalid files,
    success + error traces) → **138 integration** (+14 skipped live).
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 304 ✓, integration 138 ✓.
    `build` **not run** — the operator's dev server is live on 3200
    (`dont-clobber-running-dev-server`); typecheck covers type validity.

- 2026-07-14 (Self-improvement system, user-requested): **👍/👎 feedback →
  per-user communication preferences + global self-corrections (done).**
  - **Decisions (user, AskUserQuestion — recorded in Decision Notes):** (1) group
    menu = inline keyboard in the group, answerable **only by the reactor**
    (Telegram cannot show a group message to one member); (2) "Other" free text =
    **reply to the menu message**; (3) daily run time = **Settings field**
    (`self_improvement_run_time`, HH:MM in the operator timezone, default 04:00);
    (4) menu options = the proposed 5+5 lists (code constants in `options.ts`).
  - **Data model (migration `0013_ordinary_crystal`):** `users_feedbacks`
    (chat/message/user unique triple, reaction, feedback, status
    `pending→awaiting_text→completed`, `menu_message_id`, clean `model`,
    `prefs_version`/`corrections_version` incorporation stamps),
    `users_communication_preferences` (per-user versioned likes/dislikes),
    `self_corrections` (global versioned guidelines),
    `settings.self_improvement_run_time`.
  - **Intake (transport pattern preserved):** `bot-manager` `allowed_updates` +=
    `message_reaction` + `callback_query`, thin grammy adapters
    (`grammyFeedbackTransport`) onto new grammy-free `process-reaction.ts` /
    `process-callback.ts`; a new `FeedbackTransport` seam in `transport.ts`
    (sendMenu/editMenu/answerCallback). `process-update.ts` captures a reply to an
    `awaiting_text` menu as the feedback answer (`feedback_captured` outcome — the
    LLM is never called; menu edited to a confirmation, or a plain confirm reply
    when no editor is wired). Reaction removals ignored (v1); re-reacting reopens
    the row and asks again. **Telegram constraints:** reactions in groups are only
    delivered when the bot is an **admin**; `message_reaction` must be listed in
    `allowed_updates` (boot-bound → poller restart).
  - **Incorporation job:** `analyze.ts` `runSelfImprovement(deps)` (injected
    `complete`) — per user: previous version seeds a draft, **one LLM call per
    feedback** (persona stated once per call; exchange = user message + bot reply
    from the history mirror; strict-JSON profile output, lenient parse), new
    version `prev+1`, feedbacks stamped; then the same iterative fold across all
    users for the corrections text. A failed/unparseable fold leaves its feedback
    unstamped for the next run. One `self-improvement/incorporate` trace per run
    with full request/response bodies; an empty backlog is a silent no-op.
    `scheduler.ts` = interval-scheduler singleton (60s tick), due-math
    `todaysRunInstant`/`isDailyRunDue` (reuses `scheduled-tasks/schedule.ts`
    zoned-clock helpers), `withAdvisoryLock("self-improvement")`, forced "Run now",
    `lastResult` kept apart from the ticker's waiting summaries; started/stopped in
    `register-node`.
  - **Prompt injection:** `buildSystemPrompt` gained `selfCorrection` (appended
    below the persona; `selfCorrectionApplied` on the `system prompt composed`
    trace step); new `BotMessagingDeps.loadSenderPreferences` injects the sender's
    latest preferences as a system message after the chat context (traced
    `communication preferences loaded`); `process-update` wires
    `getLatestSelfCorrectionPrompt()` + `getPreferencesContext(senderId)`.
  - **Dashboard:** `/self-improvement` (job card with next/last run + Run now,
    feedback table with user labels/reaction/status/model/incorporation badges,
    latest preferences per user, latest correction) live on the new `feedback` SSE
    topic; nav item; `GET /api/self-improvement`, `POST /api/self-improvement/run`
    (fire-and-forget); Debug via the shared `/debug?feature=user-feedback` and
    `?feature=self-improvement` filters; Settings gained the run-time field.
  - **Tests:** unit +35 → **284** (`model-name`, `menu` codec/keyboard,
    `format` preferences block, `detectAddedThumb`, `parsePrefsJson`, scheduler
    due-math, `buildSystemPrompt` self-correction, bot-messaging service
    preferences/correction injection). Integration
    `self-improvement.integration.test.ts` (+9: reaction→menu with clean model
    resolved from the reply trace's `usage.model`; non-thumb/non-bot-message
    ignored; option press + reactor-only enforcement; Other→reply capture
    short-circuiting the LLM (and no double-capture); re-reaction reopen;
    incorporation folds/stamps/versions + persona-once + no-op second run;
    version-2 seeded from version 1; failed fold leaves feedback unstamped;
    prompt injection end-to-end via `simulateUpdate`), settings (+1 run-time
    persistence) → **126 integration** (+14 skipped live).
  - **Verified live** (operator's dev server on 3200, not restarted):
    `/self-improvement` renders (nav, job card "every day at 04:00 (verified with
    the real operator timezone)", both Debug links, LiveIndicator); seeded a
    synthetic feedback/preference/correction set → all three sections + API
    aggregate render correctly, then deleted (dev DB left clean); `/settings`
    shows the run-time field; `/debug` filter lists **User feedback** +
    **Self-improvement**; no console errors. **Operator-gated:** a real
    reaction→menu→answer round-trip (poller restart for the new
    `allowed_updates`; group admin rights) and the real 04:00 fire (boot-bound
    scheduler singleton).
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 284 ✓, integration 126 ✓
    (+14 skipped live), `db:generate`/`db:migrate` ✓ (`0013_ordinary_crystal`).
    `build` not run — dev server live on 3200 (`dont-clobber-running-dev-server`).

- 2026-07-14 (Priority 9 bugfix): **Current time injected into the reply context —
  relative-time reminders now create tasks** (user reported a real trace where
  "remind me to stand up in 5m" produced a sarcastic reply and **no task**).
  - **Root cause (from the trace's `reasoning_content`):** the model *wanted*
    `tasks_create` but gave up — "I don't have the current time... `tasks_create`
    requires `time` as HH:MM... I cannot carry out `tasks_create` without a time."
    The whole reply context carried **no "now"**, so a relative/named time ("in 5m",
    "tomorrow") — and even the date a `once` task needs — was unresolvable. **A
    regression from the MVP**, which injected the current time into its `[SESSION]`
    block (local wall clock in the bot timezone + UTC ISO). My live tool-selection
    test missed it because it only used absolute times ("every day at 9am").
  - **Fix (MVP parity):** new pure `buildTimeContext(now, timeZone)` in
    `features/bot-messaging/server/prompt.ts` — a tool-agnostic system line ("Current
    date and time: 2026-07-14 16:34 (Tuesday), timezone Europe/Kyiv (UTC …). Treat
    this as 'now': resolve any relative or named time … against it."), falling back
    to UTC for an unusable zone. The bot-messaging service injects it as a **system
    message right before the current user turn** (new optional `deps.timeContext`;
    recorded as a `time context` trace step for debug). `process-update` builds it
    from `getTimezone()` + `new Date()` (added to the existing policy/personality
    `Promise.all`). Tool-agnostic per `tools-self-describe-atomic` — names no tool.
  - **Tool description:** `tasks_create` now explicitly covers one-off/relative
    requests ("in 5 minutes", "tonight", "tomorrow at 9"), says to resolve them
    against the current time in context, and documents `once` needs a computed
    `date`+`time` (it previously read as recurring-only). No schedule-model change —
    the MVP likewise had no relative-offset input; the model computes HH:MM/date from
    the injected "now" (5-min granularity via `once`, scheduler ticks 30s).
  - **The live harness now mirrors production** — `runToolSelection` injects the same
    time context — and a **regression case** was added:
    `features/scheduled-tasks/server/tool-selection.integration.test.ts` "creates a
    one-off task from a relative-time reminder ('in 5 minutes')" → asserts
    `tasks_create`. It **failed before the fix, passes after** against the real model.
  - **Tests:** unit `prompt.test.ts` (+4: `buildTimeContext` local/UTC/relative-hint/
    bad-zone), `service.test.ts` (+2: time line injected before the user turn +
    traced; omitted when absent) → **249 unit**. Live tool-selection now **13 cases,
    13/13** (`LLM_LIVE=1 npm run test:integration -- tool-selection`, ~47s).
  - Checks: lint ✓, typecheck ✓, unit 249 ✓, process-update integration 5 ✓, live
    tool-selection 13 ✓. `build` not run (test/prompt change; dev server may be live).

- 2026-07-14 (Testing infrastructure): **Live tool-selection coverage — every MCP
  tool proven to be picked by the real LLM** (user: "each tool has to be covered by
  live LLM tests — that the model understands different request types and actually
  calls the proper tool, though we don't need to run the actual Tavily search etc.").
  - **Insight:** the intent is testing *tool selection*, not tool execution. So the
    harness drives the **real** configured LLM with the **real** registered tool
    schemas/descriptions (straight through `getToolset()`) and the production system
    prompt (`buildSystemPrompt()`), but **intercepts every tool call** — records it
    and returns a canned result. No Tavily HTTP, no headless browser, no DB mutation;
    the model sees the exact production tool contract, so its choice is faithful.
  - **New `test/tool-selection.ts`** (shared cross-cutting harness): `runToolSelection`
    resolves the LLM connection from DB settings, builds `[system prompt,
    ...systemContext, ...priorTurns, user]` like the service does, and runs
    `chatCompletionWithTools` with a recording `callTool`. Realistic per-tool canned
    results let multi-step flows proceed (e.g. "cancel my reminder" → the model calls
    `tasks_list`, whose canned result carries `task_demo_1`, which it then passes to
    `tasks_delete`). Returns the ordered tool calls + final content; swallows a
    stalled/empty-loop error since the recorded *selection* is what we assert on. Also
    exports the shared suite plumbing — `LLM_LIVE`, `useLiveLlm()` (load `.env` + fail
    fast if the LLM is unconfigured + close the pool after), `TOOL_SELECTION_TIMEOUT`,
    `expectToolCalled`/`expectToolNotCalled`.
  - **Cases co-located per feature** (matching the repo convention — every feature
    keeps its integration tests in its own `server/` folder), opt-in
    `describe.skipIf(!LLM_LIVE)`, 12 cases total:
    `features/history/server/tool-selection.integration.test.ts` (`history_search`,
    `history_get_in_range`, `history_get_by_message_ids`),
    `features/known-users/server/…` (`update_user_aliases`, with a DM identity
    context), `features/web-search/server/…` (`search_web` **plus a negative case**
    asserting the model does **not** search for plain general knowledge — "capital of
    France"), `features/link-fetch/server/…` (`read_page`),
    `features/scheduled-tasks/server/…` (`tasks_create/list/update/delete/get`). No
    rows written (tools intercepted, LLM read-only).
    Run: `LLM_LIVE=1 npm run test:integration -- tool-selection` (the shared basename
    matches all five files).
  - **Verified live** against the operator's configured backend: **12/12 passed in
    ~38s** — the model selected the correct tool for every request, including the
    list→act two-step for update/delete and the negative no-search case. Cheap,
    small prompts; no external side effects.
  - Checks: lint ✓ (0 warnings), typecheck ✓, collection ✓ (5 files, 12 tests
    skipped without `LLM_LIVE`), live run ✓ (5 files, 12 passed, ~48s). `build` not
    run — dev server may be live (`dont-clobber-running-dev-server`); the change is
    test-only.

- 2026-07-14 (Priority 9 follow-up): **Task author-scoping + timezone stored in
  UTC** (two user corrections).
  - **(1) Author-scoped edit/cancel.** Every task already recorded
    `created_by_user_id`; the MCP `tasks_update`/`tasks_delete` tools now enforce
    it via a shared `checkOwnership` (task must be in this chat AND created by the
    caller) — a participant can only change/cancel tasks **they** created, and a
    dashboard-authored (null-author) task can't be changed by a chat user. Tool
    descriptions updated to say so; list/get remain chat-scoped reads and the
    structured view now includes `created_by_user_id`. The dashboard (operator
    surface) stays unrestricted and shows each task's author ("by <label>" resolved
    from known users, or "via dashboard").
  - **(2) Timezone in UTC, adapted at runtime.** Dropped the per-task `timezone`
    column (migration `0012`); schedules are interpreted at create/edit/fire
    against the single `settings.timezone` (read fresh each time), and all instants
    stay UTC (`timestamptz`) — no Postgres `TZ`. Changing the operator timezone now
    re-times every task. `computeNextRun` calls in the service (edit) and scheduler
    (advance) read `getTimezone()`; the dashboard card formats next/last-run in that
    zone (fixes the earlier label/value mismatch).
  - **(3) Simulated fire — no bot, no live LLM (user: stop citing a bot-token
    gate; we have the simulator).** Extracted the testable due-run core
    `runDueScheduledTasks(deps)` from the scheduler (injected `complete`/`send`/
    `recordReply`/`timezone`/`now`/`db`); `runTick` wires the real collaborators
    (`chatCompletion`, the bot's `sendChatMessage`, `recordAssistantMessage`) under
    the advisory lock. New `scheduler.integration.test.ts` (+5) drives the whole
    tick against real Postgres with a capturing reply sink + deterministic
    generator: proves delivery to the right chat, the history mirror, recurring
    wording variation (2nd fire's directive carries the 1st delivery), one-shot
    self-disable (`next_run_at`→null), empty-output skip (advances anyway, no
    send), and nothing-due. No credentials — the only unexercised sliver is grammy
    `sendChatMessage` hitting Telegram.
  - **Tests:** new `mcp-tools.test.ts` (+6: `checkOwnership` allow/deny matrix —
    own/other/no-userId/dashboard-task/other-chat/missing) → **243 unit**;
    integration updated (author stored; timezone interpreted, not stored) +
    `scheduler.integration.test.ts` (+5 simulated fire) → **116 integration** (+1
    skipped live).
  - **Verified live** (dev server on 3200): created a dashboard task → shows "via
    dashboard" + "Next run … 9:00:00 AM (UTC)" (correctly UTC now); seeded a
    user-authored row → shows "by <resolved user label>"; both deleted, dev DB left
    clean; no console errors.
  - Checks: lint ✓, typecheck ✓, unit 243 ✓, integration 116 ✓ (+1 skipped live),
    `db:generate`/`db:migrate` ✓ (`0012_little_siren` drops the column).

- 2026-07-14 (Priority 9): **Scheduled tasks feature (done)** + **Mood
  de-prioritized to lowest (13)** (user, AskUserQuestion).
  - **Reprioritization:** the user chose to de-prioritize Mood to the lowest
    priority. New order: 9 Scheduled tasks → 10 Memory → 11 Image generation →
    12 Browser agent → 13 Mood. Reflected in the Feature Progress table,
    `NEXTJS_REWRITE_PLAN.md`, and `AGENTS.md`; recorded in Decision Notes.
  - **Decisions (user, AskUserQuestion):** (1) creation surface = **MCP tools +
    dashboard, NOT owner-gated** — any chat participant manages that chat's tasks
    (MVP gated to owner); (2) fire trigger = **in-process periodic poller** over
    external-cron→Route-Handler.
  - **New shared primitive** `server/jobs/interval-scheduler.ts`
    (`createIntervalScheduler` — fixed-interval ticker + overlap guard + status;
    `start`/`stop`/`runNow`/`getStatus`, `unref`'d timer). The sibling of
    `idle-scheduler.ts`: the idle scheduler *defers* while busy, but a task at
    09:00 must fire regardless, so time-based jobs need a plain ticker.
  - **Feature module** `features/scheduled-tasks/*`: client-safe `types.ts` +
    `schedule.ts` (dependency-free `Intl` once/daily/weekly math + `describeSchedule`
    + `normalizeSchedule`, ported from the MVP's best-shaped code, returning
    `Date`); server `repository.ts` (Drizzle CRUD + `listDueScheduledTasks` +
    `markScheduledTaskRun` + `nextRecentDeliveries` cap), `schema.ts` (zod),
    `service.ts` (validation + next-run in the operator timezone + trace per
    mutation), `fire.ts` (`fireScheduledTask` — base+persona prompt + directive →
    `chatCompletion` → `formatReply` → deliver → mirror to history → trace under
    `scheduled-tasks`; never throws, skips empty output; `buildTaskDirectiveMessage`
    seeds wording variation from `recentDeliveries`), `scheduler.ts` (`globalThis`
    singleton: each tick, under `withAdvisoryLock`, list-due → fire → advance
    `next_run_at`; pauses on maintenance; LLM conn read fresh), `mcp-tools.ts`
    (`tasks_create/update/delete/list/get`, chat-scoped via the tool context, not
    owner-gated), `ui/ScheduledTasksManager.tsx`.
  - **Data model** (migration `0011`): `scheduled_tasks` (chatId/threadId/
    createdByUserId/instruction/scheduleKind/timeOfDay/weekdays int[]/runDate/
    timezone/enabled/`recentDeliveries jsonb`/lastRunAt/nextRunAt/timestamps;
    indexes on chatId and (enabled,nextRunAt) for the due scan) + `settings.timezone`
    (IANA, default UTC).
  - **Cross-cutting:** extended `McpToolContext` with `userId`+`threadId`
    (process-update binds them via `runWithToolContext`); `bot-manager.sendChatMessage`
    for out-of-band delivery; `register-node` starts/stops the poller;
    `server/mcp/runtime.ts` registers the tools under owner `scheduled-tasks` (tool
    calls trace as `mcp-tools-scheduled-tasks`); `lib/features.ts` gains
    `scheduled-tasks` + `mcp-tools-scheduled-tasks`; `lib/realtime.ts` gains the
    `tasks` topic; nav gains "Scheduled tasks"; settings schema/service/repository/
    form gain `timezone` (+ `getTimezone()`, IANA-validated on write).
  - **Tests:** unit `schedule.test.ts` (+12), `interval-scheduler.test.ts` (+5),
    `fire.test.ts` (+6) → **237 unit**; integration `scheduled-tasks.integration.test.ts`
    (+8: create/next-run/timezone/validation, edit/recompute, delete, search,
    due-scan + markRun capped deliveries), settings-timezone (+1), mcp-tools
    service (updated for the 5 new tools) → **110 integration** (+1 skipped live).
  - **Verified live** (dev server on 3200): `/scheduled-tasks` renders (nav item,
    LiveIndicator, Debug link, real chat dropdown — a DM + a group, timezone card,
    Run-due-now); created a daily task → correct next-run + `success` create trace
    on `/debug?feature=scheduled-tasks` (77ms) → deleted it (dev DB left clean); no
    console errors. Fixed a display nuance found live: the next-run time is now
    formatted in the task's timezone to match its `(tz)` label. **Not verified
    live:** a real fire→Telegram delivery (boot-bound scheduler singleton + a real
    bot token — operator gate; no credentials created).
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 237 ✓, integration 110 ✓
    (+1 skipped live), `db:generate`/`db:migrate` ✓ (`0011_rare_marvex`). `build`
    **not run** — dev server live on 3200 (`dont-clobber-running-dev-server`);
    typecheck covers type validity.

- 2026-07-14 (Testing infrastructure): **Transport-boundary refactor + bot-less
  flow simulator + opt-in real-LLM flow test** (user: "improve testing — test flows
  without the bot (it's just a source of events + data, can be simulated); test
  flows against the real LLM (DATABASE_URL + LLM backend config in DB is enough)").
  - **Decisions (user, AskUserQuestion):** (1) simulator surface = **test harness
    helper** only (no dashboard page / CLI); (2) real-LLM gating = **opt-in against
    the real `DATABASE_URL`** (reads live `getLlmRuntime()`), skipped unless
    `LLM_LIVE=1`; (3) refactor depth = **extract the transport boundary** (not a
    minimal fake-context).
  - **Insight:** the bot-messaging *service* (`handleIncomingMessage`) was already
    fully DI'd + unit-tested; the untested, bot-coupled surface was the ~300-line
    runtime glue in `bot-manager.ts` (`onMessage` + `buildDeps`) — remember/mirror/
    vision-ingest/prompt/tools/LLM/trace/deliver — unreachable without a live grammy
    `Context` and poller. The bot is only two edges: an incoming `Context` and a
    reply sink (`ctx.reply`/typing); vision's file download (`telegram-files.ts`)
    was already grammy-free (token-only). So the boundary is clean.
  - **New `server/telegram/transport.ts`:** `IncomingUpdate` (`{ message, botInfo,
    resolveToken }` — token resolved lazily, only when the turn carries media) +
    `ReplyTransport` (`sendReply`/`sendTyping`). Re-exports `BotIdentity`.
  - **New `server/telegram/process-update.ts`:** `processUpdate(update, transport,
    overrides?)` + `processEditedUpdate(message)` — the whole pipeline moved out of
    `bot-manager`, **grammy-free** (every `ctx.*` → `update.message.*` / `transport.*`).
    `ProcessOverrides.generateReply` is the one test seam (default = real
    DB-configured LLM + tool loop), so a flow can run deterministically *or* against
    the real provider. No behavior change (verbatim move; the typing refresh
    interval stays in the pipeline, calling `transport.sendTyping` per tick).
  - **Slimmed `bot-manager.ts`:** now only the Telegram edge — poller lifecycle
    (start/stop/status, unchanged `globalThis` singleton) + a thin `grammyTransport(ctx)`
    adapter and `onMessage`/`onEditedMessage` that map a live `Context` onto
    `processUpdate`/`processEditedUpdate`.
  - **New `test/simulate.ts`:** `simulateUpdate(input, overrides?)` builds a
    synthetic `Message` from a compact input (`chatId`/`chatType`/`from`/`text`/
    `replyTo`/…), runs the **real** `processUpdate` through a capturing
    `ReplyTransport`, and returns `{ outcome, replies, typingCalls }`. Media is
    skipped by default (no real Telegram files behind a sim); token is injectable.
  - **`test/db.ts`:** `TestDb` now exposes `connectionUri` so a flow test can point
    the app's own pool (`getDb()`/`getPool()`, used *inside* the pipeline) at the
    same Testcontainer by setting `DATABASE_URL` before the first query.
  - **New `server/telegram/process-update.integration.test.ts`** (real Postgres,
    injected deterministic generator, +5): private message → remembered + both turns
    mirrored + replied + traced (bot-messaging, success); un-addressed group chatter
    → ignored but still passively captured (user remembered + mirrored, **no**
    bot-messaging reply trace — first-sight `known-users`/`known-groups` capture
    traces are separate); group `@mention` → replied; maintenance mode → non-owner
    turned away with the notice + no LLM call, owner let through. Proves the runtime
    glue writes through the app's own `getDb()`.
  - **New `server/telegram/live-flow.integration.test.ts`** (opt-in, `describe.skipIf(
    !LLM_LIVE)`): loads `.env` via `@next/env`, reads live `getLlmRuntime()`, drives
    `simulateUpdate` with **no** generator override (real provider) against a
    dedicated synthetic chat/user id, asserts a non-empty reply + a success
    bot-messaging trace, then deletes every row it wrote (messages, media, traces +
    events by `correlationId` prefix, the test user). Run:
    `LLM_LIVE=1 npm run test:integration -- live-flow`.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit **214** ✓, integration **101
    passed + 1 skipped** (the live test; was 96 → +5 flow). `build` **not run** — a
    dev server is live on 3200 (`dont-clobber-running-dev-server`); typecheck covers
    type validity and the change is internal (no deps/config).

- 2026-07-14 (Priority 7 follow-up): **Vision pass split — describe always, attach
  images to the reply only when the message has text** (user refinement of the
  2-pass flow: "1 pass always — describe and store in history; conditional is the
  second pass — include attachments for reply generation").
  - `bot-manager`: the current media's `recognizeMessageId` is now **always** set
    (describe pass runs for every addressed media), and a new `attachToReply` flag
    gates the image attachment on `Boolean(text.trim())` (replied-to media always
    attaches). `loadVision` describes first, then: if `attachToReply` → returns the
    images + folds `Recognition of the media above: <desc>` into the note; else →
    returns **no images** with the note `The user sent a <kind> (no caption). Its
    content: <desc>` so the reply is generated from the recognition text alone.
  - `bot-messaging/service.ts`: the vision block now also fires when there are no
    image parts but a note is present (folds the description into the turn text);
    the trace step's `data.fromReply` → `data.hasNote`.
  - Result: media-only = **1 vision pass** (describe; reply from text), media+text =
    **2 vision passes** (describe + reply-with-images).
  - Tests: bot-messaging `service.test.ts` (+1: media-only → plain-text turn
    carrying the recognition, `imageCount:0, hasNote:true`; updated the existing
    assertion to `hasNote`) → **214 unit**. Not browser-observable (bot message
    handling — operator gate: bot token + poller restart). lint ✓, typecheck ✓.

- 2026-07-14 (Priority 7 follow-up): **Recognize media before the reply + fix
  media in history/vision display** (three user changes).
  - **(1) Recognize-before-reply (user decision: reply gets images + description,
    2 vision passes).** The describe pass moved from *after* the delivered reply to
    *before* it: it now runs inside the `loadVision` dep (which the bot-messaging
    service calls only after the addressing + maintenance gates, so recognition is
    correctly gated to addressed messages). `loadVision` describes the current
    turn's media → records the description on the `message_media` row + drops the
    bytes, folds `Recognition of the media above: <desc>` into the reply note, and
    still attaches the images. So: message stored → addressed → media detected →
    recognized → stored in history → reply generated with images + result → nothing
    left to backfill for that message (unaddressed media still goes to the backfill
    job). Removed the old post-reply `describeAndStore` block in `bot-manager`
    (`currentMediaIngested`/`outcome` no longer needed there).
  - **(2) /vision shows all frames.** `MediaView` gained `frames: string[] | null`
    (all sampled frames as data URLs); `toView` fills it for a pending video/GIF;
    `MediaGallery` renders a `grid-cols-5` grid of every frame (titled `Frame k of
    n`) instead of a single preview. Described rows (bytes dropped) still show the
    text description.
  - **(3) History content no longer blank for media.** `/history` now renders the
    same media annotation the transcript uses (` [photo: <description>]` /
    ` [photo]`) in the Content column. New shared `getMediaSuffixesForMessages`
    (vision service) is used by both the reply transcript window (`loadHistory`) and
    the history page — DRY, replacing the inline suffix loop in `bot-manager`.
    `getChatHistory` gained an injected `loadMediaSuffixes` option and a
    `mediaSuffix` field on `ChatMessageWithTrace`; the `/history/[chatId]` page wires
    the vision loader (services stay decoupled — the page is the composition point).
    No `chat_messages.content` mutation: `message_media.description` stays the single
    source of truth, so there's no transcript/`edited`-flag duplication.
  - **Tests:** history integration (+1: `getChatHistory` annotates via the injected
    loader; text messages unannotated), vision integration (+1:
    `getMediaSuffixesForMessages` → ` [photo: a red car]` described / ` [photo]`
    pending). Fixed the `getChatHistory("5", ctx.db)` call sites for the new middle
    `options` arg. → **213 unit, 96 integration**.
  - **Verified live** (dev server on 3200): `/history/<chat-id>` Content column now
    shows recognized media, e.g. `[GIF: A sequence of seven video frames showing a
    person walking down a stone staircase…]` and `[GIF: …sequence of 10 consecutive
    frames…]` (was blank) — also confirms the sequence-describe is running. `/vision`
    frame grid verified by seeding a synthetic pending 6-frame video row → rendered
    6 `data:image/jpeg` frames titled `Frame 1..6 of 6` with `video`/`Pending`
    badges; row + temp scripts deleted afterward (dev DB restored).
  - **Not verified live:** a brand-new real Telegram photo/video → recognize →
    reply round-trip through the reordered `loadVision` — operator gate (bot token +
    poller restart); covered by the unit/integration paths and the display checks
    above.
  - Checks: lint ✓, typecheck ✓, unit 213 ✓, integration 96 ✓. `build` not run (dev
    server live — `dont-clobber-running-dev-server`).

- 2026-07-14 (Priority 7 follow-up): **Video/GIF frames sent as an ordered
  sequence of separate images, replacing the contact-sheet montage** (user: "it
  have to be sequence of images, model have to vision in order and also be
  explained that they are not detached random images - but sequence"; also settled
  earlier this session: always 10 frames, evenly across the whole clip).
  - **Change:** dropped the single tiled contact-sheet image. Each sampled frame is
    now normalized on its own and the model receives them as **separate, ordered,
    labelled images**. `format.ts` gained `toVisionParts` (interleaves
    `Frame k of n:` text parts before each image for length > 1; a single image is
    unlabelled) and `frameSequenceHint` (explicit "these are consecutive frames of
    one clip in chronological order — NOT separate/unrelated images"); moved off
    `frames.ts` (`composeContactSheet`/`contactSheetHint` and the montage constants
    removed). `buildVisionContent` now routes through `toVisionParts`, so both the
    describe pass and (via `bot-manager` → `toVisionParts`) the live reply turn get
    the labelled sequence + preface.
  - **Storage (migration `0010`):** new `message_media.frames_base64 jsonb` holding
    the chronological frame array; `data_base64` keeps the first frame for the
    `/vision` preview. `insertMedia`/`markDescribed`/`mapRow` + `MediaRecord`/
    `InsertMedia` updated; a shared `storedMediaImages` rebuilds the `ImagePayload[]`
    sequence for `describeAndStore` and `loadReplyTargetImages` (frames when present,
    else the single image). Both byte fields dropped on describe.
  - **Service:** `loadVideoContactSheet` → `loadVideoFrames` (normalizes every frame,
    returns the full `ImagePayload[]` sequence + the sequence hint). Thumbnail
    fallback unchanged (one frame). Cost accepted: up to 10 image inputs per clip.
  - **Tests:** `format.test.ts` gained `toVisionParts` (single vs interleaved-labelled)
    + `frameSequenceHint` cases and an updated single-image `buildVisionContent`
    assertion; deleted `frames.test.ts` (its montage/contact-sheet-hint targets are
    gone). Vision integration gained a **video-sequence** case: a row with
    `frames:["F1","F2","F3"]` → `describeAndStore` sends 3 separate image parts with
    a `Frame 1 of 3:` label and drops both `data_base64` and `frames_base64` on
    success. → **213 unit**, vision integration **8** (+ backfill 7).
  - **Verified live** (dev server on 3200, migration `0010` applied): `/vision` still
    renders (Backfill card + gallery); typecheck/lint clean. **Not verified live:** a
    real Telegram video → 10-image sequence → reply — operator gate (bot token +
    poller restart). An older row still shows its pre-change montage description text
    (historical data); new videos use the sequence.
  - Checks: lint ✓, typecheck ✓, unit 213 ✓, vision + backfill integration ✓ (15).
    `db:generate`/`db:migrate` ✓ (`0010_loud_inhumans`). `build` not run (dev server
    live — `dont-clobber-running-dev-server`).

- 2026-07-13 (Priority 7 follow-up): **Gifs and videos now read via ffmpeg frame
  sampling (contact sheet), not the Telegram thumbnail** (user: "vision has to also
  cover gifs and vids — first frame", then: "system ffmpeg, and lets make it
  extract max 10 frames per media (depends on the length), not only 1").
  - **Problem:** Telegram delivers gifs and videos as **mp4**, which sharp cannot
    decode, so the previous code fed the model Telegram's low-res single-frame
    **thumbnail** — not the actual content, and never multi-frame.
  - **Decisions (user):** system `ffmpeg` binary (over bundled `ffmpeg-static` /
    WASM); sample **up to 10 frames scaled by length**, not just one. Recorded in
    Decision Notes.
  - **Design:** frames are sampled **evenly across the whole clip** with ffmpeg
    (`fps=count/duration` → one frame per equal slice, not the opening frames),
    `frameCountForDuration` ≈ 1 frame / **10s** clamped 1–10 (a 70s clip → 7 frames
    ~10s apart; a long clip → 10 frames across its full length), and tiled into
    **one labelled contact-sheet image** (sharp grid, ≤5 cols, 1024px longest edge)
    — so the whole
    vision pipeline stays single-image (no schema change; storage/preview/describe/
    backfill unchanged) and costs one image input per clip. A `contactSheetHint`
    tells the model (describe pass + live reply `note`) that it's ordered frames.
    Telegram's thumbnail is the **fallback** when ffmpeg is unavailable/fails.
  - **New** `features/vision/server/frames.ts` (`frameCountForDuration`,
    `extractVideoFrames` — temp-dir + spawn `ffmpeg`, 60s timeout, always cleans up;
    `composeContactSheet` — square-cell sharp grid; `contactSheetHint`;
    `CONTACT_SHEET_MAX_DIMENSION`). **Changed:** `detect.ts` — video/animation (and
    video documents) now point at the **real media file** with `isVideo` +
    `thumbnailFileId` + `durationSec` (new `DetectedMedia` fields), dropping the
    thumbnail-as-primary and the `image/gif`-direct special case (all video/GIF go
    through ffmpeg); `service.ts` — new shared `loadDetectedMedia`/
    `loadVideoContactSheet` used by both `ingestMessageMedia` and
    `loadReplyTargetImages` (both now also return a `note`); `bot-manager.ts` passes
    the contact-sheet note into the reply turn. Uniform single-image storage: a clip
    stores its sheet in `data_base64` like a photo, so backfill re-describes with no
    re-download.
  - **Tests:** unit `frames.test.ts` (+7: frame-count scaling/clamp, hint wording
    single vs sequence, montage geometry 1/4/6 frames via real sharp),
    `detect.test.ts` updated + `video document` case (+8 net) → **216 unit**. The
    real ffmpeg path (generate a 9s testsrc video → sample 3 frames → compose a
    valid JPEG sheet) was verified with a throwaway probe test, then removed to keep
    the unit suite ffmpeg-independent/fast.
  - **Verified live** (dev server on 3200): `/vision` still renders (Backfill card +
    gallery), no console errors, after the service refactor. **Not verified live:** a
    real Telegram video/gif → contact sheet → reply — needs a real bot token + a
    poller restart (boot-bound singleton), same operator gate.
  - **Follow-up (sampling policy, user):** "not the first frames — take them from
    parts", then "always 10 frames". The `fps=count/duration` extraction already
    spread frames across the whole clip; the count is now a flat
    `VIDEO_FRAME_COUNT = 10` (dropped the duration-scaled `frameCountForDuration`).
    Added an **ffprobe duration fallback** in `extractVideoFrames` so a clip with no
    Telegram-provided duration (video document) is still spread across its full
    length rather than grabbing the leading frames. Verified with a throwaway probe
    (70s testsrc → 10 frames both with a supplied duration and via the ffprobe
    fallback), then removed.
  - **Docker (done):** the runner stage `apk add --no-cache ffmpeg` (verified
    `ffmpeg 8.1.2` installs on `node:22-alpine`; the package also provides ffprobe).
    sharp ships its own musl libvips binary via npm. Playwright's Chromium remains
    the separate deferred Phase-11 native-dep item.
  - Checks: lint ✓ (0 warnings), typecheck ✓, unit 214 ✓, vision + backfill
    integration ✓ (14). `build` not run (dev server live — `dont-clobber-running-dev-server`).

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
  - **Docker note (RESOLVED 2026-07-15):** the runner image is `node:22-alpine`;
    Playwright's downloaded Chromium does not run on Alpine. Fixed by installing the
    distro `chromium` package and pointing the launcher at it via
    `CHROMIUM_EXECUTABLE_PATH`, plus copying the full playwright packages into the
    standalone output (Next's tracer dropped `browsers.json`). A stale top-level
    `import "playwright"` had also been crashing the whole instrumentation hook at
    boot; it is now a lazy dynamic import. See the top session-log entry.
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
    shows the notes editor + members table (a member with aliases; another with
    no aliases; ordered by last-seen); editing notes
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
  null). Verified live: a chat's 4 rows render newest-first with Trace
  links; clicking one opened its `bot-messaging/reply` detail (correlation
  `<chat-id>:867`, reply `messageId:868`). Checks: lint ✓, typecheck ✓, unit 89
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
    record correctly (verified: a chat has 4 rows; the 2nd reply
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
  + description wrapping the users table; a user row with inline alias
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
    plain text); ~~the MVP's LLM "analyzer" addressing fallback for
    other-language/name references in groups (costs an LLM call per group msg)~~
    — **done 2026-07-16, see Current Summary**;
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
| Phase 2: Data Model and Persistence | in-progress | Drizzle schema + migrations + trace repository/recorder + `settings`/`personalities`/`known_users`/`chat_messages` tables; unit 89 + integration 47 (Testcontainers); `db:migrate` verified. `chat_messages` (history mirror) is the first append-only log table — identity PK | Add remaining feature tables (memories/tasks) with their features |
| Phase 3: Configuration and Settings | in-progress | Config moved env→DB (user direction). DB-backed LLM-connection settings (`features/settings/*`, typed columns: base URL/API key/model), `openai` provider client (`server/llm/client.ts`), `GET`/`PATCH` `app/api/settings` + `POST /test-connection` (real `/v1/models` probe); key masked + trace-redacted; verified live. Overview/shell/health reworked onto real probes. Plan Phase 3 realigned to this direction | Add model params/prompts with their features; surface traces in shared Debug UI |
| Phase 4: Telegram Bot Interface | in-progress | In-process long-polling bot (grammy) via `instrumentation.ts` + `server/telegram/bot-manager.ts` singleton; DB-backed token; deterministic addressing; **maintenance mode + owner checks** (owner chosen from the `known_users` dropdown, pure `bot-messaging/policy.ts` id-match, blocked messages traced as skipped); known-user capture on every message; Start/Stop API + Overview control; message traces in the shared Debug UI; verified live. lint/typecheck/test/build ✓ | Live run with a real token (operator-supplied) |
| Phase 5: LLM Conversation Core | in-progress | Provider client (`chatCompletion`) + turn assembly: system prompt (base + active personality) → current-day history window (structured prior turns) → current message; usage/latency + full bodies traced. **MCP tool-call loop** landed (`server/llm/tool-loop.ts` — bounded/stall-guarded, appends tool results to the same messages array); tool calls traced as `external_call` on the reply trace | Memory context blocks landed (priority 10); v1 tool-call safety is in place |
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
| 3 | History feature | done | defined (see 2026-07-12 follow-up 4 log; **completed 2026-07-14** with summarization + vectors + recall tool) | yes (`/history/debug` edit traces + `history window loaded` step on every reply; **`/debug?feature=history-summaries`** for summary runs, full bodies per batch) | yes (shared `/api/traces/**/bundle`) | yes (`format.ts`, `summary.ts` pure core, history + **summarize** integration incl. hybrid search against real pgvector, bot-messaging injection, live tool-selection) | bot messaging, shared traces, DB schema, embeddings, background job model | **Complete.** Recall now spans all of history: 24h window verbatim → literal tools (search/range/by-id) → **`history_recall_topics`** over daily embedded topic summaries. Notes: user-initiated Telegram deletes can't be mirrored (Bot API limitation); the recall tool needs a dev-server restart to enter the boot-bound MCP registry |
| 4 | MCP tools basic support | done | defined (see 2026-07-12 follow-up 7/8 logs) | n/a (pure infra, no feature mutations) — tool **calls** appear as `external_call` events on the bot-messaging **reply** traces in `/debug` | yes (shared `/api/traces/**/bundle`) | yes (mcp registry/openai-tools/tool-loop/mcp-tools-service unit, history search/range integration, bot-messaging tool-event flow) | LLM core, shared traces, history | Live LLM tool round-trip shares the token gate; next → priority 5 (search) |
| 5 | Search MCP tool | done | defined (see 2026-07-13 log) | n/a (read-only tool) — calls appear as `external_call` events on the bot-messaging **reply** traces in `/debug` | yes (shared `/api/traces/**/bundle`) | yes (web-search format/search unit, mcp-tools 4-tool service, settings Tavily-key integration) | MCP basic support | Live LLM + Tavily round-trip shares the token gate; next → priority 6 (visit/read link) |
| 6 | Visit/read link MCP tool | done | defined (see 2026-07-13 log) | n/a (read-only tool) — calls trace under `mcp-tools-link-fetch` | yes (shared `/api/traces/**/bundle`) | yes (url-safety/SSRF, format, fetch-link unit) | MCP basic support | Complete (Playwright/headless Chromium, SSRF-guarded) |
| 7 | Bot messaging: vision | done | defined (see 2026-07-13 log) | shared `/debug?feature=vision` | yes (shared `/api/traces/**/bundle`) | yes (detect/format/normalize unit, vision integration) | bot messaging, media schema, LLM provider | Complete; live photo round-trip shares the operator token gate |
| 8 | Vision backfill background job | done | defined (see 2026-07-13 log) | shared `/debug?feature=vision-backfill` | yes (shared `/api/traces/**/bundle`) | yes (idle-scheduler unit, backfill integration incl. lock + idempotency) | bot vision, background job model | Complete (idle-debounced scheduler + advisory lock) |
| 9 | Scheduled tasks feature | done | defined (see 2026-07-14 log) | shared `/debug?feature=scheduled-tasks` (create/update/delete/**fire** traces) + tool scope `mcp-tools-scheduled-tasks` | yes (shared `/api/traces/**/bundle`) | yes (schedule math, interval-scheduler, fire unit, author rule; service/repository + settings-timezone integration; **full `runDueScheduledTasks` fire→deliver→mirror→advance integration via a capturing sink + deterministic generator — no bot**) | background job model, bot messaging | Complete + verified (create live; fire simulated end-to-end); next → priority 10 (memory) |
| 9.5 (user-requested 2026-07-14) | Self-improvement (👍/👎 feedback → preferences + corrections) | done | defined (see 2026-07-14 log: reaction→menu→answer collection, daily incorporation into versioned per-user preferences + global corrections, prompt injection, clean model names) | shared `/debug?feature=user-feedback` (menu/answer traces) + `?feature=self-improvement` (incorporation runs, full fold bodies) | yes (shared `/api/traces/**/bundle`) | yes (menu codec/options, model-name, reaction filter, due-math, prompt composition + injection unit; full collection→incorporation→injection integration via `simulateUpdate` + capturing feedback transport) | bot messaging, history mirror, known users, shared traces, background job model | Complete; operator gate: poller restart (new `allowed_updates`) + group admin for reactions; live 04:00 fire |
| 10 | Memory feature | done | defined (see 2026-07-15 log) | shared `/debug?feature=memory` (consolidation runs with full merge/reconcile bodies + operator edits) + tool scope `mcp-tools-memory` | yes (shared `/api/traces/**/bundle`) | yes (prompt/format pure unit — 19; memory integration — 23, real Postgres+pgvector: save path, injection, per-person merge, per-note general reconcile, hybrid + pending search, operator edits, tracing) | history, prompts, known users, embeddings, background job model | Complete. Operator gate: dev-server restart for the boot-bound MCP registry (tools) + memory scheduler; a real nightly run spends tokens |
| 10.5 (user-requested 2026-07-15) | Per-chat/group reply language | done | defined (2026-07-15 log): each chat may have an operator-configured reply language (free-text); unset → default **English**; the bot is **strictly** instructed to reply in that language, overriding the message/history/tool/personality language | shared `/debug` — `update-language` traces under `known-users`/`known-groups`; reply traces carry a `language directive` step | yes (shared `/api/traces/**/bundle`) | yes (`lib/language` unit; known-users/known-groups schema unit + integration for `updateLanguage`/`get*Language` incl. survives profile upsert; bot-messaging directive-injection unit) | known users, known groups, prompts, bot messaging, scheduled tasks | Complete + verified live (Users DM-language column PATCH→persist→clear; Group detail Language card). Stored as a `language` column on `known_users`/`known_groups` (a private chat's id = the user id); resolved per reply and per scheduled-task fire and injected as the final system directive before the turn |
| 11 | Analytics dashboard | done | defined (see 2026-07-15 log): live-SQL numeric metrics (volume/tokens/users/model-speed/health) at **day/week/month/all-time** with per-chat/user drill-down + nightly LLM insight (mood, word of the period, top topic) **at every one of those periods** | shared `/debug?feature=analytics-insights` (nightly insight runs, full per-day/period LLM bodies) | yes (shared `/api/traces/**/bundle`) | yes (`period`/`mood`/`prompt` pure unit incl. ISO-week; `analytics.integration` — real Postgres: metrics aggregation + token chat-scope + model-name merge; insight job produce/roll-up across all four periods, idempotent, self-heal, fail-closed) | history (mirror + daily summaries), shared traces, LLM provider, background job model, shared Debug/SSE/job-card UI | Complete + verified live on 3200 (dark-mode render, 3 chart canvases, Day/Week/Month/All-time + Tokens, filter re-query, APIs). Operator gate: a real "Run now" spends tokens; the nightly scheduler is boot-bound (shows **Stopped** until a dev restart) |
| 12 | Image generation | done | defined (see 2026-07-17 log; three decisions recorded): the model calls `image_generate` mid-reply → image is generated on the DB-configured image connection → sent to the chat as a photo → stored in `message_media` and recognized by the existing vision describer, so the bot's own image enters history as a description | shared `/debug?feature=mcp-tools-image-gen` (tool calls) + the `external_call` step on the bot-messaging reply trace | yes (shared `/api/traces/**/bundle`) | yes (`format` 6 + `generate` 5 + `mcp-tools` sink contract 3 unit; `image-gen.integration` 6 real Postgres: media row + normalization + history mirror + ordering + send-failure + no-file-id; settings image-runtime integration 5; **live tool-selection 3** against the real LLM) | settings, LLM provider, MCP tools, **vision** (describer + `message_media`), history mirror, shared traces | Complete + probe verified live. Operator gate: pick an image model on `/settings` → Images (the endpoint already serves `stable-diffusion`), then **restart the dev server** — the MCP registry is a boot-bound singleton, so the new tool is not offered until it re-registers |
| 13 | Browser agent feature | todo | missing | no | no | no | background job model, link/browser policies, shared artifacts | Decide v1 scope and operating model |
| ~~14~~ | ~~Mood feature~~ | **deprecated — dropped (user, 2026-07-16)** | n/a | n/a | n/a | n/a | n/a | **Do not implement.** The bot's own mood state + injection into replies is out of scope permanently; reply behavior is base system prompt + active personality only. Re-adding needs a new user decision. Unrelated to the analytics-only mood score in priority 11 |

## Foundation Progress

Foundation work supports features but is not a substitute for feature completion.

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Settings and health | in-progress | DB-backed settings (`features/settings/*`): LLM connection (base URL/key/model), **active personality** (`active_personality_id`, FK → personalities, `getActivePersonalityId`), Telegram token, and **owner (id chosen from known users, denormalized username) + maintenance mode**; `GET`/`PATCH` + `test-connection` real probe; secrets masked + trace-redacted; pure `getBotPolicy` read; unit + integration tests. Config source is the DB, not env (`config-in-db-not-env`); Overview + `/api/health` probe real state. **Tavily API key** (`tavily_api_key`, masked, `getWebSearchApiKey`) added for the web-search tool | Extend settings columns per feature |
| History | done | `features/history/*` + `chat_messages` table (migration `0006`): 1:1 Telegram mirror (full metadata, unique `(chat_id, telegram_message_id)`); passive capture in `bot-manager.onMessage` + reply mirroring; `getConversationWindow` injects the current UTC-day's messages as structured prior turns (group speaker labels via known-users); `edited_message` mirrored + traced; `/history` (chat list), `/history/[chatId]` (mirror, **newest-first**, each row links to its handling trace via correlation id), `/history/debug`; live-updates over SSE (`history` topic); unit + integration tested; verified live | Vision rows layer here (priority 7); MCP history/search tools for deeper-than-today lookups (priority 4+) |
| Personalities | done | `features/personalities/*` + `personalities` table (migration `0005`) + `settings.active_personality_id` (FK on-delete-set-null): CRUD service (create/edit/delete, CI name-uniqueness + max-32 guards), active selection, `getActivePersonalityPrompt` for composition; `/personalities` page (create/edit/delete/set-active) + `/personalities/debug`; `GET/POST /api/personalities`, `PATCH/DELETE /api/personalities/[id]`, `PUT /api/personalities/active`; every mutation traced; unit + integration tested; verified live | Complete (Mood, which would have extended this table with per-persona defaults, is deprecated — user, 2026-07-16) |
| Embeddings + vector search | done | `lib/embeddings.ts` (`EMBEDDING_DIMENSIONS = 1024`, client-safe) + `server/llm/embeddings.ts` (`embed`/`embedOne`/`probeEmbeddings` on the OpenAI-compatible `/v1/embeddings`; **width-checked against the column width**, so a wrong-size model fails with a clear message instead of an opaque Postgres error inside a job) + DB-backed connection (`embedding_base_url`/`embedding_api_key`/`embedding_model`, falling back to the LLM connection) + a **real** Settings probe. pgvector enabled (migration `0014`); first consumer is `chat_summaries` (HNSW cosine + GIN full-text), searched by the reusable **hybrid RRF** pattern in `features/history/server/summaries-repository.ts`. Verified live: `bge-m3 → 1024 dimensions` against the operator's endpoint. Integration-tested against real pgvector | Reuse for the memory feature (priority 10) — same client, same hybrid-search shape |
| LLM provider core | in-progress | `server/llm/client.ts` (`openai`): `listModels`/health probe + `chatCompletion` (reply text + normalized usage + latency, empty-response→503), base-URL normalization, `ApiError` mapping; connection sourced from DB settings; unit-tested (incl. mocked completion) + verified live | Add context assembly (history/prompts) with priorities 2–3; tool-call loop at priority 4 |
| Telegram intake foundation | in-progress | In-process long-polling `server/telegram/bot-manager.ts` (grammy) — singleton lifecycle, DB-backed token, autostart via `instrumentation.ts` + Start/Stop API; deterministic `features/bot-messaging/server/addressing.ts` + `policy.ts` (owner/maintenance, unit-tested); remembers every human sender to `known_users`; per-message Debug traces; verified live | Live run with a real token |
| Known users | done | `features/known-users/*` + `known_users` table (migration `0004`): captured on every message (profile refresh, aliases preserved); `/users` page with inline alias **and DM reply-language** editing (dedupe/trim; language free-text, empty → default), `/users/debug`; `GET /api/users` + `PATCH /api/users/[id]` (dispatches aliases vs language, each its own traced action); edits traced; owner is chosen from this list. **Language column (`language`, migration `0018`)** governs the bot's reply language in that user's DM. Unit + integration tested; verified live | Use aliases for name-based addressing when the group analyzer lands |
| Dashboard overview | in-progress | `app/page.tsx` on real probes (`server/status.ts`: `SELECT 1` + live `/v1/models`); sidebar bot-status on cheap DB readiness; verified live | Add real metrics + Telegram status once those features land |
| MCP tools | done | `server/mcp/*` (real `@modelcontextprotocol/sdk`, in-process: transport/registry/openai-tools/context/runtime singleton) + `server/llm/tool-loop.ts` (bounded/stall-guarded loop); `features/mcp-tools/*` (`getToolsView`/`getToolset` + read-only `/tools` page + `GET /api/tools`); **all registered tools always available (no on/off)**; tools = history `history_search`/`history_get_in_range` (read) + known-users `update_user_aliases` (write — records a nickname for a chat participant the model resolves by name; `features/known-users/match.ts` + `addAliasByReference`); all chat-scoped via `AsyncLocalStorage`; tool calls traced as `external_call` on reply traces (writes also trace under their own feature); unit + integration tested. **Web-search `search_web`** (Tavily, priority 5) added via the same registrar pattern (`features/web-search/*`, key in DB settings) | Add link (priority 6) tool via the same registrar pattern; images in tool results deferred to vision (priority 7) |
| Debug traces and LLM usage | done | `lib/trace.ts` types + `server/trace` recorder/repository/service on Drizzle; shared Debug UI (`/debug`, `/debug/[id]`, `/settings/debug`) renders steps, LLM request/response + token usage, errors, related ids; JSON bundle download; unit + integration tested; verified live | Add trace-context to the Route Handler wrapper so API calls auto-record; surface a trace link from Overview status cards |

## Shared Infrastructure Progress

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Shared Route Handler wrapper | done | `server/http.ts` (`defineRoute`, `ok`, `parseJson`, **`readJsonBody`** — parse the body once so a PATCH can dispatch by which field is present, `parseQuery`, `toApiError`) + tests | Add trace-context integration when recorder lands |
| Shared error shape | done | `lib/api-error.ts` (`ApiError`, code→status map, envelope) + tests | — |
| Shared trace schema | done | `lib/trace.ts` types (unchanged contract) + **file-backed store** `server/trace/store.ts` (in-memory while mutable → monthly append-only NDJSON logs under `TRACES_DIR`) + `recorder.ts` + `service.ts`, tested Docker-free. **Reworked 2026-07-17 from Postgres to files** (user request — see Decision Notes). Compact analytics *facts* still land in the DB (`trace_facts`, `llm_usage`) via `server/trace/facts.ts` | — |
| Shared log/trace export | done | `jsonDownload` (`server/http.ts`) + `buildTraceBundle`/`buildTraceListBundle` (`server/trace/service.ts`) + `app/api/traces/[id]/bundle` & `app/api/traces/bundle` routes + `DownloadButton`; single + filtered bundle downloads verified live (attachment headers, `trace-bundle@1` envelope) | — |
| Shared dashboard layout | done | `components/layout/AppShell` (responsive rail + mobile drawer), `Sidebar` (config-driven, active state), `Topbar`; theme toggle + tokens | Add breadcrumbs + per-route topbar title as routes grow |
| UI kit tokens/primitives | done | `app/globals.css` semantic tokens (Tailwind v4 `@theme`, `.dark`); `components/ui/*` (Button/Card/Badge/Avatar/Progress/Separator/StatCard/StatusCard/EmptyState/Skeleton/**PageHeader**) + `lib/cn.ts`; barrel is the single entry point (`PageHeader` + `StatusCard` moved into the kit 2026-07-12; no page imports a local primitive; feature UIs like `PersonalitiesManager`/`KnownUsersTable` compose from `Card`/`Field`, no bespoke chrome); **`Tabs`** (accessible tablist/tabpanel, arrow-key nav, controlled-or-uncontrolled) added and first used to split Settings into Core / Integrations; verified live | Extend with Dialog/Toast when features need them |
| Shared form components | done | `components/ui` `Input`, `Textarea`, `Select`, `Label`, `Field` (label+hint+error+aria wiring), `Switch`, `Checkbox`; first consumed by `features/settings/ui/SettingsForm.tsx` | Extract a form-state/submit helper if a 2nd feature form duplicates the fetch/status pattern |
| Shared table/filter components | in-progress | Shared `components/ui/Table` primitives (`Table`/`TableHead`/`TableBody`/`TableRow`/`TableHeaderCell`/`TableCell` — scroll container, borders, header typography, `interactive`/`header` row variants, align/valign). Both `components/debug/TraceList` and `features/known-users/ui/KnownUsersTable` compose from it (no bespoke table markup). Verified live | Add filter/pagination primitives (Debug still uses `DebugFilters`); adopt in new feature tables |
| Shared debug components | done | `components/debug/*` (barrel): `TraceExplorer` (uncapped list + filters + live + export), `TraceList` (clickable rows), `TraceDetail`, `TraceTimeline` (per-step timing), `JsonBlock` (collapsible, theme-aware `react-json-view-lite`), `TraceStatusBadge`, `DownloadButton`, `DebugFilters`; consumed by `/debug`, `/debug/[id]`, `/settings/debug`; verified live (JSON tree, timings, full bodies, theme switch) | Add per-feature Debug pages as thin `TraceExplorer` wrappers (e.g. a bot-messaging section when it gets a dashboard route) |
| Shared realtime (SSE) | in-progress | `lib/realtime.ts` (event contract) + `server/realtime/hub.ts` (in-process pub/sub singleton) + `GET /api/events` SSE stream + `components/realtime/useLiveRefresh` hook + `LiveIndicator` pill. Topics `traces` (Debug), `history` (chat mirror — publishes on record/edit), `users` (known-users — publishes on capture/alias edit) all live; each page drops a `<LiveIndicator topic>` and its service calls `publishEvent`. **Standing rule (user):** every data-display page must live-update via this layer — no manual refresh (memory `live-data-no-manual-refresh`). Verified live: a `users` publish triggered a `/users?_rsc` refetch with the page untouched. Decision: SSE not polling/WS (user) | Publish `bot`/`status` topics from the bot manager + status probes; consume on Overview. Reconcile client-state tables (e.g. `KnownUsersTable` alias input) so live prop changes show |
| Shared timestamp rendering | done | `lib/format.ts` (`formatTimestamp`/`formatTime` — `Intl`-based, per-zone cached, UTC fallback on an unknown zone) + `components/time/TimezoneProvider` (client context seeded once per request by the root layout from `settings.timezone`) + `components/time/Timestamp` (`<Timestamp iso timeOnly? fallback? />`, semantic `<time>`, works in Server + Client Components). **Standing rule: every rendered date/time goes through `<Timestamp>`** — no component formats a date itself, no `toLocaleString()`, no hardcoded UTC, and the zone is never threaded as a prop. All 12 render sites converted; verified live (Europe/Kyiv → `GMT+3` across Debug/History/Vision/Self-improvement/Scheduled tasks) | — |
| Shared status components | done | `components/ui/Badge` (tones+dot), `EmptyState`, `Skeleton`/`Spinner`, refactored `StatusCard`/`PageHeader` onto tokens | Add explicit error panel when debug UI lands |
| Test harness | done | Vitest unit config (57) + Testcontainers integration config (22); `server-only` alias stub; `vi.hoisted`+`vi.mock` pattern for isolating services from persistence (see `bot-messaging/service.test.ts`) | Add Route Handler + dashboard smoke tests per feature |

## Decision Notes

Per user preference, decisions are made by asking the user directly, not by
writing `docs/decisions/*.md`. This table is the lightweight record.

| Topic | Status | Decided by | Decision |
| --- | --- | --- | --- |
| Trace/debug/log storage (2026-07-17) | done | user | **Moved off Postgres to a file-backed store.** Traces live in an in-process store (`globalThis` singleton) **in memory while mutable**; a trace is written **once, on settle**, appended to a **monthly append-only NDJSON log** (`traces-YYYY-MM.ndjson`, keyed on the trace's start month) under a **bind-mountable `TRACES_DIR`** (env bootstrap plumbing, like `PG_DATA_DIR`; container `/app/data/traces`). A boot-owned 60s flush (started/stopped in `register-node`, final flush on graceful shutdown) persists settled traces; ≤60s loss on a hard crash is accepted. Existing DB traces **dropped, no import** (migration `0026`). The public trace API and Debug UI are unchanged. **Process-global store + in-process flush timer accepted** (single-container model, same constraint as the realtime hub). |
| Trace-derived analytics after the file move (2026-07-17) | done | user | Analytics read token usage / per-model speed / per-user tokens / bot reliability from `trace_events`/`traces` via raw SQL — a coupling the file move would have broken. Chose **compact DB fact tables** (migration `0027`): the recorder writes `trace_facts` (one row per settled trace: feature/action/status/time) and `llm_usage` (one row per `llm_response` usage event, trace fields denormalized on) on settle, best-effort and DB-optional; `features/analytics/server/repository.ts` queries those instead. Full debug bodies stay in the files. Rejected: aggregating from the NDJSON files; dropping the metrics. |
| ORM / persistence | done | user | Drizzle ORM + drizzle-kit migrations |
| Settings storage model | done | user | Typed columns, single settings row (`id = 'singleton'`); new settings = new column + migration |
| Configuration source | done | user | Runtime config lives in DB-backed Settings via the dashboard, not env vars (bootstrap-only `DATABASE_URL` stays in env). Status must be a real probe, not env presence |
| LLM API key storage | done | user | Optional API key stored in the DB, masked in UI/API (`apiKeyConfigured` only), redacted from traces |
| Owner field timing | done | user | Deferred to the Telegram intake phase (priority 1) — needs the bot to resolve @username→id |
| Owner selection model | done | user | Owner is **chosen from a dropdown of known users** (users who have messaged the bot), storing the numeric id directly. Supersedes the earlier free-text @username + lazy-resolution approach — no username→id resolution needed since the id is known. |
| Known-user aliases | done | user | Aliases are **operator-curated manual nicknames**, edited inline on the Users page (not auto-tracked username history). Intended for future name-based group addressing. |
| LLM addressing check — name source | done | user | The spoken name is the bot's **Telegram display name** (`getMe.first_name`, carried on `BotIdentity.displayName`). No settings field and no alias list: Telegram already knows the name, and the analyzer covers variations, so a second place to configure it would only drift. Rejected: a settings name+aliases field, active-personality name, both. |
| LLM addressing check — gating | done | user | **Literal regex first, LLM only on a miss.** An exact display-name match short-circuits for free (`source: "name"`); only a group message that names nothing recognizable costs a completion. Rejected: always calling the LLM, a settings toggle for the LLM step, regex-only (which is what already existed and misses the point). |
| LLM addressing check — tracing | done | user | **Every analyzer call is traced**, verdict either way: the trace opens *before* the LLM step and `skip()`s on a negative, so an operator can explain a message the bot ignored. Costs one skipped trace per analyzed group message. Chatter the cheap checks reject stays untraced. Rejected: tracing only positives; adding retention/pruning machinery for skipped traces (revisit if Debug gets noisy in a busy group). |
| History injection model (priority 3) | done | user | **Superseded 2026-07-13 (user):** history is injected as **one `user` message holding an id-anchored transcript** — each line `[#<telegram_message_id>] <sender>: <text>`, replies marked `[reply to #<id>]` (stored target) or with the quoted sender + full untrimmed text inlined (unstored target). The current turn is rendered in the same line format, and groups get a system **addressing hint** (who is asking, how they addressed the bot). Original decision (structured `user`/`assistant` prior turns with group label prefixes) applied until then. Storage keeps **full metadata** (chat id, TG message id, sender id, reply-to, content, timestamps) for a 1:1 mirror. |
| History window scope (priority 3) | done | user | **Superseded 2026-07-13 (user):** the per-reply context window is a **rolling last-24-hours window** (`historyWindowStart`), replacing the original UTC-day boundary (which caused near-empty context just after midnight). Still no message-count or token budget — revisit if a busy group blows the model context. |
| Forum-topic threads (`message_thread_id`) | done | user | **Known limitation, out of scope for now:** threads are not stored, so a forum supergroup's topics interleave into a single history transcript. |
| Telegram edit/delete mirroring (priority 3) | done | agent (constraint surfaced to user) | **Edits** are mirrored via `edited_message` updates. **Deletes cannot be**: the Telegram Bot API delivers no deletion update for ordinary private/group chats (only `deleted_business_messages`, and only for Business connections), so user-initiated deletes are invisible to the bot. `chat_messages.deleted_at` exists to represent deletions we *can* know about (the bot's own deletions, or Business-connection events); it is not populated by ordinary user deletions. |
| Prompt model (priority 2) | done | user | **Full personalities CRUD feature** (corrected from an initial single-field approach). The base system prompt stays a fixed code constant; personas are a `personalities` table with a **dedicated `/personalities` page** (create/edit/delete + **set active**) and `settings.active_personality_id`. The active persona's prompt is composed into every reply. |
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
| Vision recognition timing (priority 7 follow-up) | done | user | Media on an addressed message is **recognized before the reply** (inside `loadVision`, after the addressing/maintenance gates): describe → store the description on the `message_media` row + drop bytes → generate the reply. **Pass split (user, refined 2026-07-14): the describe pass ALWAYS runs (1 vision pass, stored in history); attaching the images to the reply is the CONDITIONAL second pass — only when the message also carries text** (a real question). So a media-only message = **1 vision pass** (reply generated from the recognition text, no images re-sent); media + text = **2 vision passes** (describe + reply-with-images, for a specific question). A replied-to media reference always attaches (explicit "look at this"). Nothing is left to backfill for the addressed message; unaddressed media still uses the backfill job. History display reads `message_media.description` (no `chat_messages.content` mutation). Original decision was recognize *after* the delivered reply. |
| Video/GIF frame sampling (priority 7 follow-up) | done | user | Gifs and videos (Telegram delivers both as mp4, which sharp can't decode) are read by sampling frames with the **system `ffmpeg` binary** (chosen over bundled `ffmpeg-static` / WASM — smallest image; `apk add --no-cache ffmpeg` in the Docker runner stage, **done**). **Always 10 frames**, sampled **evenly across the whole clip, not the opening frames** (ffmpeg `fps=count/duration`; when Telegram gives no duration — a video sent as a document — it is **probed with ffprobe** so frames still span the full clip). **The frames are sent to the model as an ordered sequence of separate full-resolution images, NOT a contact-sheet montage** (user: "sequence of images, model has to vision in order and be told they are a sequence, not detached random images" — the montage approach was tried and replaced). Each frame is normalized individually; `format.toVisionParts` interleaves `Frame k of n:` labels before each image and `format.frameSequenceHint` prefaces them with an explicit "these are consecutive frames of one clip in chronological order, not separate images" instruction (used in both the live reply turn and the describe pass). Storage: `message_media.frames_base64 jsonb` (migration `0010`) holds the frame array (`data_base64` keeps the first frame for the `/vision` preview); both are dropped on describe. Telegram's single-frame thumbnail is the **fallback** when ffmpeg is unavailable/fails. Frames are extracted at ingestion, so backfill re-describes from the stored sequence with no re-download. Cost accepted: up to 10 image inputs per clip. |
| Scheduled tasks creation surface (priority 9) | done | user | **MCP tools + dashboard, NOT owner-gated for creation — any chat participant can create tasks** (user: "just do not limit it to owner, any user can"). The bot exposes `tasks_*` MCP tools so it can set up/list/cancel reminders conversationally, plus a `/scheduled-tasks` dashboard page for CRUD. Diverges from the MVP (which gated the task tools to the owner). Tasks remain **chat-scoped** — the tools operate only on the current chat's tasks (bound via the tool context). **Author-scoped mutations (user follow-up):** every task records an **author** (`created_by_user_id`), and a participant may **edit/cancel only tasks they created** — the `tasks_update`/`tasks_delete` tools reject another user's task (`checkOwnership`). Listing/reading show all of the chat's tasks (with the author). The **dashboard is the operator surface** and is unrestricted (creates author-less tasks shown "via dashboard"). Dashboard-created tasks pick a target chat from known users/groups. |
| Scheduled tasks fire trigger (priority 9) | done | user | **In-process periodic poller** (~30s tick) over external-cron→Route-Handler. The idle-debounced backfill scheduler does not fit (it *defers* while the bot is active, but tasks must fire at their wall-clock time regardless), so a **new sibling shared primitive** `server/jobs/interval-scheduler.ts` is added alongside `idle-scheduler.ts`: a fixed-interval ticker with an overlap guard, started from `register-node`, advisory-locked (`withAdvisoryLock`) so a redeploy can't double-fire. Same single-container in-process-scheduler model already signed off for background jobs. Firing pauses while maintenance mode is on (read fresh per tick). Schedule kinds = once/daily/weekly (cron deferred). **Timezone (user follow-up):** there is **no per-task timezone column** and no Postgres `TZ`; all instants are stored in UTC (`timestamptz`) and every schedule's wall-clock `time_of_day`/`run_date` is interpreted at **runtime against the single configured `settings.timezone`** (read fresh at create/edit/fire) — so changing the operator timezone re-times all tasks, and the dashboard renders next/last-run in that zone. |
| Feature priority reorder (2026-07-14) | done | user | **Mood de-prioritized to lowest (13).** The remaining feature order is now: 9 Scheduled tasks → 10 Memory → 11 Image generation → 12 Browser agent → 13 Mood. Reflected in the Feature Progress table, `NEXTJS_REWRITE_PLAN.md`, and `AGENTS.md`. (The mood-feature design questions — global vs per-chat scope, per-personality vs global baseline, lazy-decay vs background tick — were surfaced but deferred with it; revisit when mood is picked up.) |
| Feedback menu delivery in groups (self-improvement) | done | user | **Inline keyboard posted in the group** (reply to the reacted message), presses accepted **only from the user who reacted** — others get a "this menu is for the person who reacted" toast. Telegram cannot make a group message visible to a single member; DM delivery was rejected because a bot cannot initiate a private chat with a user who never started it. Constraint surfaced: in groups the bot must be an **admin** to receive `message_reaction` updates at all (works out of the box in DMs), and `message_reaction`/`callback_query` must be in the poller's `allowed_updates` (boot-bound). Reaction removals are ignored (v1); a repeat reaction reopens the row and asks again. |
| Feedback "Other" free-text capture (self-improvement) | done | user | **Reply to the menu message**: tapping "Other" edits the menu to "Reply to this message with your feedback"; the pipeline captures a reply to that menu from the reactor as the answer (`feedback_captured` — never answered by the LLM, still mirrored to history). Chosen over "next message from the user" (ambiguous in busy groups). |
| Self-improvement daily run time | done | user | **A Settings field** (`settings.self_improvement_run_time`, `HH:MM` in the operator timezone, default **04:00**) per `config-in-db-not-env`, not a code constant. The job is an interval-scheduler singleton (60s tick) with wall-clock due-math + advisory lock; dashboard "Run now" forces a run. The last-run marker is in-memory — a restart may re-trigger the day's run, which is an idempotent no-op on an empty backlog (accepted). |
| Feedback menu options (self-improvement) | done | user | The proposed **5+5 code-constant lists** — 👍: Helpful & accurate · Right tone/personality · Good length & format · Funny/entertaining · Understood the context; 👎: Inaccurate or wrong · Wrong tone · Too long or rambling · Missed the point/context · Generic or boring — plus "Other — write your own" on each. Stored feedback is the option's text (renames don't corrupt stored rows). |
| Feedback answer acknowledgement (self-improvement) | done | user (2026-07-16) | **No confirmation message** — "its annoying". An answered menu is **deleted**; a button press is acknowledged by a **toast** only (`MENU_RECORDED_TOAST`, via `answerCallbackQuery`). The free-text flow has no callback query to answer, so it sends **nothing** at all — the menu disappearing is the acknowledgement, and the user's own reply is already in the chat. Deletes are best-effort (Telegram refuses >48h; the answer is already stored, so a stale menu is cosmetic). Rejected: keeping the menu with its keyboard removed; deleting only on a press. |
| Feedback self-reflection — timing (self-improvement) | done | user (2026-07-16) | **Detached from the Telegram flow + backfilled by the daily job.** grammy handles updates one at a time, so an inline inference (tens of seconds on the local model) would stall the bot for every other chat; the answer is stored and acknowledged first, then `scheduleReflection` runs the call outside the turn. Because a detached call can be lost (no LLM configured, provider down), `runSelfImprovement` reflects on any completed feedback that still has none before folding it — self-healing, and both folds always see the reasoned form. A reflection that still fails is not a fold failure: the feedback folds from the user's words alone rather than being held back another day. Rejected: inline/blocking; detached with no backfill. |
| Trace correlation for proactive sends | done | user (2026-07-16) | **A trace may settle with the correlation it only learns by acting.** `FinishInput.correlationId` (recorder) + `finishTrace` patch it; `scheduled-tasks/fire` opens on the task id (all it has) and settles on `${chatId}:${messageId}` once Telegram accepts the message, putting it on the app-wide `<chatId>:<messageId>` convention. The task stays linked via `relatedIds`. Found because feedback on a fired message could not reach the prompt that caused it — the reflection degraded to the exchange. **Two knock-ons:** (1) fires now match the chat-scoped trace queries (`correlation_id LIKE '<chatId>:%'`), so **Analytics counts scheduled-task messages against their chat** — previously a UUID correlation excluded them; (2) a correlation is **not unique to a feature**, so any "the trace that produced this message" lookup must be feature-scoped — see the next row. Migration `0024` (hand-written data migration) carries historical fire traces over. Rejected: looking traces up by the `output` event's `data.messageId` (needs a jsonb index and chat-scoping care — `trace_events` carries no chat id); accepting the gap. |
| Producer-scoped trace lookup (self-improvement) | done | agent (constraint surfaced by the above) | `getLatestTraceIdsByCorrelation` gained an optional `features` filter, and `getReplyTrace` scopes to the **message-producing** features (`bot-messaging`, `scheduled-tasks`). Required, not defensive: the feedback flows key `menu`/`answer`/`reflect` traces on the reacted message too, so the unscoped "latest trace on this message" returns a feedback trace — and on a re-run, **the reflection's own previous trace, reading itself**. Verified on live data: scoped → the `scheduled-tasks/fire` trace; unscoped → the `user-feedback/reflect` trace. Covered by a test proven to fail without the scoping. |
| Feedback self-reflection — trace input (self-improvement) | done | user (2026-07-16) | The reflection reads a **curated rendering** of the reply's trace (`renderReplyTrace`): the final `llm_request`'s prompt messages, `external_call` tool args + results, the sent reply, and any failures — clipped at 3k/message, 1k/tool payload, 16k total. Same context discipline as the per-feedback folds: one call must never be able to overflow the model's context. This is **not** a `debug-show-full-raw-bodies` exception — that rule governs what the operator sees in Debug (the full trace is still there, linked); this is what the *model* is fed. Rejected: piping the raw trace events in. |
| Model columns on feedback artifacts (self-improvement) | done | user | `model` on `users_feedbacks`/`users_communication_preferences`/`self_corrections` is **informational only** and always a **clean model name** (`gemma3:12b`, never `docker.io/ai/…` — `normalizeModelName` takes the segment after the last `/`, keeping the `:tag`). Resolved from the reply trace's `llm_response` `usage.model`, falling back to the configured model. |
| Incorporation context discipline (self-improvement) | done | user | Prev version + feedbacks + related exchanges → new version, with **one LLM call per feedback** so a large backlog can never overflow the context, and shared data (persona/system prompt) **stated once per call, never repeated per exchange**. The exchange text (user message + bot reply) comes from the history mirror — same content as the trace bodies without the per-trace boilerplate; the full raw bodies stay one click away on the linked reply trace. A failed/unparseable fold leaves its feedback unstamped for the next run. |
| Vector search scope (history completion) | done | user | **Embed daily topic summaries only** — not every message. The daily job compresses each finished chat-day into a few self-contained topics, each embedded and carrying the Telegram message ids it came from; search finds the topic, the ids lead back to the exact originals. Rejected: embedding every message (an embedding call per message incl. group chatter, a far larger vector table, and noisy hits on "ok"/"lol"), and messages-only-no-summaries (loses the compression that keeps old-context recall token-cheap). |
| Daily job run time | done | user | **One `settings.daily_jobs_run_time` for every daily background job** (self-improvement, history summarization, and any future nightly job) — not a run time per job. They all run overnight for the same reason, so an operator moving that window means it for all of them. Migrations `0015`/`0016` collapse the two per-job columns into it, carrying the operator's existing value across. |
| Embedding backend selection (UI) | done | user | A **"Separate embedding backend" switch** on the Embeddings tab: off (default) = use the same backend as the LLM, and the URL/key inputs are **not shown at all**; on = the URL input appears and is **required**. The switch is **derived from the stored `embedding_base_url`** rather than being its own column — the URL's presence *is* the flag, so they cannot disagree — and turning it off clears both the URL and its key. |
| Retroactive summarization | done | user | The summarization run **drains the entire backlog to the oldest day in one run**, rather than capping at 25 days per night: "go to the very oldest day of history and validate a summary exists for every day since; if missing, make it". The due-scan already had these semantics (missing-or-stale day, oldest first); the cap was the only thing standing between it and full retroactivity. `MAX_DAYS_PER_RUN` survives at 2000 purely as a non-termination safety valve. |
| Embedding endpoint configuration | done | user | Settings gains **its own embedding base URL + API key + model**; a blank URL means "reuse the LLM connection" (and with it the LLM key — a key belongs to the host it authenticates), which is the common case since chat and embeddings are usually served by the same host. A model is mandatory: without one, embedding-backed capabilities stay **off** rather than guessing a model id. Per `config-in-db-not-env` and `verify-real-state-not-env-presence`, the probe (Settings → **Test embeddings**) *actually embeds* a string and reports the returned width — proving reachability, key, model, **and** dimension fit, none of which a `/v1/models` listing establishes. |
| Embedding vector width | done | user | **1024, a code constant** (`lib/embeddings.ts` `EMBEDDING_DIMENSIONS`), not a setting. pgvector cannot index a vector of unspecified width, so the column type itself commits to a size — a "configurable" dimension could not be honoured without recreating the column and re-embedding everything, so it would be a setting that lies. Fits `bge-m3` (which the operator's endpoint already serves — verified live at exactly 1024). Switching to a different-width model is a migration, and the mismatch is caught loudly by the probe/embed path. |
| Old-context recall model (history completion) | done | user | **Tools-only recall**, not an always-injected summaries block. Every reply already carries the last 24 hours verbatim; anything older is fetched *on demand* by `history_recall_topics`, so the turns that need no history cost no tokens. Rejected: injecting recent summaries into every reply (continuity without a tool call, but a permanent per-turn token tax on every trivial message). |
| Background job operating model | done | user | **In-process scheduler started from `instrumentation.ts`**, same lifecycle as the existing bot-manager / MCP registry / Playwright / realtime-hub `globalThis` singletons — chosen over external cron→Route Handler, a separate worker, or on-demand-only. Rationale: single self-hosted container that already runs an in-process poller; a scheduler in the same process needs no new deploy unit, secret, or external cron, and is consistent with the recorded polling decision. Trade-off accepted (this is the required sign-off for an in-process scheduler): won't survive a move to multi-replica without change; isolated behind a shared scheduler primitive so a later move to a worker/cron is contained. DB-backed **locking** via a Postgres advisory lock (`server/jobs/lock.ts`) guards cross-process overlap (e.g. redeploy); **idempotency** is the existing per-row `status='pending'` gating (`describeAndStore` skips non-pending). **Trigger = idle-debounced (MVP parity):** a debounce timer (re)armed on bot activity, aborting the running batch when live traffic resumes so backfill never competes with a live reply. Debounce is a code constant, not a setting (matches `VISION_MAX_DIMENSION`). Establishes the shared model for priorities 8–13 (mood cooldown, scheduled tasks, memory extraction, browser-agent queue). |
| Memory storage model (priority 10) | done | user | **Split by scope, because the two scopes are used differently.** `user` memory = **one merged document per person**, rewritten wholesale by the nightly job (MVP shape) — it is *injected* into replies, and a person is read as a whole, so the model needs the coherent picture rather than the best-matching three lines. `general` memory = **individual, independently embedded fact rows** — it is *retrieved*, never injected, and grows without bound across every chat, so a reply can only afford the few facts relevant to the question, which means each fact needs its own vector; it also makes one wrong fact editable/deletable on the dashboard without rewriting everything around it. Rejected: one document per scope for both (coarse single-vector recall for general, and the dashboard could only edit the blob as a whole). |
| Memory scopes (priority 10) | done | user | **`user` + `general`** (MVP parity). A per-chat scope was considered and declined — `general` already covers group rules/terms/conventions, and a third scope would have to be reasoned about in every tool, prompt, and merge for a case the operator does not have. |
| Memory injection model (priority 10) | done | user | **Inject the memory of the *relevant people*; reach general memory by tool.** Every reply carries the durable facts about the sender **plus, in a group, every known participant** (the sender is always included and is explicitly marked as the person being replied to, so a fact about a bystander is never read as being about them). **No per-reply user cap** (user directive 2026-07-15 — an earlier 12-person cap was removed): only people the bot actually *remembers* contribute anything, so the injected block is already bounded by how much memory exists, not by roster size, and a real fact about a participant is never dropped just because the group is large. This is what lets the bot follow talk *about* someone it knows without being asked to look them up. General memory is deliberately **not** injected — `memory_search` / `memory_get` fetch it on demand — because it spans every chat and would otherwise tax every trivial reply with irrelevant facts. Consistent with the history decision (inject what is always relevant, tool for the rest). |
| Memory write path (priority 10) | done | user | **`memory_save` tool + nightly consolidation job** (MVP parity). The model calls the tool mid-reply when it hears something durable (or is told to remember); the note lands in a pending queue and is folded into durable memory overnight — one LLM merge per *person*, one reconcile per *general note*. Merging per person (not per note) is what makes contradiction resolution possible: the model sees the whole document it is rewriting. Rejected: nightly extraction from history alone (cannot honor an explicit "remember this" until the next night), and doing both (double LLM spend plus dedupe between two write paths). |
| Pending notes are not memory yet (priority 10, user correction 2026-07-15) | done | user | **The pending queue is neither injected into replies nor readable by the memory tools.** Memory is strictly *what survived consolidation* — the merged, deduplicated, contradiction-resolved picture — not a running log of every note ever saved. (My first implementation folded pending notes into both, on the reasoning that "remember X" should be honored on the very next turn; the user corrected it.) **Nothing is actually lost:** a note saved today was said in today's conversation, and that conversation is already carried into every reply verbatim by the 24-hour history window, so folding the raw note back in only restated what the model could already read. The rule also buys a real invariant — **what a tool returns is exactly what the operator sees stored on the dashboard**, with no shadow set of facts that exist only until the next nightly run. Consequence accepted: a fact becomes *recallable across conversations* only after consolidation. |
| `memory_save` must be actively used (priority 10, user requirement 2026-07-15) | done | user | The tool's description is written to make the model **reach for it**, not merely permit it: it states that this is the ONLY way anything is remembered and that a fact not saved is lost permanently (so "I'll remember that" without a call is a false promise); it gives a MUST trigger (any ask to remember/note/not forget) and an explicit proactive trigger list (name/what they want to be called, location, work or studies, family and pets, stable tastes, skills, health constraints, boundaries, recurring plans, standing instructions about behavior); it says proactive saving is **expected, not optional**, and to prefer saving a minor fact over losing one that mattered. Balanced by an explicit do-NOT list (guesses/vibes, passing moods, jokes, insults, one-off plans, chit-chat, re-saving) and a one-fact-per-call, self-contained-sentence rule. Per `tools-self-describe-atomic` this lives entirely in the tool description — the system prompt neither lists nor describes tools. |
| Analytics placement (priority 11, 2026-07-15) | done | user | **Build the analytics dashboard now, ahead of Image generation.** Inserted as priority 11; Image generation → 12, Browser agent → 13, Mood → 14. |
| Analytics mood & health (priority 11) | done | user | **LLM mood + deterministic health.** A nightly LLM pass scores each chat's mood/sentiment (0–100) per day; "health" is cheap deterministic signals (activity, 👍/👎 ratio, error rate, reply latency). This is **analytics-only mood** — an observation *about* the chat, shown on the dashboard. It never touches the bot's behavior, and it is unaffected by the deprecation of the Mood feature (the bot's own persona state, dropped 2026-07-16) — the two never shared tables. |
| Analytics text insights (priority 11) | done | user | **Word of the period and most-discussed topic are both LLM-derived**, produced by the nightly insight job's period roll-up pass over the day rows (not deterministic word-frequency). |
| Analytics breakdown (priority 11) | done | user | **Global + per-chat + per-user drill-down.** Numeric metrics filter by chat or user (mutually exclusive URL params); LLM insight roll-ups are stored per (granularity, bucket, scope) for global and per-chat. |
| Analytics numeric metrics = live SQL (priority 11) | done | agent (flagged in plan, user-approved) | **Numeric metrics (message/token/latency volumes, users, models, health) are aggregated live with Postgres `date_trunc` + `GROUP BY` over the base tables, NOT stored rollups.** Exact and self-healing (a late edit/CSV import needs no rollup rebuild — the same problem `chat_summary_days` had to engineer around). Only the expensive LLM-derived insight (mood/word/topic), which can't be recomputed per page view, is precomputed by the nightly job into `chat_day_insights` (per chat-day scoring) + `period_insights` (day/week/month/all roll-ups × global/per-chat). Honors the user's "idle jobs similar to vision backfill" for exactly the metrics that need it. |
| Analytics self-healing → explicit regenerate (operator correction 2026-07-16) | done | user | **Remove the magic healing; allow drop-and-regenerate per period (day/week/month/year/all).** Both self-heal scans are deleted — the missing-period reconciliation and the day re-score on message-count drift. A day is owed only when never scored. Regenerate semantics (user choice of three offered): **always everything** — drop the day scores *and* the roll-ups for the period and re-run the whole LLM pipeline. Consequence the user accepted: every regenerate costs a full re-score of each day in range; and a scored day is never corrected automatically (a late-arriving message on a scored day needs an explicit regenerate). |
| Analytics insight drift is silent by design (2026-07-16) | done | user | **No staleness machinery — the regenerate control is enough.** Context: with self-heal gone, a scored day never notices later changes. Mid-day runs are *not* the risk (only finished days are ever scored, `insight_date < today` in the configured tz); the risk is messages landing on a finished day via **CSV history import, edits, or a timezone change**. A read-only drift signal (live-vs-stored `message_count` → badge + "regenerate stale days") was offered and **declined**: the operator will regenerate the affected period when they know they have imported or edited history. Also declined: a re-scorable partial "today" — **finished days only**. Consequence accepted: after a history import, affected days keep their old scores silently until regenerated. Do not re-add self-healing to "fix" this. |
| Analytics per-card filters (operator correction 2026-07-16) | done | user | **No global filter bar — every card carries its own filters/tabs**, and (user choice) that means **period tabs + chat/user select per card**, not a page-level scope. Exceptions, per the user: **Bot health, Model performance, Top users** take no filters and cover **all time**. Forced the split of the single `getMetrics` payload into per-card reads (`getMetricTotals`/`getSeries`/`getSystemStats`) so a card re-queries only itself. Agent call inside this decision: the four traffic tiles share one filter set (a filter bar per tile would be bigger than the tile) — flagged to the user as reversible. |
| Analytics `year` granularity (operator correction 2026-07-16) | done | user | **`year` is a first-class period everywhere** (day/week/month/year/all), not just an option on the regenerate control — card tabs, bucket math, SQL date filter, mood trend, and the insight roll-ups. A scored day now writes 10 roll-ups (5 granularities × global/chat) instead of 8. |
| Analytics Bot health (operator correction 2026-07-16) | done | user | **"Chat health" → "Bot health"; drop the composite `Health n/100`, Active users, and Feedback tiles.** The user's reason for the score: *"it is subjective"* — it averaged unlike signals with invented weights and read as authoritative. The other two duplicated the Users tile and the satisfaction tile. Agent addition, accepted as in-scope: `avgReplyLatencyMs` is now measured from `bot-messaging`/`reply` calls only (it previously averaged every LLM call, so vision and nightly jobs inflated "Avg reply"). |
| Analytics model performance by request type (operator correction 2026-07-16) | done | user | **Measure every type of request separately** — *"vision takes longer in general than just text generation, reply generation can take longer than some aux simple request"*. Implemented by grouping LLM usage on the trace's own **(feature, action)** taxonomy alongside the model, with p50/p95 from `percentile_cont` beside the mean. Consequence: the model name must be normalized **in SQL** (percentiles are computed by the aggregate and cannot be merged in JS afterwards), so `normalizedModelExpr` mirrors `normalizeModelName` under the same JS↔Postgres agreement rule as `period.ts`. Model-level latency is deliberately not shown — it would be a mean over unlike request types. |
| Passive memory extraction — cadence (2026-07-16) | done | user | **Nightly, as a second pass inside the existing memory job** (extract → consolidate, one advisory lock), not a new scheduler and not idle-debounced. Extraction runs first so a day's facts reach durable memory the same night. Rejected: idle-debounced like the vision backfill (fresher, but notes still wait for the nightly consolidation, so the freshness buys nothing); a separate idle extractor + nightly consolidator (more moving parts for the same end state). |
| Passive memory extraction — scope (2026-07-16) | done | user | **All chats, all human messages**, batched per chat-day so the model reads conversation rather than isolated lines. Private chats are included even though their reply path already had a chance to save: a reply only saves what the model happened to think worth saving. Rejected: groups-only (halves cost but leaves DMs on the weaker path); known-users-only (general facts would still need everyone's messages read anyway). |
| Passive memory extraction — `known_users` ceiling (2026-07-16) | done | user | **Left alone as a `known_users` problem — then solved from the other side.** The dev DB has 1 `known_users` row against 4 senders in history, so per-person documents can only exist for registered users. The operator declined to investigate or backfill `known_users`; instead they redirected the fact itself — see the next two rows. A fact about an unregistered person is now kept in **general** knowledge, named. So nothing is lost for want of an id, and `known_users` coverage stays a non-issue. |
| General memory — storage shape (2026-07-16) | done | user | **One merged document, replacing the individually embedded fact rows.** Reverses the original "rows because general memory is retrieved, so each fact needs its own vector" decision. Consequences accepted: no embeddings/HNSW/FTS for the scope, the nightly pass becomes a merge (one LLM call per run instead of one per note), per-fact edit/delete on the dashboard becomes one textarea (as user memory already is), and existing facts are concatenated into the document on migration `0022` for the next merge to tidy. Rejected: keeping rows and merely concatenating them at injection time (keeps machinery whose purpose — retrieving only the relevant few — no longer exists). |
| General memory — injection + tools (2026-07-16) | done | user | **Injected into every reply; dropped from `memory_get`/`memory_search`** (kept in `memory_save`, which is how it is written). Reverses "general memory is tool-only". Rationale for injecting: knowledge the model must choose to look up is knowledge it mostly does not use; the nightly merge is what keeps the document bounded. Rationale for dropping it from the read tools: the whole document is already in context, so a tool call would spend a round-trip returning the model its own prompt. Cost accepted and flagged: the document now consumes context on *every* reply, uncapped — same as the per-person documents. |
| Mood feature deprecated (2026-07-16) | done | user | **The Mood feature is dropped from the plan — do not implement it.** The bot's own mood state and its injection into replies (MVP behavior, previously priority 14 and already de-prioritized to lowest on 2026-07-14) is deprecated outright. Reply behavior is governed by the base system prompt + the active personality only; no mood state, no mood cooldown job, no mood dashboard page, no per-persona mood defaults on the `personalities` table. Removed from the priority list in `NEXTJS_REWRITE_PLAN.md` (now recorded under "Dropped features"), `AGENTS.md`, and the Feature Progress table. Nothing to revert in code — the feature was never started. **Explicitly out of scope:** the **analytics-only** mood score (priority 11), which is a dashboard observation about a chat and never affected the bot; it stays. Re-adding bot-facing mood needs a new decision from the user. |
| Provider errors are relayed to end users (2026-07-17) | done | user | **The model sees the raw provider error and may repeat it in chat — left that way deliberately.** Context: once `fetchWithErrorDetail` started surfacing real error bodies, the bot began explaining backend faults to the operator in Telegram (*"a type mismatch error—Half vs float"*) instead of "It failed. Typical." The trade was put to the user and accepted: this is a personal bot, and an in-chat diagnosis is worth more than hiding internals. **Consequence accepted:** a non-operator in a group who asks for an image can see infrastructure detail (model ids, backend error text) that a sanitized message would have withheld. The alternative offered and declined was to hand the model a plain "the image backend failed" while keeping the full error in the trace (`/debug` is unaffected either way — it always records the raw body per `debug-show-full-raw-bodies`). Revisit if this bot ever serves people other than the operator. |
| Image generation — provider boundary (priority 12, 2026-07-17) | done | user | **OpenAI-compatible `/v1/images/generations` on its own DB-backed connection** (MVP parity): new `image_base_url` / `image_api_key` (masked) / `image_model` settings that **fall back to the LLM connection** when the base URL is blank, plus a real Settings probe — the exact shape `getEmbeddingRuntime` already uses, so image gen can point at a different box than chat without forcing one. Response is `b64_json` (Ollama's endpoint and the GPT image models return no URLs). Rejected: an image model on the LLM connection only (cannot split hosts); a pluggable provider interface (upfront abstraction for a second provider that may never exist — the OpenAI shape is the only one in play). |
| Image generation — trigger (priority 12, 2026-07-17) | done | user | **Tool only** — one `image_generate` MCP tool the model calls mid-reply, registered through the same registrar pattern as every other tool. No operator-facing generate form: it would be a second producer with its own trace path, and the dashboard surface is covered by the media the runs already write. Per `tools-self-describe-atomic` the trigger rules live entirely in the tool description. |
| Image generation — the generated image is stored as *media*, not as its own store (priority 12, 2026-07-17) | done | user | **Send the image, then store the vision recognition of it, exactly like user-sent media** — *"we have to store vision recognition of that image, similar to user sent media"*. So there is **no new images table and no new gallery**: the sent photo lands in `message_media` (`status = 'pending'`, real Telegram `file_id` taken from the `sendPhoto` response), the existing vision describer turns it into text, and the bytes are dropped on describe — the same lifecycle, retention, and `/vision` surface user media already has. Two things fall out of this, and both are the point: the bot's own drawing enters **history as a description**, so later turns know what it drew; and retention needs no new setting, because "drop the bytes once described" is already the rule. Rejected: a dedicated images table + gallery (duplicates `message_media` and would need its own retention); send-and-forget (no recognition at all, so the bot forgets its own image the moment it sends it). |
| Memory accuracy — an unidentifiable person's fact is **dropped** (priority 10, operator correction 2026-07-17) | done | user | **Drop it**, and make extraction **alias-aware** so far fewer people are unidentifiable in the first place — *"drop unresolved, but make sure memory extraction knows about aliases of users"*. Both producers of the pending queue (the `memory_save` tool and the nightly extraction) previously did the opposite: on failing to resolve a person they re-filed the fact as `general` knowledge with the person's name written into the sentence ("Bob lives in Porto"), explicitly instructed to *"Never drop such a fact"*. That was the single biggest source of wrong memory in prod: `general` is one merged document with **no identity model**, so name-keyed biography accumulated there and the merge pass fused lines about different people into one subject — a nickname the bot could not resolve grew into a person of its own, inheriting other people's facts. `general` is now knowledge about **nobody** (definitions, rules, conventions), the merge prompt actively prunes biography out of the existing document, and person facts require a real `known_users` id. The alias half is what makes the drop cheap rather than lossy: `known_users.aliases` was already operator-curated and already injected into DM replies, but the extraction roster was built from the `First Last (@username)` label alone, while a group only ever speaks in nicknames — so the roster is now rendered `[id:N] Label — also called: …`. Rejected: quarantining name-keyed facts in a separate store (keeps the facts, but needs a schema + merge pass for data whose subject is by definition unknown); leaving `general` as-is and relying only on a higher evidence bar (the merge could still conflate identities). |
| Memory accuracy — a fact about a person must be **first-person** (priority 10, operator correction 2026-07-17) | done | user | **Store a fact about a person only when THAT PERSON stated it about themselves** (or explicitly confirmed it); third-party claims are hearsay and are dropped. This directly reverses the old rule *"Attribute a 'user' fact to the person it is ABOUT, not the person who said it"*. Diagnosed from prod: the wrong memory *"Ігор worked at big companies such as LastPass"* was **not a hallucination** — a real message said it, as one person speculating about a third party, and *"like LastPass"* was an **example**, not an employer. So the failure was never invention; it was trusting gossip and reading an example as a claim. The rule is shared policy in `features/memory/prompt.ts` (`FIRST_PERSON_EVIDENCE_RULE`) so both queue producers agree — a sentence must be worth remembering identically whether or not the bot happened to be addressed. Shipped alongside two supporting prompt rules from the same diagnosis: examples/hedged claims are not facts, and meme/copypasta script formats (`Name: … Other: …`) are performance, not testimony. Rejected: allowing plain third-party claims but filtering hedges (still leaky — the LastPass line was stated plainly enough); no change (leaves the actual observed defect in place). |
| Analytics periods + metric (priority 11, operator correction 2026-07-15) | done | user | **Periods are day / week / month / all-time** (not hour/day/month/year/all — the first cut had the wrong set and no week), and this selector drives **every** metric, **including word of the period and most-discussed topic**, which must exist at each of the four periods (the first cut computed them only at month/year/all). The **"characters processed/generated" metric is replaced by tokens** (processed = prompt, generated = completion) — the LLM-meaningful measure. Implemented by scoring a per-day **word** too (`chat_day_insights.word`, migration `0020`) and rolling every day up into day/week/month/all `period_insights`; tokens read from `bot-messaging` usage events, chat/user-filterable via the trace `correlation_id`/`trigger_actor`. |

## Blockers

No blockers recorded.

## Next Agent Notes

- Read `NEXTJS_REWRITE_PLAN.md` first.
- Confirm v1 scope before implementation.
- Do not copy MVP modules by default.
- Keep shared patterns ahead of feature-specific code.

### State at handoff (2026-07-17, after image generation)

- **Current state:** priority 12 (**image generation**) is built and green — lint ✓,
  typecheck ✓, 452 unit ✓, full integration ✓ (247 passed / 21 skipped, **no
  failures**), build ✓, plus 3/3 live tool-selection cases against the real local
  LLM. Migration `0025` (image connection columns) **has been applied** to the
  operator's dev DB. **Priorities 1–12 are now done**; the only v1 feature left is
  **priority 13, the browser agent**, which is `todo` with **no acceptance criteria
  and no agreed v1 scope** — it needs a decision from the user before any code, the
  same way image generation did.
- **The pre-existing `process-update.integration.test.ts:111` failure is gone** —
  commit `81c08ce` updated the test for the analyzer path. Do not go looking for it;
  the full integration suite is clean.
- **Image generation is configured and live, and the app half is proven** (the
  operator saved `stable-diffusion:Q4`, restarted, and asked for a cat — trace
  `8d117ce3…`). The bot picked the tool, wrote a real prompt, and told the truth when
  it failed. **The blocker is entirely outside this repo:** that image model 500s on
  every request shape with `Input type (c10::Half) and bias type (float) should be
  the same` — an fp16/fp32 dtype fault in the backend itself. **Do not go looking for
  a bug in `server/llm/images.ts` or the tool** — five request variants were probed
  against the live endpoint and all fail identically, including a bare
  `{model, prompt}`. It needs a fixed image backend, or a different host in
  Settings → Images (the connection is separable for exactly this reason).
- **The one thing left unproven is a successful draw.** Delivery + media ingestion +
  recognition are covered against real Postgres with a synthetic PNG, but no real
  generated image has ever come back. First thing to do once an image backend works:
  ask the bot to draw, then check `/vision` for the pending row and the description
  the backfill writes for the bot's *own* picture.
- **Image bytes never go through a tool result — keep it that way.** They ride the
  turn's `collectImage` sink on `McpToolContext`. A "simplification" that returns them
  in `structuredContent` would put ~1MB into the model's context *and* verbatim into
  two trace rows, and would need a redaction step someone will eventually forget. The
  sink contract is pinned by `mcp-tools.test.ts` (including
  `JSON.stringify(result)` not containing the bytes).
- **Do not pass the prompt to the describer** when a generated image is recognized.
  It reads like free context and it destroys the point: a describer told what the
  picture should contain paraphrases the prompt instead of reporting what the model
  actually drew. Pinned by an integration test on the provenance-only hint.

### State at handoff (2026-07-16, after passive memory extraction)

- **Current state:** two memory changes shipped this session — **passive extraction**
  and **general memory as one injected document** — both complete and green (lint ✓,
  typecheck ✓, 440 unit ✓, 38 memory integration ✓, build ✓), and both **verified
  live** against the real local LLM and the operator's real data. Migrations `0021`
  (`memory_extraction_days`) and `0022` (general document) **have been applied** to
  the operator's dev DB; the 5 pre-existing general facts survived as one document.
- **The first full extraction run has already happened.** All 14 chat-days are read,
  and the operator's `/memory` shows a real per-person document built from
  conversations the bot was never addressed in. 3 of those days (`2026-07-03/04/05`)
  were read by the **pre-roster-fix** run; the operator chose to leave their markers
  rather than re-read them. **Do not "helpfully" clear them** — that was asked and
  declined.
- **Next best task:** watch a real reply now that general knowledge is injected —
  `/debug?feature=bot-messaging`, the `long-term memory loaded` step. Two things to
  judge, both prompt-quality rather than mechanics: whether the general document is
  earning its place in every prompt (it is uncapped, like the per-person documents),
  and whether the bot over-recites what it knows. Everything mechanical is pinned by
  tests.
- **Restart the dev server after editing a job** — the scheduler is a boot-bound
  `globalThis` singleton and HMR does *not* replace the captured `runJob`; a
  `Run now` after an edit silently executes the old closure and looks like your
  change did nothing. This bit us once already. Dev LLM tokens are free; a full
  extraction pass is just slow (~27s/day), not hung.
- **Prompt-tuning map.** `EXTRACTION_SYSTEM` (`features/memory/extract-prompt.ts`)
  decides what gets harvested; `USER_MERGE_PROMPT`/`GENERAL_MERGE_PROMPT`
  (`features/memory/prompt.ts`) decide what survives. The durability rules
  (`DURABLE_FACT_KINDS` et al, also in `prompt.ts`) are **shared with the
  `memory_save` tool description**, so editing them moves both producers — that is
  deliberate (the same sentence must be worth remembering whether or not the bot was
  spoken to), but tune the extraction-only prose if you mean to change just one.
- **Both merges fail closed, and must stay that way.** An empty/unusable merge leaves
  the document untouched and the notes pending. It is the only thing standing between
  one bad model response and a document that took months to accumulate. Pinned by
  tests for both scopes; do not "simplify" it into trusting the model.
- **Known pitfall:** `server/telegram/process-update.integration.test.ts:111` fails
  on clean `main` (pre-existing; commit `9f04e87`'s analyzer opens a trace the test
  expects not to exist). Do not assume you broke it — verify against a stash before
  chasing it. It needs a decision, not a patch.
- **Editing this file from PowerShell will corrupt it.** `Get-Content -Raw` +
  `Set-Content -Encoding utf8` reads UTF-8 as cp1252 and writes it back
  double-encoded, mangling every `—`/`✓` in the document (and adding a BOM). It
  happened this session and had to be reverted with `git checkout`. Use the editor
  tooling, not shell text substitution.
- **Commands that passed:** `npm run lint`, `npm run typecheck`, `npm run test`,
  `npm run test:integration -- features/memory`, `npm run build`.
  `npm run test:integration` (full) fails **only** on the pre-existing case above.

### Fix: trace tools + web-search-over-read + memory_save subject binding (2026-07-15)

Three issues surfaced from live reply traces (`b8cb05c3…`, `be32b8ad…`):

- **Request trace was pieces, not the full body.** The `llm_request` event recorded
  only `messages` (no `model`/`tools`); the real body is built behind the
  `generateReply` boundary. Fix: `chatCompletion` + `chatCompletionWithTools` gained
  an `onRequest(requestBody)` hook that fires with the exact body just before the
  provider call; `generateReply` threads it through, and the bot-messaging service
  records that whole body verbatim (symmetric with how `responseBody` is recorded),
  via new `sanitizeRequestBodyForTrace` (spreads the body, redacts only inline image
  bytes in `messages` per `vision-image-bytes-redacted-in-traces`). Firing before the
  provider call keeps event order (request → tool calls → response) and latency
  accurate. Honors `debug-show-full-raw-bodies`.
- **`search_web` chosen when a specific URL was already given.** `read_page` was
  offered but `search_web`'s description didn't exclude the known-URL case. Fix:
  tightened `SEARCH_WEB_DESCRIPTION` to "discover pages when you do not already have
  a URL" + an explicit "do NOT open a URL already in the conversation" (no
  cross-tool naming — `tools-self-describe-atomic`). New live regression case in
  `link-fetch/…/tool-selection.integration.test.ts`.
- **`memory_save` broken.** Tool told the model to pass "their numeric id from the
  conversation context," but no numeric id is ever injected → model hallucinated a
  `user_id` from the sender's @username → service rejected it. Fix (user decision: *resolve from
  context / bind sender*): `memory_save`/`memory_get` now take an optional `person`
  (name/@username, never an id); omitted → the bound speaker (`McpToolContext.userId`),
  named → resolved against chat participants via the new shared
  `resolveChatUserByReference` (extracted from `addAliasByReference`, which now reuses
  it). Descriptions rewritten to drop the numeric-id demand.
- **Proof:** `npm run lint` clean, `npm run typecheck` clean, `npm run test`
  **355 unit** pass. Not yet verified live against a real Telegram reply; the
  `LLM_LIVE=1` tool-selection cases and a fresh reply trace are the live checks.

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
