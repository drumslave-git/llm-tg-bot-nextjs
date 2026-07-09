# syntax=docker/dockerfile:1

# Multi-stage build for the self-hosted Next.js app.
# Native deps (lightningcss, tailwind oxide) are installed inside the image so
# they match the container's platform — never copy host node_modules in.

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- deps: full install (incl. dev) for building ---
# `npm install` (not `npm ci`) so platform-specific optional native deps
# (musl builds of lightningcss / tailwind-oxide) resolve at build time even when
# package-lock.json was generated on another OS.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# --- builder: compile the production build ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner: slim production runtime from Next standalone output ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3200
# Standalone server binds to HOSTNAME; use 0.0.0.0 so it is reachable in-container.
ENV HOSTNAME=0.0.0.0

# Self-contained app server: only traced runtime deps, no full node_modules.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Isolated migration runner: drizzle's programmatic migrator + the SQL files,
# in its own dir so its two small deps never touch the app's traced node_modules.
COPY docker/migrate/package.json ./migrate/package.json
COPY docker/migrate/migrate.mjs ./migrate/migrate.mjs
COPY --from=builder /app/db/migrations ./migrate/db/migrations
RUN cd migrate && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3200

# Apply pending migrations, then serve. Migrations complete before the app
# accepts traffic; a failed migration fails the start.
CMD ["sh", "-c", "node migrate/migrate.mjs && node server.js"]
