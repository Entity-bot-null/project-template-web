import { normalizeEmail } from '../auth/auth.constants.js';
import { hashPassword } from '../auth/password.js';
import type { Role } from '../common/types/request-user.js';
import type { PrismaClient } from '../prisma/generated/client.js';

interface SeedUser {
  email: string;
  name: string;
  role: Role;
  password: string;
}

// Development, test and E2E accounts. The passwords are public on purpose:
// these accounts must never exist in production, and run.ts refuses to run
// with NODE_ENV=production.
export const SEED_USERS: readonly SeedUser[] = [
  { email: 'admin@example.com', name: 'Admin', role: 'admin', password: 'admin-password' },
  { email: 'member@example.com', name: 'Member', role: 'member', password: 'member-password' },
];

/** Idempotent: keyed on the email, a re-run resets name, role and password. */
export async function seed(prisma: PrismaClient): Promise<void> {
  for (const user of SEED_USERS) {
    const email = normalizeEmail(user.email);
    const passwordHash = await hashPassword(user.password);
    await prisma.user.upsert({
      where: { email },
      create: { email, name: user.name, role: user.role, passwordHash },
      update: { name: user.name, role: user.role, passwordHash },
    });
  }
}
