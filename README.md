# llm-tg-bot-nextjs

A Next.js rewrite of the [ollama-tg-bot](https://github.com/drumslave-git/ollama-tg-bot)
MVP: a Telegram bot powered by an OpenAI-compatible chat completions API, with a
control/observability dashboard. See `NEXTJS_REWRITE_PLAN.md` for scope and
`NEXTJS_REWRITE_PROGRESS.md` for current status.

## Getting Started

```bash
npm install
cp .env.example .env   # then fill in required values
npm run dev            # http://localhost:3200
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 3200 |
| `npm run build` | Production build (`next build`) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest (run once) |
| `npm run test:watch` | Vitest watch mode |

## Repository Layout

Boundaries are intentional; keep feature-specific plumbing out of shared modules.

| Path | Responsibility |
| --- | --- |
| `app/` | App Router routes, layouts, and Route Handlers (`app/api/**/route.ts`). Handlers stay thin and delegate to `server/`. |
| `components/` | Shared, presentational dashboard UI (no feature business logic). |
| `features/` | Product feature modules (server service, schemas, API, UI, tests) following the feature contract in the plan. |
| `server/` | Server-only domain logic and shared infrastructure. Modules that touch secrets, DB, filesystem, Telegram, or the LLM provider import `server-only`. |
| `db/` | Database schema, migrations, and typed query helpers. |
| `lib/` | Small shared utilities and pure contracts (error shape, trace types) importable by both client and server. |
| `test/` | Test support (stubs, fixtures). |

### Import boundary

Server-only modules (`server/env.ts`, `server/http.ts`, …) import `server-only`
so they cannot be pulled into a client bundle. Pure contracts that the dashboard
needs to render (`lib/api-error.ts`, `lib/trace.ts`) are intentionally **not**
server-only. Path alias `@/*` maps to the repo root.

## Configuration

All environment variables are documented in `.env.example`. Every variable also
accepts a `<NAME>_FILE` Docker-secret variant. Required values are enforced at
the point of use (`requireEnv`) rather than at process boot, so the dashboard can
run and report what is missing.
