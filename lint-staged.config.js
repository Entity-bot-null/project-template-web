// Pre-commit checks, on the staged files only so they stay fast. Type
// checking and tests run in pre-push; CI runs every gate on everything.
export default {
  // Real environment files never reach git: only .env.example may be staged.
  '{.env*,*.env,.envrc}': 'node scripts/forbid-env-files.mjs',
  // --no-gitignore: a file forced past .gitignore (git add -f) is scanned too.
  '*': 'secretlint --maskSecrets --no-gitignore',
  '*.{ts,tsx,js,mjs,cjs,astro}': [
    'eslint --fix --max-warnings=0 --no-warn-ignored',
    'prettier --write',
  ],
  '*.{json,md,yml,yaml,css,html}': 'prettier --write',
  // A contract step (a drop, a rename, a tighter column) needs its reason
  // (docs/database.md#expand-and-contract).
  'apps/api/prisma/migrations/**/migration.sql': 'node scripts/check-migrations.mjs',
};
