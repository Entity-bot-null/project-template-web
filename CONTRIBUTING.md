# Contributing

## Setup

Node.js 24, pnpm (`corepack enable`; from Node.js 25, `npm install -g corepack` first), Docker.
Then follow the quick start in the [README](README.md). `pnpm install` also installs the Git hooks.

## From issue to main

1. **Issue.** Use the feature or bug template. Work starts when the story meets the
   [Definition of Ready](docs/definition-of-ready.md).
2. **Branch** from an up-to-date `main`: `feat/<short-description>`, `fix/...`, `chore/...`
   ([docs/branching.md](docs/branching.md)). Never commit to `main`.
3. **Contract first** when the API changes: schemas and controller signatures, `pnpm contract`,
   review the `openapi/openapi.json` diff ([openapi/README.md](openapi/README.md)).
4. **Code and tests together.** Follow [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md); tests as
   described in [docs/testing.md](docs/testing.md). Step-by-step recipes for the usual changes
   (tables, API modules, screens, variables, roles, dependencies): [docs/how-to.md](docs/how-to.md);
   when something fails: [docs/troubleshooting.md](docs/troubleshooting.md).
5. **Commit** with Conventional Commits ([docs/commits.md](docs/commits.md)). The pre-commit hook
   lints, formats and scans the staged files; commit-msg checks the message.
6. **Verify:** `pnpm verify`, plus `pnpm test:integration` and `pnpm test:e2e` when the change
   touches the API or a user flow.
7. **Push** (the pre-push hook type-checks and runs the tests) and open a pull request with the
   template. The title is a Conventional Commit: it becomes the commit on `main`.
8. **CI** runs every gate; the **CI passed** and **Conventions** checks must be green
   ([docs/ci-cd.md](docs/ci-cd.md)).
9. **Review:** at least one approval ([docs/code-review.md](docs/code-review.md)). Address every
   comment.
10. **Merge** with squash, delete the branch. Done means the
    [Definition of Done](DEFINITION_OF_DONE.md) holds.
11. **Release:** the merged title lands in the open release pull request (next version and
    changelog); merging that one tags and publishes the release ([docs/ci-cd.md](docs/ci-cd.md#releases)).

## Git hooks

What each hook runs and when to bypass it: [docs/git-hooks.md](docs/git-hooks.md).

## Reporting security issues

Never in a public issue: see [SECURITY.md](SECURITY.md).
