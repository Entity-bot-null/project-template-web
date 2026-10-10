# Branch strategy

Trunk-based: `main` is always releasable, work happens on short-lived branches merged through pull
requests.

```
main ──●────────●──────────●──── (protected: pull requests only, CI passed, squash merge)
        \      /  \        /
         feat/...   fix/...
```

## Rules

- **Never push to `main`.** The pre-push hook refuses it locally (works on any GitHub plan); the
  ruleset in `.github/rulesets/main.json` enforces it on the server where the plan allows.
- **One branch per change**, from an up-to-date `main`, merged within days. Rebase on `main` (or
  merge it in) when it moves; CI must pass on the latest commit.
- **Squash merge.** The pull request title (Conventional Commits) becomes the commit on `main`.
- **Delete the branch** after merging.
- Long-lived branches (`develop`, `release/*` kept open for weeks) are not used; unfinished work is
  hidden behind a flag instead (OPCIONAL: a simple env-driven flag, or a flag service).

## Naming

```
<type>/<short-description>
```

| Type       | For                                 |
| ---------- | ----------------------------------- |
| `feat`     | new behavior                        |
| `fix`      | a bug fix                           |
| `hotfix`   | an urgent production fix            |
| `chore`    | maintenance, dependencies, tooling  |
| `docs`     | documentation only                  |
| `refactor` | code change without behavior change |
| `test`     | tests only                          |
| `perf`     | performance                         |
| `ci`       | CI/CD configuration                 |
| `build`    | build system, Docker                |
| `release`  | release preparation                 |

Description: lowercase words separated by `-`; include the tracker key when there is one:
`feat/ABC-123-user-invitations`, `fix/session-expiry-race`. Letters, digits, `.`, `_` and `-` only.

Checked by `scripts/check-branch-name.mjs` in the pre-push hook and in CI (the **Conventions**
check, `conventions.yml`).
Dependency bot branches (`dependabot/...`, `renovate/...`) are exempt.

## Hotfixes

Same flow, faster: `hotfix/...` from `main`, pull request, CI, review (one approver), merge, deploy
the new `main` (docs/ci-cd.md#deployment). If production runs an older ref, deploy that ref plus the
fix as a tag.

## Releases

Deployments take any ref (docs/ci-cd.md). Tag what you release (`v1.4.0`, or a date) so rollbacks
can name it.
