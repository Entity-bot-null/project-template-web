// `pnpm db:migrate [--name <name>]`: creates a migration from the changes in
// prisma/schema.prisma (asking for a name when none is given), applies every
// pending migration to the development database, then regenerates the Prisma
// client. Prisma 7's `migrate dev` no longer regenerates it, so without the
// last step the code would keep compiling against the old models.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const prisma = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

for (const args of [['migrate', 'dev', ...process.argv.slice(2)], ['generate']]) {
  const { status } = spawnSync(process.execPath, [prisma, ...args], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
