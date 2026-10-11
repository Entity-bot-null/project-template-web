# syntax=docker/dockerfile:1
# API image. The build context is the repository root (workspace files):
#   docker build -f apps/api/Dockerfile -t api .                      runtime
#   docker build -f apps/api/Dockerfile --target migrate -t api-migrate .
# The migrate target applies the committed migrations (prisma migrate deploy)
# and is run once per release, before the new API version takes traffic.
#
# Base image: Node.js 24 (.nvmrc), by tag and digest, so a build is
# reproducible and a moved tag changes nothing; Dependabot proposes tag and
# digest together. From ECR Public's mirror of Docker's official images: the
# same image as Docker Hub, without its anonymous pull limit.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0
RUN corepack enable
WORKDIR /repo

# Every dependency in the lockfile, downloaded once and cached until it changes.
# package.json comes along for its packageManager pin: without it Corepack
# would fetch the newest pnpm instead of the pinned one.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter api
RUN pnpm --filter api build

# Production dependencies only, without install scripts: the Prisma client
# was generated in the build stage and is compiled into dist/. Starts from
# base, not deps: `pnpm fetch` fills node_modules/.pnpm with every package of
# the lockfile, development tools included.
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter api --ignore-scripts

# The migration job's dependencies: the production ones (the Prisma CLI is
# one) plus the CLI's schema engine, which only its install script downloads.
FROM prod-deps AS migrate-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm rebuild @prisma/engines

# What both shipped images start from: the Node.js base with the operating
# system fixes published since it was built (the image scan in CI fails on a
# fixable HIGH or CRITICAL advisory; the web image does the same with apk),
# and without the Node.js package managers bundled in it (npm, corepack,
# yarn): only node is needed, and they are attack surface with advisories of
# their own.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS hardened
# The day of those fixes (CI passes today's date). It is part of the cache key
# of the RUN below: a build cache would otherwise replay the upgrade of the
# first build until the base digest changes, and ship none of the fixes
# published since. The default keeps local builds cached.
ARG OS_UPGRADE_DATE=local
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Migrations job: the Prisma CLI with its engine and the committed migrations;
# no source code, no development tools. Its command refuses a database whose
# applied migrations were edited since, then runs prisma migrate deploy
# (scripts/migrate-deploy.mjs).
FROM hardened AS migrate
WORKDIR /repo
COPY --from=migrate-deps /repo/node_modules ./node_modules
COPY --from=migrate-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY apps/api/package.json apps/api/prisma.config.ts ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/scripts/migrate-deploy.mjs ./apps/api/scripts/
WORKDIR /repo/apps/api
USER node
CMD ["node", "scripts/migrate-deploy.mjs"]

FROM hardened AS runtime
# The build this image holds (CI passes the commit SHA): on every log line,
# error report and span (docs/observability.md#identity).
ARG APP_RELEASE=unversioned
ENV NODE_ENV=production \
    APP_RELEASE=${APP_RELEASE}
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
WORKDIR /app/apps/api
# Never root at runtime. The files above stay root's (no --chown): the node
# user can read and run the code, never change it.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
