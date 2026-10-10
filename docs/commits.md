# Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint
(`commitlint.config.js`): on every commit by the `commit-msg` hook, and on every pull request title
by the **Conventions** check (`conventions.yml`, again whenever the title is edited), since the
squash merge turns the title into the commit on `main`.

```
<type>(<optional scope>): <summary>

<optional body: what and why, wrapped at 100 columns>

<optional footers>
```

- **type:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`,
  `revert`.
- **scope:** the area: `api`, `web`, `auth`, `users`, `db`, `deps`, `e2e`.
- **summary:** imperative, lowercase start, no final period, at most 100 characters in total.
- **Breaking change:** `!` after the type/scope and a `BREAKING CHANGE:` footer explaining the
  migration path.
- **References:** a tracker key or issue in a footer: `Refs: ABC-123`, `Closes #42`.

The titles on `main` are the release notes: `feat` and `fix` (and `perf`, `revert`) appear in
`CHANGELOG.md` and decide the next version (`fix` patch, `feat` minor, `!` major), so write them
for the people reading the release ([ci-cd.md](ci-cd.md#releases)).

```
feat(api): paginate the user list
fix(web): keep the session when two tabs refresh together
refactor(auth)!: rename the refresh cookie

BREAKING CHANGE: clients must sign in again after the deploy.
```

## Habits

- Small commits that each build and pass tests; one logical change per commit.
- Code, commit messages and documentation in English (user-facing copy in the product's language).
- No generated noise mixed with logic: `pnpm contract` output may share the commit of the change
  that caused it, formatting-only changes go in their own commit.
- Never commit secrets, `.env` files or personal data (hooks and CI scan for them; if one slips
  through, rotate it).
