# Code review

Every change reaches `main` through a pull request with at least one approval and a green **CI
passed** check. Review is for correctness, security and maintainability; formatting and style are
already enforced by the tools, so reviewers do not discuss them.

## Author

- Small pull requests (aim for under 400 changed lines, generated files aside); split otherwise.
- Fill in the template: what, why, how it was tested, risks. Self-review the diff first.
- `pnpm verify` passes; integration and E2E too when the change touches them.
- Point reviewers at the contract diff (`openapi/openapi.json`) and migrations when there are any.
- Answer every comment (a change or a reason); resolve threads only when the reviewer agrees.

## Reviewer checklist

**Behavior**

- [ ] Does it do what the issue asks, including edge cases (empty, max, concurrent, failure)?
- [ ] Are the tests meaningful: would they fail if the code were wrong?

**Security**

- [ ] Every new route: `@Auth(...)` with the right roles, or deliberately public with a reason.
- [ ] Object-level access: can a user read or change someone else's record by changing an id?
      The owner filter is in every query and scoped write, and each route on one record has an
      access-matrix test ([authorization.md](authorization.md)).
- [ ] Input validated with a schema; sizes bounded; output built from an explicit select.
- [ ] No secrets, tokens or personal data in code, logs, errors or responses.
- [ ] New dependency: needed, maintained, license acceptable, audit clean, install scripts justified.

**API and data**

- [ ] Contract change reviewed: names, status codes, pagination, backwards compatibility.
- [ ] Migration safe to run while the previous version is live (expand/contract), indexes for new
      queries, no unbounded queries.

**Maintainability**

- [ ] Follows the module conventions (docs/architecture.md); no duplication of an existing helper.
- [ ] Errors handled through the standard paths (docs/error-handling.md).
- [ ] Names and comments explain why, not what.
- [ ] Docs, env examples and ADRs updated when behavior or decisions changed.

## Etiquette

- Review within one working day; small pull requests first.
- Label comments: **blocking**, **suggestion**, **question**, **nit** (nits never block).
- Comment on the code, not the person; propose an alternative when rejecting one.
- Approve when it is good enough to merge and improve later, not when it is perfect.

## Merging

The author merges (squash) once approved and green; the title must be a Conventional Commit. Code
owners (`.github/CODEOWNERS`) are requested automatically for the paths they own.
