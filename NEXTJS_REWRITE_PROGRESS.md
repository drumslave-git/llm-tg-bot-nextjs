# Next.js Rewrite Progress

Use this file as the working progress ledger for agents. Update it before and after substantial work.

Status values:

- `todo`
- `in-progress`
- `blocked`
- `done`
- `deferred`

## Current Summary

Status: todo
Owner: unassigned
Last updated: not started
Next: define acceptance criteria for priority 1, bot messaging text receive/reply

## Phase Progress

| Phase | Status | Proof | Next |
| --- | --- | --- | --- |
| Phase 0: Product and Behavior Inventory | todo | none | Define v1 must-have/nice/drop list |
| Phase 1: Next.js Foundation | todo | none | Establish folder boundaries and scripts |
| Phase 2: Data Model and Persistence | todo | none | Design v1 schema and trace/log tables |
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
| Settings and health | todo | none | Define env and DB-backed settings schemas |
| LLM provider core | todo | none | Design provider client and error handling |
| Telegram intake foundation | todo | none | Decide webhook-first route shape |
| Dashboard overview | todo | none | Define status cards |
| Debug traces and LLM usage | todo | none | Design shared trace schema |

## Shared Infrastructure Progress

| Area | Status | Proof | Next |
| --- | --- | --- | --- |
| Shared Route Handler wrapper | todo | none | Design error/validation/trace wrapper |
| Shared error shape | todo | none | Define API error schema |
| Shared trace schema | todo | none | Design DB tables and TS types |
| Shared log/trace export | todo | none | Define JSON bundle format |
| Shared dashboard layout | todo | none | Replace starter page |
| Shared form components | todo | none | Define field/error pattern |
| Shared table/filter components | todo | none | Define pagination/filter API |
| Shared debug components | todo | none | Define trace list/detail/download UI |
| Shared status components | todo | none | Define status card/badge pattern |
| Test harness | todo | none | Choose unit/route/dashboard tooling |

## Decision Notes

Add a row for every required case-by-case design note. Store notes under `docs/decisions/`.

| Topic | Status | File | Decision |
| --- | --- | --- | --- |
| Telegram webhook vs polling | todo | none | undecided |
| Realtime polling vs SSE vs WebSocket | todo | none | undecided |
| Background job operating model | todo | none | undecided |
| MVP data import | todo | none | undecided |

## Blockers

No blockers recorded.

## Next Agent Notes

- Read `NEXTJS_REWRITE_PLAN.md` first.
- Confirm v1 scope before implementation.
- Do not copy MVP modules by default.
- Keep shared patterns ahead of feature-specific code.
