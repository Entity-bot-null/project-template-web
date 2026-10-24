# syntax=docker/dockerfile:1
# Never built. The container images of the tools that CI and the local
# commands run (pnpm sast, pnpm lint:workflows), pinned by tag for readers and
# by digest for the runner: a moved tag cannot change what runs with the
# repository checked out. Written as a Dockerfile so Dependabot (the docker
# entry in .github/dependabot.yml) proposes tag and digest updates together;
# kept outside .github/, where Dependabot may change files for GitHub Actions
# only.
# scripts/tool-image.mjs reads it: one `FROM <image> AS <name>` per tool.
#
# Where an image is published outside Docker Hub with the same digest, it is
# pulled from there: Docker Hub limits anonymous pulls per address, and CI
# runners share theirs. The ones left on Docker Hub (actionlint, Semgrep,
# Mailpit), and the ECR Public ones (ECR Public limits anonymous pulls too),
# are pulled in CI through a mirror of Docker Hub, by digest
# (scripts/tool-image.mjs).

# Workflow linting: actionlint (syntax, expressions, shellcheck) and zizmor
# (security: permissions, injection, pinning, credential persistence).
FROM rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 AS actionlint
FROM ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9 AS zizmor

# Static application security testing.
FROM semgrep/semgrep:1.181.0@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b AS semgrep

# Secrets in the git history.
FROM ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f AS gitleaks

# Infrastructure as code (scripts/check-iac.mjs, which also runs the trivy and
# postgres images below): Terraform itself (keep required_version in
# infra/terraform/digitalocean on its minor version), TFLint with its bundled
# Terraform rules, and the Ubuntu release the server runs, for cloud-init's
# schema check of its user data. Terraform from HashiCorp's ECR Public
# repository and Ubuntu from ECR Public's mirror of Docker's official images:
# the same digests as on Docker Hub, without its anonymous pull limit.
FROM public.ecr.aws/hashicorp/terraform:1.16.6@sha256:bfffc1ded5fbf0a17beaaf22eb4793980abdb19d0761ff6a3a0efb2ab4d9b316 AS terraform
FROM ghcr.io/terraform-linters/tflint:v0.65.0@sha256:2788f4d4fc663c0e953b011b01bf443fe5bfce7587ee916e588e6057b85d6359 AS tflint
FROM public.ecr.aws/docker/library/ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS ubuntu

# The BuildKit daemon that builds and pushes the application images
# (docker/setup-buildx-action in docker-images.yml and deploy.yml), whose own
# default is a moving tag (moby/buildkit:buildx-stable-1). Its built-in
# Dockerfile frontend parses apps/*/Dockerfile, which name no `# syntax=` image.
FROM moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c AS buildkit

# Image vulnerability scanning.
FROM ghcr.io/aquasecurity/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c AS trivy

# Test database of the integration and end-to-end jobs; keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/postgres:18-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5 AS postgres

# Redis of the integration job (the Redis-backed adapters); keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/redis:8-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0 AS redis

# Mail catcher of the integration job: the outbox specs send real SMTP to it
# and read the messages back through its API. Keep the version equal to
# docker-compose.yml.
FROM axllent/mailpit:v1.31.6@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387 AS mailpit

# Dynamic application security testing (.github/workflows/dast.yml).
FROM ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6 AS zap

# Observability as code (pnpm observability:check): promtool checks the
# Prometheus configuration, alert and recording rules and the dashboards'
# queries, and runs the rules' unit tests. Keep it at or above the Prometheus
# version of the local backend (docker-compose.yml, grafana/otel-lgtm). From
# Quay, where the Prometheus project publishes the digest of prom/prometheus.
FROM quay.io/prometheus/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2 AS promtool
