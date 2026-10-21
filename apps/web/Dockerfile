# syntax=docker/dockerfile:1
# Web image: the site behind nginx, one origin for the browser (same-origin
# refresh cookie, no CORS): the landing at / (apps/landing), the web app at
# /app/ (apps/web), and /api forwarded to the API. The build context is the
# repository root:
#   docker build -f apps/web/Dockerfile -t web .
# APP_ORIGIN (the site's public origin) is required; API_UPSTREAM (default
# http://api:3000) is where /api goes; the other runtime variables are
# optional (docs/environment.md#web-variables).
#
# Base images by tag and digest, so a build is reproducible and a moved tag
# changes nothing; Dependabot proposes tag and digest together. Node.js 24
# (.nvmrc) from ECR Public's mirror of Docker's official images, nginx from
# NGINX's own registry on GHCR: the same images as Docker Hub, without its
# anonymous pull limit.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
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
    pnpm install --offline --frozen-lockfile --filter web --filter landing
RUN pnpm --filter web build
# The landing is built for a placeholder origin (the .invalid domain is
# reserved, RFC 2606): nginx writes the deployment's APP_ORIGIN in its place
# as it serves the pages (nginx/default.conf.template), so this one image
# serves every environment.
RUN PUBLIC_URL=https://public-origin.invalid pnpm --filter landing build

# Runs as an unprivileged user on port 8080.
FROM ghcr.io/nginx/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e AS runtime
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
# Runtime settings (docs/environment.md#web-variables): APP_ORIGIN has no
# default, so a deployment that forgets it stops at start with the variable's
# name; the others are safe as they are: error tracking stays off until
# WEB_SENTRY_DSN is set; every page load reports its Web Vitals to the API (0
# turns that off).
ENV API_UPSTREAM=http://api:3000 \
    APP_ORIGIN="" \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    APP_ENVIRONMENT=production \
    APP_RELEASE=${APP_RELEASE} \
    WEB_SENTRY_DSN="" \
    WEB_SENTRY_SAMPLE_RATE=1 \
    WEB_VITALS_SAMPLE_RATE=1
COPY --chmod=0755 apps/web/nginx/18-validate-runtime-config.sh /docker-entrypoint.d/18-validate-runtime-config.sh
COPY apps/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/landing/dist /usr/share/nginx/html
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html/app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
