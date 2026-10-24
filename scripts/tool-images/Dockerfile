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
FROM semgrep/semgrep:1.180.0@sha256:529ee8a277ec8adc5b534d7c74eea0a47e9de21d62852b6ba7ac6ba9566845c3 AS semgrep

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
FROM ghcr.io/terraform-linters/tflint:v0.64.0@sha256:1c595f42d794c32c45a6ea8b58655fd66433d4ca3b1bc631c574a48d120bd19f AS tflint
FROM public.ecr.aws/docker/library/ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS ubuntu

# The BuildKit daemon that builds and pushes the application images
# (docker/setup-buildx-action in docker-images.yml and deploy.yml), whose own
# default is a moving tag (moby/buildkit:buildx-stable-1). Its built-in
# Dockerfile frontend parses apps/*/Dockerfile, which name no `# syntax=` image.
FROM moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea AS buildkit

# Image vulnerability scanning.
FROM ghcr.io/aquasecurity/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222 AS trivy

# Test database of the integration and end-to-end jobs; keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 AS postgres

# Redis of the integration job (the Redis-backed adapters); keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/redis:8-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0 AS redis

# Mail catcher of the integration job: the outbox specs send real SMTP to it
# and read the messages back through its API. Keep the version equal to
# docker-compose.yml.
FROM axllent/mailpit:v1.31.5@sha256:94f6b70c1436defae6799d9ac7ff0eeff9540465b842026d5cdb018f1c0234ea AS mailpit

# Dynamic application security testing (.github/workflows/dast.yml).
FROM ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6 AS zap

# Observability as code (pnpm observability:check): promtool checks the
# Prometheus configuration, alert and recording rules and the dashboards'
# queries, and runs the rules' unit tests. Keep it at or above the Prometheus
# version of the local backend (docker-compose.yml, grafana/otel-lgtm). From
# Quay, where the Prometheus project publishes the digest of prom/prometheus.
FROM quay.io/prometheus/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e AS promtool
