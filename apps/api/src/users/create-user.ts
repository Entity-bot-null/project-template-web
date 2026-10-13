import { z } from 'zod';
import { normalizeEmail, PASSWORD_MAX_INPUT_LENGTH } from '../auth/auth.constants.js';
import { hashPassword } from '../auth/password.js';
import { passwordProblem } from '../auth/password-policy.js';
import { ROLES } from '../common/types/request-user.js';
import type { PrismaClient } from '../prisma/generated/client.js';

// Creates one account in any environment, production included: the audited
// way to get the first administrator, since the template ships no sign-up
// (docs/deploy-vps.md#9-create-the-first-administrator). Run by
// create-user.cli.ts, which reads the password from standard input, never
// from the command line or the environment, where it would end up in shell
// history and process listings.

// The password follows the same policy as every password a person chooses
// (auth/password-policy.ts): 15 characters at least, not a common one, not
// the account's email or name.
export const NewUserSchema = z
  .object({
    email: z.string().trim().max(254).pipe(z.email()).transform(normalizeEmail),
    name: z.string().trim().min(1).max(100),
    role: z.enum(ROLES),
    password: z.string().max(PASSWORD_MAX_INPUT_LENGTH),
  })
  .superRefine(({ email, name, password }, ctx) => {
    const problem = passwordProblem(password, { email, name });
    if (problem !== undefined)
      ctx.addIssue({ code: 'custom', path: ['password'], message: problem });
  });

export interface CreatedUser {
  id: string;
  email: string;
  role: string;
}

/**
 * Validates, refuses an email that already has an account (this never
 * changes an existing one), stores only the password's argon2id hash.
 */
export async function createUser(
  prisma: Pick<PrismaClient, 'user'>,
  input: unknown,
): Promise<CreatedUser> {
  const { email, name, role, password } = NewUserSchema.parse(input);
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new Error(`An account with the email ${email} already exists: nothing was changed.`);
  }
  return prisma.user.create({
    data: { email, name, role, passwordHash: await hashPassword(password) },
    select: { id: true, email: true, role: true },
  });
}

/** One line per invalid field, without echoing any value (the password among them). */
export function describeInvalidInput(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  --${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('\n');
}
