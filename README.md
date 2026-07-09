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

## Run with Docker

```bash
cp .env.example .env   # optional; compose has sane defaults for DB
docker compose up -d --build
# dashboard: http://localhost:3200  ·  health: http://localhost:3200/api/health
```

`docker compose` starts Postgres (pgvector image) and the app. The app container
applies pending migrations (`drizzle-kit migrate`) before serving, so it never
runs against an unmigrated database. `DATABASE_URL` is built from the `POSTGRES_*`
vars and points at the bundled `db` service; override it to use an external
database. Postgres persists into a bind-mounted host directory (`PG_DATA_DIR`,
default `./data/pg`). Stop with `docker compose down`; to reset the database,
delete that directory.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 3200 |
| `npm run build` | Production build (`next build`) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests (no Docker needed) |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:integration` | DB integration tests against real Postgres (Testcontainers; **Docker required**) |
| `npm run db:generate` | Generate a SQL migration from `db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Open Drizzle Studio |

## Repository Layout

Boundaries are intentional; keep feature-specific plumbing out of shared modules.

| Path | Responsibility |
| --- | --- |
| `app/` | App Router routes, layouts, and Route Handlers (`app/api/**/route.ts`). Handlers stay thin and delegate to `server/`. |
| `components/` | Shared, presentational dashboard UI (no feature business logic). |
| `features/` | Product feature modules (server service, schemas, API, UI, tests) following the feature contract in the plan. |
| `server/` | Server-only domain logic and shared infrastructure. Modules that touch secrets, DB, filesystem, Telegram, or the LLM provider import `server-only`. |
| `db/` | Drizzle schema (`schema.ts`), generated SQL migrations (`migrations/`), pooled Drizzle handle (`getDb()`), and the migrator. |
| `lib/` | Small shared utilities and pure contracts (error shape, trace types) importable by both client and server. |
| `test/` | Test support (stubs, fixtures). |

### Import boundary

Server-only modules (`server/env.ts`, `server/http.ts`, …) import `server-only`
so they cannot be pulled into a client bundle. Pure contracts that the dashboard
needs to render (`lib/api-error.ts`, `lib/trace.ts`) are intentionally **not**
server-only. Path alias `@/*` maps to the repo root.

## Database

Persistence uses [Drizzle ORM](https://orm.drizzle.team) with drizzle-kit
migrations against Postgres.

- Edit tables in `db/schema.ts`, then run `npm run db:generate` and commit the
  new SQL under `db/migrations/`.
- Apply migrations with `npm run db:migrate` (drizzle-kit). In deployment this
  same command runs as the container entrypoint step before `next start`, so the
  app never serves against an unmigrated database.
- Ids are generated in application code, so no Postgres extensions are required
  for the shared schema.

## Configuration

All environment variables are documented in `.env.example`. Every variable also
accepts a `<NAME>_FILE` Docker-secret variant. Required values are enforced at
the point of use (`requireEnv`) rather than at process boot, so the dashboard can
run and report what is missing.
