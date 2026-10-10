<!--
Title: Conventional Commits, it becomes the commit on main (squash merge).
  feat(api): add user invitations
  fix(web): keep the session after a refresh race
See docs/commits.md.
-->

## What and why

<!-- What changes and why. Link the issue: "Closes #123" or the tracker key. -->

## How it was tested

<!-- Tests added or changed; manual checks, with steps a reviewer can repeat. -->

## Screenshots

<!-- UI changes only. Delete otherwise. -->

## Risk and rollout

<!-- Migrations, new environment variables, breaking API changes, feature flags,
     anything the deployment must do. "None" is a valid answer. -->

## Definition of Done

- [ ] Acceptance criteria of the issue are met.
- [ ] Tests cover the change (unit/component; integration for API behavior; E2E for critical flows).
- [ ] `pnpm verify` passes locally; CI is green.
- [ ] API contract regenerated and committed (`pnpm contract`) if a controller or DTO changed, and the diff of `openapi/openapi.json` reviewed.
- [ ] Database changes ship as a committed migration; destructive changes follow the expand/contract steps in docs/database.md.
- [ ] New environment variables are in the env schema, the `.env.example` and docs/environment.md.
- [ ] Security reviewed: authorization on every new route (role and ownership), validated input, no secrets or personal data in logs or responses.
- [ ] New dependencies justified (maintained, allowed license, no unreviewed install script); no new `nosemgrep`/`eslint-disable` without its reason.
- [ ] Operations: new hard dependencies in the readiness probe, optional ones degrade; logs, metrics and alerts can tell when it fails; runbooks updated (docs/incident-response.md).
- [ ] Breaking changes marked in the title (`!`) and explained in a `BREAKING CHANGE:` footer (they drive the next version).
- [ ] Documentation updated (README, docs/, an ADR for a significant decision).
