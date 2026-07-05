# Custom Dockerfile — replaces Railway's auto-generated Nixpacks build.
#
# WHY: Nixpacks's default Dockerfile declares EVERY service env var as an
# ARG + ENV at build time. That bakes secrets (ANTHROPIC_API_KEY,
# NEXTAUTH_SECRET, GITHUB_TOKEN, SERPAPI_API_KEY, FIRMABLE_API_KEY) into
# the published image layers — anyone who pulls the image can read them.
# This file declares ONLY public-safe ARGs. Runtime secrets are injected
# by Railway into the container's environment at start-up, which is the
# standard mechanism — `process.env.ANTHROPIC_API_KEY` still works.
#
# What can safely be a build-time ARG:
#   - NEXT_PUBLIC_*           (Next.js bakes these into the client bundle
#                              anyway — they are public by definition)
#   - DATABASE_URL            (set to a dummy below; Prisma generate
#                              validates the schema but doesn't connect)
#
# What must NOT be ARG'd here (Railway injects at runtime):
#   - ANTHROPIC_API_KEY, NEXTAUTH_SECRET, GITHUB_TOKEN, SERPAPI_API_KEY,
#     FIRMABLE_API_KEY, PDL_API_KEY, OPENAI_API_KEY, etc.
#
# Tested against Next.js 15.5 + Prisma 5.22 + Node 20.

FROM node:20-bookworm-slim
WORKDIR /app

# OpenSSL is required by Prisma's query engine on Debian-slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Public-only build args. Add new entries only if they ship in the
# client bundle (i.e. start with NEXT_PUBLIC_).
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GITHUB_TOKEN_SET
ARG NEXT_PUBLIC_SENTRY_DSN

ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_GITHUB_TOKEN_SET=$NEXT_PUBLIC_GITHUB_TOKEN_SET \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NODE_ENV=production \
    # Skip Next.js telemetry pings out of the build container.
    NEXT_TELEMETRY_DISABLED=1

# 1) Install deps. The COPY-then-RUN pattern means Docker reuses this
# layer whenever package-lock.json is unchanged, so `npm ci` only re-runs
# when dependencies actually move. We DON'T use BuildKit cache mounts
# (--mount=type=cache) because Railway requires their cache IDs to be
# prefixed with `s/<service-id>-`, which would tie this Dockerfile to one
# specific Railway service. Plain layer caching is portable.
#
# `--include=dev` is REQUIRED even though we run with NODE_ENV=production:
# next.config.ts is a TypeScript file, and Next.js needs the `typescript`
# package (a devDependency) at BUILD time to transpile it. Without this
# flag, NODE_ENV=production tells npm to skip devDependencies and the
# build crashes with `Cannot find module 'typescript'`.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# 2) Source.
COPY . .

# 3) Build. Dummy DATABASE_URL is enough for `prisma generate` —
# Prisma validates the schema URL format but does not connect. The real
# Railway DATABASE_URL kicks in at runtime via process.env.
#
# NODE_OPTIONS raises V8's old-space ceiling for the Next production build.
# The default (~2 GB) OOMs the webpack/type build on some hosts (SIGABRT
# "Ineffective mark-compacts" / heap OOM). 4 GB is the standard Next headroom
# and is safely under the builder's memory, so it only prevents OOM — it never
# forces allocation.
RUN NODE_OPTIONS=--max-old-space-size=4096 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    npm run build

EXPOSE 3000

# Runtime: Railway injects every service env var (including secrets)
# into the container's environment when it starts. They are NOT in the
# image — just in the running container's process environment. The app
# reads them via process.env as normal.
CMD ["npm", "run", "start:prod"]
