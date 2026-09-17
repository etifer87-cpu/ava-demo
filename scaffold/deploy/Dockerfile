# syntax=docker/dockerfile:1.7
#
# deploy/Dockerfile - the deployed image. Kit defect 1: the kit ships none.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not scaffold/:
#
#   docker build -f scaffold/deploy/Dockerfile -t ava:local .
#
# because `KIT_ROOT` in scripts/lib/kit-seed.mjs resolves three levels up from scripts/lib, i.e. the
# repository root, and every seed script reads its inputs from `<root>/data`. The container therefore
# mirrors the repository layout - /app/scaffold and /app/data - rather than flattening the app to
# /app. Flatten it and every script looks for its data one directory too high, and says so in a way
# that names neither the cause nor the file.
#
# The layers are ordered so that a source change rebuilds almost nothing: dependencies are installed
# from package.json and package-lock.json alone, in their own stage, before any source is copied.

# ---------------------------------------------------------------- dependencies (build)
FROM node:22.12-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app/scaffold
COPY scaffold/package.json scaffold/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------------------------------------------------------------- dependencies (runtime)
# The standalone output carries only what the SERVER traced. The seed and migration scripts are not
# traced - nothing imports them - so they need `pg` and `yaml` present at runtime in their own right.
FROM node:22.12-alpine AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app/scaffold
COPY scaffold/package.json scaffold/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---------------------------------------------------------------- build
FROM node:22.12-alpine AS build
RUN apk add --no-cache libc6-compat
WORKDIR /app/scaffold
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/scaffold/node_modules ./node_modules
COPY scaffold/ ./
# next.config.mjs sets `typescript.ignoreBuildErrors: false` on purpose: a type error fails the image
# rather than shipping a broken page.
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22.12-alpine AS runtime
RUN apk add --no-cache libc6-compat curl

# PORT IS 3000, NOT 3100.
#
# 3100 and 3101 are HOST ports, and only on a workstation: deploy/compose.dev.yml publishes the
# database and the renderer on 5433 and 3101 so they cannot collide with anything else running
# locally, and `npm run dev` takes 3100 on the host. Inside a container every service listens on its
# own natural port and the mapping is compose's job - which is why the pdf service is written
# "${PDF_PORT:-3101}:3000".
#
# compose.yml publishes "${APP_PORT:-3000}:3000" and its healthcheck fetches
# http://127.0.0.1:3000/api/health from INSIDE the container. An image listening on 3100 therefore
# starts cleanly, serves nobody, and reports unhealthy forever with nothing in its own log to say
# why - the port the probe uses is not a number this file gets to choose.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app/scaffold

# Runtime dependencies first, then the standalone server over them: the standalone bundle brings its
# own traced copies and they win where the two overlap.
COPY --from=prod-deps /app/scaffold/node_modules ./node_modules
COPY --from=build /app/scaffold/.next/standalone ./
COPY --from=build /app/scaffold/.next/static ./.next/static
COPY --from=build /app/scaffold/public ./public

# What the scripts need, and only that. `config/` is read at runtime by lib/config.ts as well - the
# YAML is not compiled into the bundle, which is the point of it being configuration.
COPY scaffold/package.json ./package.json
COPY scaffold/scripts ./scripts
COPY scaffold/db ./db
COPY scaffold/config ./config

# Source data, committed (see .gitignore). The generated data - programs, roster, history - is NOT in
# the image: it is produced inside the container by gen:programs and gen:roster, deterministically,
# as part of the build-the-instance sequence.
COPY data/library /app/data/library

# The competency framework DOCUMENT, not documentation. seed-framework.mjs re-parses it and
# byte-matches every one of the 73 observable behaviours against db/seed/competency_framework.json
# before writing a row - the document is the authority, the JSON is the copy, and the seed refuses
# to run if they have drifted. .dockerignore excludes kit-docs wholesale and re-includes this one
# file; both halves are needed.
COPY kit-docs/03_COMPETENCY_FRAMEWORK.md /app/kit-docs/03_COMPETENCY_FRAMEWORK.md

# /app/data must be writable by the runtime user: gen:programs and gen:roster write their output
# there during the one-shot instance build, and they run as this same user.
RUN addgroup -g 1001 -S ava \
 && adduser -u 1001 -S ava -G ava \
 && mkdir -p /app/data \
 && chown -R ava:ava /app
USER ava

EXPOSE 3000

# The app and only the app. Migrations and seeding are a one-shot container running the same image
# with a different command:
#
#   docker compose ... run --rm app npm run migrate
#
# which reuses this service's environment and network without publishing its ports. Never a step in
# the image build, and never something the web process does on boot, because two replicas would both
# do it.
CMD ["node", "server.js"]
