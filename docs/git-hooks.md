# Git hooks

Installed by `pnpm install` (the root `prepare` script runs Husky, which sets `core.hooksPath` to
`.husky/_`). They work on Windows (Git Bash), macOS and Linux with nothing else to install.

| Hook         | Runs                                                                                   | Typical time | Blocks when                                        |
| ------------ | -------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------- |
| `pre-commit` | `lint-staged --relative` on the **staged files only** (`lint-staged.config.js`):       | seconds      |                                                    |
|              | `.env*`, `*.env` and `.envrc` files other than `.env.example`: refused                 |              | a real env file is staged                          |
|              | every file: secretlint, also on files forced past `.gitignore`                         |              | a secret is found                                  |
|              | `*.ts, *.tsx, *.js, *.mjs, *.cjs`: `eslint --fix`, then `prettier --write`             |              | a lint error cannot be fixed automatically         |
|              | `*.json, *.md, *.yml, *.yaml, *.css, *.html`: `prettier --write`                       |              |                                                    |
| `commit-msg` | `commitlint` (docs/commits.md)                                                         | < 1 s        | the message is not a Conventional Commit           |
| `pre-push`   | `scripts/git/pre-push.mjs`: refuses pushes to `main`/`master` and badly named branches | < 1 s        | pushing to a protected branch, branch name invalid |
|              | `pnpm typecheck`: every app, including the contract types check                        | about 30 s   | type errors, stale `schema.d.ts`                   |
|              | `pnpm test`: unit and component tests, including the OpenAPI drift spec                | (both steps) | a failing test, stale `openapi.json`               |

Times measured on the template as shipped (a laptop, Windows): a pre-push of about 30 seconds for
both steps; a pre-commit of a few seconds for a typical commit, about 40 seconds for the first
commit of the whole template, since every file is linted with type information. They grow with
the code base; keep the hooks to these fast checks.

Not in hooks, on purpose (too slow or need services): integration and E2E tests, coverage,
dependency audit, the scan of every file in the repository (`pnpm secrets:scan`), build, image
builds. CI runs all of them on every pull request; run `pnpm verify` locally before asking for
review.

## Bypassing

`git commit --no-verify` / `git push --no-verify` skip the hooks. Use them only for the very first
push of a new repository (`git push --no-verify -u origin main`, when `main` must be created) or a
real emergency, and say so in the pull request. CI runs the same checks and more, so a bypass never
skips a gate, it only delays the feedback.

## Troubleshooting

- Hooks do not run: `pnpm install` again (sets `core.hooksPath`), or check `git config core.hooksPath`.
- `HUSKY=0` disables them (CI and Docker builds set it).
- A hook needs the dependencies installed and Node.js on `PATH` (the version in `.nvmrc`).
