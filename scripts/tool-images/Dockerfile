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
FROM ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d AS zizmor

# Static application security testing.
FROM semgrep/semgrep:1.184.0@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed AS semgrep

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
FROM public.ecr.aws/docker/library/ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS ubuntu

# The BuildKit daemon that builds and pushes the application images
# (docker/setup-buildx-action in docker-images.yml and deploy.yml), whose own
# default is a moving tag (moby/buildkit:buildx-stable-1). Its built-in
# Dockerfile frontend parses apps/*/Dockerfile, which name no `# syntax=` image.
FROM moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe AS buildkit

# Image vulnerability scanning.
FROM ghcr.io/aquasecurity/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb AS trivy

# Test database of the integration and end-to-end jobs; keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5 AS postgres

# Redis of the integration job (the Redis-backed adapters); keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/redis:8-alpine@sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3 AS redis

# Mail catcher of the integration job: the outbox specs send real SMTP to it
# and read the messages back through its API. Keep the version equal to
# docker-compose.yml.
FROM axllent/mailpit:v1.33.0@sha256:9b3a463be15354c0f0eba91697d80e3e0d8a5623ef0e627cacc836bc17fd5231 AS mailpit

# Dynamic application security testing (.github/workflows/dast.yml).
FROM ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af AS zap

# Observability as code (pnpm observability:check): promtool checks the
# Prometheus configuration, alert and recording rules and the dashboards'
# queries, and runs the rules' unit tests. Keep it at or above the Prometheus
# version of the local backend (docker-compose.yml, grafana/otel-lgtm). From
# Quay, where the Prometheus project publishes the digest of prom/prometheus.
FROM quay.io/prometheus/prometheus:v3.16.0@sha256:9332054523223e2ddc18d8101799d54a4a8d823b030c53216f063a6c117773cd AS promtool
