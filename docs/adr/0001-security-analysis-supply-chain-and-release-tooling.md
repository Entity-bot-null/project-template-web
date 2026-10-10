# 0001. Use Semgrep, zizmor, ZAP, Dependabot and release-please for analysis, supply chain and releases

- **Status:** Accepted
- **Date:** 2026-10-03
- **Deciders:** template maintainers

## Context

The template already had type-aware linting, dependency and image scanning, secret scanning, SHA
pinning and opt-in CodeQL. Missing were: static analysis that runs on a private repository without
GitHub Advanced Security, an audit of the workflows themselves, a license policy, lockfile source
checks, an SBOM, image provenance, dynamic testing, automated tool-image updates and a release
process. Every addition must work on any GitHub plan, run the same way locally and in CI, need no
new runtime dependency, and stay quiet enough that its failures are taken seriously.

## Options

1. **SAST:** CodeQL only (needs Advanced Security on private repositories); eslint-plugin-security
   (its most useful rule, object injection, is mostly false positives); **Semgrep CE** with the
   curated registry rulesets (any plan, Dockerfiles and nginx included, zero findings on this
   code base).
2. **Workflow security:** a homegrown script; **zizmor** (the dedicated auditor: permissions,
   injection, impostor commits, cache poisoning).
3. **Licenses and SBOM:** license-checker / CycloneDX npm tools (new dependencies); **pnpm's
   built-in `licenses` and `sbom`** (nothing to add).
4. **Dependency updates:** Renovate (more flexible; a third-party app or a hosted token);
   **Dependabot** (built in, already configured).
5. **Releases:** Changesets (per-package versions, a file per change); semantic-release (releases
   on every merge, plugins as dependencies); **release-please** (one release pull request from the
   Conventional Commits already enforced, no dependency, an action pinned by SHA).
6. **Artifact integrity:** cosign with keys; **BuildKit SBOM and provenance attestations** on push,
   with **GitHub attestations (Sigstore, keyless)** as an option where the plan allows.
7. **DAST:** none; a commercial scanner; **OWASP ZAP**, baseline and API scan, advisory.

## Decision

The options in bold. Each one closes a gap with the least new surface: three pinned container
images (Semgrep, zizmor, ZAP) declared in `.github/tool-images/Dockerfile` so Dependabot updates
them, one GitHub Action (release-please), and pnpm features the template already depends on.
Semgrep and zizmor block a merge because they report nothing on the template; CodeQL and ZAP stay
advisory because they depend on the plan or on a running environment.

## Consequences

- `pnpm verify` also checks licenses and dependency sources; `pnpm sast` and
  `pnpm lint:workflows` need Docker locally (CI always runs them).
- Semgrep fetches its rulesets at each run: a new rule can flag existing code, and CI needs the
  registry reachable. If that becomes noisy or fragile, vendor the rules into the repository.
- Releases need `RELEASE_PLEASE_TOKEN` for CI to run on the release pull request.
- Signed attestations and their verification at deploy time are left to each project's plan and
  provider.
- Wrong if: blocking analyzers produce false positives often enough that suppressions become
  routine, or Dependabot cannot keep the tool images current. Then revisit (Renovate, vendored
  rules).
