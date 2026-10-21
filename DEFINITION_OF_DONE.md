# Definition of Done

A change is done when every item holds. The pull request template repeats its main items;
reviewers check the whole list before approving.

## Functionality

- [ ] The acceptance criteria of the issue are met, including error and empty states.
- [ ] The behavior was tried by the author, not only through tests.

## Quality

- [ ] `pnpm verify` passes: format, lint, typecheck, unit and component tests with coverage
      thresholds, security (advisories, dependency policy, secrets), build, performance budget.
- [ ] Integration tests cover new or changed API behavior (`pnpm test:integration`).
- [ ] Critical user flows touched by the change have an E2E test (`pnpm test:e2e`).
- [ ] No new `eslint-disable`, `nosemgrep`, `@ts-expect-error`, skipped test or lowered threshold
      without a written reason.

## Contract and data

- [ ] API changes: `pnpm contract` run, `openapi/openapi.json` and `schema.d.ts` committed, the
      contract diff reviewed, breaking changes identified.
- [ ] Database changes: committed migration, safe while the previous version runs, reviewed SQL.

## Security

- [ ] Every new route is authenticated and authorized (roles and record ownership), or
      deliberately public with a reason.
- [ ] Input validated, output selected explicitly, no secrets or personal data in logs, errors or
      responses.
- [ ] SAST (Semgrep) and the workflow audit (zizmor) are clean in CI.
- [ ] New dependencies justified, audit clean, license allowed by the dependency policy; any
      exception or new install script recorded with its reason.
- [ ] Workflow changes keep least privilege: no new write permission, secret or trigger without a
      reason in a comment.

## Operations

- [ ] New configuration in the env schema, the `.env.example` and docs/environment.md; optional
      integrations stay off by default and never stop the boot when unconfigured.
- [ ] New hard dependencies included in the readiness probe; optional ones degrade, with the
      behavior documented (docs/architecture.md#degradation) and tested.
- [ ] Logs useful for diagnosing the feature (with ids, without personal data); unexpected errors
      reach the error tracker; a new metric only with low-cardinality attributes.
- [ ] External services called through the shared HTTP client; caching only where the "never
      cache" list allows, with a TTL and an invalidation in the code path that changes the data.
- [ ] A new way to fail has its signal and its runbook: an alert or log pattern
      (docs/alerting.md) and the steps in docs/incident-response.md.

## Documentation and delivery

- [ ] README, docs or ADRs updated when behavior, setup or decisions changed.
- [ ] Texts of the landing changed in every language of the site together
      (`apps/landing/src/i18n/`).
- [ ] The pull request title is a Conventional Commit that describes the change for the changelog;
      breaking changes are marked (`!` and a `BREAKING CHANGE:` footer).
- [ ] CI is green (**CI passed**, **Conventions**), the review is approved, the branch is
      squash-merged and deleted.
- [ ] Deployed to staging and verified, when the project deploys continuously.
