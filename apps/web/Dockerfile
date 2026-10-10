# syntax=docker/dockerfile:1
# Web image: the built SPA behind nginx, which also forwards /api to the API so
# the browser sees one origin (same-origin refresh cookie, no CORS). The build
# context is the repository root:
#   docker build -f apps/web/Dockerfile -t web .
# API_UPSTREAM (default http://api:3000) is where /api goes; the other runtime
# variables are optional (docs/environment.md#web-variables).
#
# Base images by tag and digest, so a build is reproducible and a moved tag
# changes nothing; Dependabot proposes tag and digest together. Node.js 24
# (.nvmrc) from ECR Public's mirror of Docker's official images, nginx from
# NGINX's own registry on GHCR: the same images as Docker Hub, without its
# anonymous pull limit.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0
RUN corepack enable
WORKDIR /repo
# package.json comes along for its packageManager pin: without it Corepack
# would fetch the newest pnpm instead of the pinned one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter web
RUN pnpm --filter web build

# Runs as an unprivileged user on port 8080.
FROM ghcr.io/nginx/nginx-unprivileged:1.31-alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083 AS runtime
# Operating system fixes published after the base image was built (the image
# scan in CI fails on a fixable HIGH or CRITICAL advisory). The day of those
# fixes (CI passes today's date) is part of the cache key of the upgrade: a
# build cache would otherwise replay the first build's upgrade until the base
# digest changes. The default keeps local builds cached.
USER root
ARG OS_UPGRADE_DATE=local
RUN apk upgrade --no-cache
USER 101
# The build this image holds (CI passes the commit SHA): reported with every
# error, so a regression points at its release.
ARG APP_RELEASE=unversioned
# Runtime settings, all with safe defaults (docs/environment.md#web-variables):
# error tracking stays off until WEB_SENTRY_DSN is set at deployment.
ENV API_UPSTREAM=http://api:3000 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    APP_ENVIRONMENT=production \
    APP_RELEASE=${APP_RELEASE} \
    WEB_SENTRY_DSN="" \
    WEB_SENTRY_SAMPLE_RATE=1
COPY --chmod=0755 apps/web/nginx/18-validate-runtime-config.sh /docker-entrypoint.d/18-validate-runtime-config.sh
COPY apps/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
