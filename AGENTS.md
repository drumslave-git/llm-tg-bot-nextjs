# Agent Guide

This repository is
[drumslave-git/llm-tg-bot-nextjs](https://github.com/drumslave-git/llm-tg-bot-nextjs),
a greenfield Next.js rewrite/recreation of the MVP in
[drumslave-git/ollama-tg-bot](https://github.com/drumslave-git/ollama-tg-bot).

In the current workspace, agents are inside the `llm-tg-bot-nextjs` repository.
The old MVP sources are available at `../ollama-tg-bot` when local comparison is
needed. Do not hardcode absolute filesystem paths in docs, code, scripts, or
tests.

The old project is a behavior/reference source only. Do not treat it as code to
mechanically migrate. Do not design phases where the old and new apps run
together, proxy to each other, share runtime state, or communicate.

## Required Reading

Before doing implementation work, read:

1. `NEXTJS_REWRITE_PLAN.md`
2. `NEXTJS_REWRITE_PROGRESS.md`
3. Relevant installed Next.js docs under `node_modules/next/dist/docs/`

This is not optional. The installed Next.js version may have APIs and
conventions that differ from memory or older documentation.

## CodeGraph

This repository is indexed by CodeGraph. Use CodeGraph before grep/find/manual
file reading when you need to understand or locate code.

- Prefer `codegraph_explore` when available.
- Shell fallback: `codegraph explore "<question or symbols>"`.
- If a `.codegraph/` directory is missing in a future worktree, skip CodeGraph;
  indexing is the user's decision.

## Core Direction

This is a rewrite, not a migration.

- Build clean Next.js-native architecture.
- Reuse MVP code only when it is clearly still the best shape.
- Preserve useful product behavior, not old implementation boundaries.
- Use standard Next.js capabilities first: App Router, Route Handlers, Server
  Components, Client Components, `instrumentation.ts` where appropriate,
  standard env handling, `next dev`, `next build`, and `next start`.
- If a capability appears unsafe or impossible with supported Next.js
  mechanisms, stop and ask the user before adding custom infrastructure (see
  Decision Notes below).

## Engineering Standards

Code must be clean, readable, and DRY.

- Features must follow shared patterns.
- Shared behavior belongs in shared modules, hooks, services, schemas,
  utilities, and components.
- Avoid case-by-case implementations for APIs, errors, traces, debug pages,
  forms, tables, status UI, pagination, filtering, timestamps, and exports.
- If similar code appears in two places, consider extracting it. By the third
  use, make it shared unless there is a documented reason not to.
- Route Handlers should be thin. Validation, authorization, business logic,
  persistence, trace recording, and error mapping belong in shared server code.
- Server-only logic must not leak into client bundles. Use server-only module
  boundaries for database, filesystem, Telegram, Playwright, LLM credentials,
  and secrets.

## Feature Contract

Every feature must follow the standard feature contract from
`NEXTJS_REWRITE_PLAN.md`.

A feature is not done until it has:

- explicit acceptance criteria
- server-side service logic
- validated input/output schemas
- typed persistence where needed
- Route Handlers using shared wrappers
- normal dashboard UI where applicable
- dedicated Debug page
- trace recording for every meaningful action
- downloadable JSON log/trace bundle
- tests for service logic, Route Handlers, and critical UI/debug behavior

Debug pages must use shared debug components unless the feature has a genuinely
unique visualization need.

## Feature Priority

Follow the authoritative order in `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md`.

Current priority order:

1. Bot messaging: text receive/reply
2. System and personality prompts
3. History feature
4. MCP tools basic support
5. Search MCP tool
6. Visit/read link MCP tool
7. Bot messaging: vision
8. Vision backfill background job
9. Scheduled tasks feature
10. Memory feature
11. Analytics dashboard (inserted ahead of Image generation by the user, 2026-07-15)
12. Image generation
13. Browser agent feature
14. Voice messages (added by the user, 2026-07-23)

The Mood feature (the bot's own mood state injected into replies) is
**deprecated and dropped** by the user (2026-07-16). Do not implement it, and do
not re-add it to the priority list without a new decision from the user. Reply
behavior comes from the base system prompt plus the active personality only.
This does not touch the analytics-only mood score in the Analytics dashboard
(priority 11), which stays.

Features not listed there are not v1 by default. Add a feature to the tracker
with explicit priority, acceptance criteria, and dependencies before
implementing it.

## Progress Tracking

Track progress in repository files, not only in chat.

Update `NEXTJS_REWRITE_PROGRESS.md` before and after substantial work.

Use these statuses:

- `todo`
- `in-progress`
- `blocked`
- `done`
- `deferred`

For every `done` item, record proof:

- files changed
- tests run
- build/typecheck/lint status where relevant
- remaining risks

For every `blocked` item, record:

- blocker
- attempted approach
- next decision needed

At handoff, update "Next Agent Notes" with current state, next best task,
known pitfalls, and commands that passed or failed.

## Decision Notes

Per user preference, non-standard infrastructure or behavior decisions are
made by asking the user directly and recording the outcome in the Decision
Notes table in `NEXTJS_REWRITE_PROGRESS.md`. Do not write
`docs/decisions/*.md` files.

Asking first is required for:

- Telegram polling instead of webhook Route Handler
- Socket.IO or custom WebSocket server
- long-running in-process schedulers
- custom Node server
- separate worker service
- MVP production data import
- Playwright browser lifecycle beyond per-job execution
- process-global mutable state

When asking, present the problem, standard Next.js option considered, why it
is insufficient, alternatives, recommended design, operational impact, and
failure/rollback behavior.

## Next.js Rules

This is not necessarily the Next.js you remember.

Read the relevant guide in `node_modules/next/dist/docs/` before writing code
that depends on Next.js APIs, file conventions, runtime behavior, caching,
Route Handlers, Server Components, Client Components, instrumentation, or
self-hosting.

Heed deprecation notices from the installed docs and build output.

## Verification

Before marking work done, run the narrowest meaningful checks first, then the
broader checks when the change is large enough:

- `npm run lint`
- `npm run typecheck` once configured
- `npm run test` once configured
- `npm run build`

If a check cannot be run, record why in `NEXTJS_REWRITE_PROGRESS.md`.
