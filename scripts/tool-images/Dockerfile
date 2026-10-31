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
FROM semgrep/semgrep:1.182.1@sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6 AS semgrep

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
FROM public.ecr.aws/docker/library/ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS ubuntu

# The BuildKit daemon that builds and pushes the application images
# (docker/setup-buildx-action in docker-images.yml and deploy.yml), whose own
# default is a moving tag (moby/buildkit:buildx-stable-1). Its built-in
# Dockerfile frontend parses apps/*/Dockerfile, which name no `# syntax=` image.
FROM moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c AS buildkit

# Image vulnerability scanning.
FROM ghcr.io/aquasecurity/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c AS trivy

# Test database of the integration and end-to-end jobs; keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5 AS postgres

# Redis of the integration job (the Redis-backed adapters); keep the major
# version equal to docker-compose.yml.
FROM public.ecr.aws/docker/library/redis:8-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0 AS redis

# Mail catcher of the integration job: the outbox specs send real SMTP to it
# and read the messages back through its API. Keep the version equal to
# docker-compose.yml.
FROM axllent/mailpit:v1.32.0@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498 AS mailpit

# Dynamic application security testing (.github/workflows/dast.yml).
FROM ghcr.io/zaproxy/zaproxy:2.17.0@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238 AS zap

# Observability as code (pnpm observability:check): promtool checks the
# Prometheus configuration, alert and recording rules and the dashboards'
# queries, and runs the rules' unit tests. Keep it at or above the Prometheus
# version of the local backend (docker-compose.yml, grafana/otel-lgtm). From
# Quay, where the Prometheus project publishes the digest of prom/prometheus.
FROM quay.io/prometheus/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2 AS promtool
