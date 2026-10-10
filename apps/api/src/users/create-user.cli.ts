import { Buffer } from 'node:buffer';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { env } from '../env/env.js';
import { PrismaClient } from '../prisma/generated/client.js';
import { createUser, describeInvalidInput } from './create-user.js';

// `pnpm --filter api user:create -- --email <email> --name <name> --role admin`
// locally, or in a deployment with the API image (docs/deploy-vps.md):
//   docker compose ... run --rm -T api node dist/users/create-user.cli.js --email ... --role admin
// The password is read from standard input (pipe it in; one trailing newline
// is dropped). The database is the one in DATABASE_URL.

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'member' },
  },
});

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
}
const password = Buffer.concat(chunks)
  .toString('utf8')
  .replace(/\r?\n$/, '');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
try {
  const user = await createUser(prisma, { ...values, password });
  console.log(`Created the ${user.role} account ${user.email} (${user.id}).`);
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? `Invalid input:\n${describeInvalidInput(error)}\nThe password comes from standard input.`
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
