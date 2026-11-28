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
FROM ghcr.io/zizmorcore/zizmor:1.33.1@sha256:ecd3ffe6158de1322e05a044ed43749bee12b1dccb7e1a7859bc6ac4b2a1c516 AS zizmor

# Static application security testing.
FROM semgrep/semgrep:1.186.0@sha256:6e1b04340e60e910fbb4ddbf3c857ab0918f064417ad5ac530014ccb3cf8c8f1 AS semgrep

# Secrets in the git history.
FROM ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f AS gitleaks

# Infrastructure as code (scripts/check-iac.mjs, which also runs the trivy and
# postgres images below): Terraform itself (keep required_version in
# infra/terraform/digitalocean on its minor version), TFLint with its bundled
# Terraform rules, and the Ubuntu release the server runs, for cloud-init's
# schema check of its user data. Terraform from HashiCorp's ECR Public
# repository and Ubuntu from ECR Public's mirror of Docker's official images:
# the same digests as on Docker Hub, without its anonymous pull limit.
FROM public.ecr.aws/hashicorp/terraform:1.17.2@sha256:6e9c1e647c31a960dc9b59e13272f9111d90010c10b717f77ffb324767660475 AS terraform
FROM ghcr.io/terraform-linters/tflint:v0.66.0@sha256:65b9944a9274c4989492c1d79998c2801664bf8a55fddb4bd3a9e6d73a006ddc AS tflint
FROM public.ecr.aws/docker/library/ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b AS ubuntu

# The BuildKit daemon that builds and pushes the application images
# (docker/setup-buildx-action in docker-images.yml and deploy.yml), whose own
# default is a moving tag (moby/buildkit:buildx-stable-1). Its built-in
# Dockerfile frontend parses apps/*/Dockerfile, which name no `# syntax=` image.
FROM moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c AS buildkit

# Image vulnerability scanning.
FROM ghcr.io/aquasecurity/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb AS trivy

# Test database of the integration and end-to-end jobs; keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/postgres:18-alpine@sha256:0115267ab5a509022df9319c77be365cef335adb71556c75f60f5360ee247e71 AS postgres

# Redis of the integration job (the Redis-backed adapters); keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/redis:8-alpine@sha256:5af80107c1eeecb484a2269b80a26d12bfa6521787da4663bd9f19f60a163483 AS redis

# Mail catcher of the integration job: the outbox specs send real SMTP to it
# and read the messages back through its API. Keep the version equal to
# docker-compose.yml.
FROM axllent/mailpit:v1.34.0@sha256:23a2ef85bc50853ab3093645d1d64679afd8887e89da5e48a88940c172591a4e AS mailpit

# Dynamic application security testing (.github/workflows/dast.yml).
FROM ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af AS zap

# Observability as code (pnpm observability:check): promtool checks the
# Prometheus configuration, alert and recording rules and the dashboards'
# queries, and runs the rules' unit tests. Keep it at or above the Prometheus
# version of the local backend (docker-compose.yml, grafana/otel-lgtm). From
# Quay, where the Prometheus project publishes the digest of prom/prometheus.
FROM quay.io/prometheus/prometheus:v3.16.0@sha256:9332054523223e2ddc18d8101799d54a4a8d823b030c53216f063a6c117773cd AS promtool
