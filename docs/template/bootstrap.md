# Starting a new project from this template

The complete walkthrough, with every command and what it should print, is section 2 of
[docs/manual.md](../manual.md#2-create-a-project-from-the-template). This page is its checklist;
delete `docs/template/` once the project no longer needs it (the manual does not depend on it).

- [ ] Tools installed: Node.js 24.15+, pnpm through Corepack, Docker, Git
      ([manual 1](../manual.md#1-before-you-start))
- [ ] Code copied without the template's history ([2.1](../manual.md#21-get-the-code))
- [ ] Project renamed, `SECURITY.md` contact and `CODEOWNERS` filled in, a `LICENSE` if needed
      ([2.2](../manual.md#22-rename-it-requiere-configuración))
- [ ] `pnpm install` ([2.3](../manual.md#23-install))
- [ ] `apps/api/.env` with a generated `JWT_ACCESS_SECRET`; root `.env` if needed
      ([2.4](../manual.md#24-create-the-environment-files))
- [ ] `pnpm db:up && pnpm db:migrate && pnpm db:seed` ([2.5](../manual.md#25-create-the-database))
- [ ] `pnpm dev`, signed in with a seeded account ([2.6](../manual.md#26-run-it))
- [ ] Every gate green locally: `pnpm verify`, `pnpm test:integration`, `pnpm test:e2e`,
      `pnpm sast`, `pnpm lint:workflows`, the stack and `pnpm smoke`
      ([2.7](../manual.md#27-check-that-every-gate-passes))
- [ ] Product decisions taken ([2.8](../manual.md#28-make-it-yours-requiere-configuración))
- [ ] First commit pushed, repository settings, rulesets, environments, secrets and variables
      ([2.9](../manual.md#29-set-up-github))
- [ ] [production-readiness.md](../production-readiness.md) before the first production release
      ([2.10](../manual.md#210-before-the-first-production-release))
