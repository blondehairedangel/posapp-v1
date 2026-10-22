# syntax=docker/dockerfile:1
# =============================================================================
# Automotive Spare Parts ERP — production image
#
# Build targets:
#   runner    web + worker runtime (production dependencies only)
#   migrator  `prisma migrate deploy` (needs the Prisma CLI, a dev dependency)
#
# The two are separate because the Prisma CLI must NOT ship in the serving
# image: it is a build-time tool, and `pnpm prune --prod` removes it. Running
# migrations from a dedicated stage keeps the runtime image small while still
# making migrations a first-class, repeatable step.
# =============================================================================

ARG NODE_VERSION=22-alpine

# ---------------------------------------------------------------- base --------
FROM node:${NODE_VERSION} AS base
# libc6-compat + openssl: the Prisma query engine is built against glibc and
# links OpenSSL at runtime.
RUN apk add --no-cache libc6-compat openssl
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- deps --------
# Full dependency tree (dev + prod). Lockfile-only copy keeps this layer
# cached across source-only changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ------------------------------------------------------------ prod-deps -------
# Production-only tree for the runtime image.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# --------------------------------------------------------------- builder ------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# No database configuration is baked into the image — not even a placeholder.
# `prisma generate` resolves its datasource lazily (see prisma.config.ts), so
# it does not need one; the build therefore cannot embed a connection string
# in an image layer, and cannot accidentally reach a real database.
RUN pnpm prisma generate

# The Next build imports modules that validate configuration at import time.
# These two placeholders exist only for that duration: they are passed to the
# single RUN command rather than declared with ENV, so they never become part
# of an image layer or show up in `docker history`. Real values are supplied
# at runtime.
RUN SESSION_SECRET="build-only-not-a-credential-0000000000000000" \
    APP_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
    pnpm next build

# The worker is NOT bundled. The Prisma 7 `prisma-client` generator emits
# TypeScript that reads `import.meta.url` to locate its query engine; bundling
# it to CommonJS leaves that empty and engine resolution fails at runtime.
# Running the worker through `tsx` keeps one source of truth and avoids a
# whole class of bundling hazards, at the cost of ~30 MB in the image.

# -------------------------------------------------------------- migrator ------
# Keeps the full dependency tree so `prisma` is available. Used by the
# one-shot migration service; never serves traffic.
FROM base AS migrator
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY scripts ./scripts
# prisma.config.ts resolves the datasource through src/lib/db-config.ts, so
# the migrator needs that module (and tsconfig for the "@/*" alias).
COPY --from=builder /app/src ./src

# Wait for the database before migrating. `depends_on` cannot express a health
# condition for a database in a different Compose project or on another host,
# so the migration step waits here instead of failing and restarting.
# `migrate deploy` is forward-only and never resets.
CMD ["sh", "-c", "node_modules/.bin/tsx scripts/wait-for-db.mts 120 && node_modules/.bin/prisma migrate deploy"]

# --------------------------------------------------------------- runner -------
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run unprivileged. Attachments go to a mounted volume, so the application
# needs no write access to the image itself.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# Next.js standalone output: a self-contained server carrying only the modules
# it actually traced, which is why node_modules is not copied wholesale for
# the web role.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The worker is a separate entry point, outside the traced Next bundle, so it
# needs the production dependency tree, the generated Prisma client, the
# server sources it imports, and tsconfig.json for the "@/*" path alias.
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

# Attachment storage when STORAGE_DRIVER=local.
RUN mkdir -p /app/storage && chown -R nextjs:nodejs /app/storage
VOLUME ["/app/storage"]

USER nextjs
EXPOSE 3000

# Queries the database, so a container that is listening but cannot reach
# PostgreSQL is reported unhealthy instead of receiving traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default role is the web server; the worker service overrides the command.
CMD ["node", "server.js"]
