// lint-staged passes every staged environment file (.env*, *.env, .envrc);
// only .env.example files may be committed (docs/environment.md). .gitignore
// already excludes the others, so reaching this means a forced add.
import { basename } from 'node:path';

const blocked = process.argv.slice(2).filter((file) => basename(file) !== '.env.example');
if (blocked.length > 0) {
  console.error(
    [
      'Refusing to commit environment files:',
      ...blocked.map((file) => `  ${file}`),
      'Real values stay out of git; document new variables in the .env.example next to them.',
      'Unstage with: git restore --staged <file>',
    ].join('\n'),
  );
  process.exit(1);
}
