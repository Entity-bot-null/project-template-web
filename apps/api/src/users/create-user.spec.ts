import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import type { PrismaClient } from '../prisma/generated/client.js';
import { createUser, describeInvalidInput } from './create-user.js';

const VALID = {
  email: '  Owner@Example.COM ',
  name: ' Owner ',
  role: 'admin',
  password: 'a long enough passphrase',
};

function setup(existing: unknown = null) {
  const findUnique = vi.fn().mockResolvedValue(existing);
  const create = vi
    .fn()
    .mockImplementation(({ data }: { data: { email: string; role: string } }) =>
      Promise.resolve({ id: '0190b6a1-0000-7000-8000-000000000001', ...data }),
    );
  const prisma = { user: { findUnique, create } } as unknown as Pick<PrismaClient, 'user'>;
  return { prisma, findUnique, create };
}

describe('createUser', () => {
  it('creates the account with a normalized email and only the password hash', async () => {
    const { prisma, create } = setup();
    const user = await createUser(prisma, VALID);
    expect(user).toMatchObject({ email: 'owner@example.com', role: 'admin' });
    const { data } = create.mock.calls[0]![0] as {
      data: { email: string; name: string; passwordHash: string };
    };
    expect(data).toMatchObject({ email: 'owner@example.com', name: 'Owner', role: 'admin' });
    expect(data).not.toHaveProperty('password');
    expect(data.passwordHash).not.toContain(VALID.password);
    await expect(verifyPassword(data.passwordHash, VALID.password)).resolves.toBe(true);
  });

  it('never changes an existing account', async () => {
    const { prisma, create } = setup({ id: 'existing' });
    await expect(createUser(prisma, VALID)).rejects.toThrow(/already exists: nothing was changed/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['a short password', { password: 'short' }, 'password'],
    ['one of the most used passwords', { password: 'correcthorsebatterystaple' }, 'password'],
    [
      'a password with the email in it',
      { password: 'the owner of this long passphrase' },
      'password',
    ],
    ['an invalid email', { email: 'not-an-email' }, 'email'],
    ['an unknown role', { role: 'root' }, 'role'],
    ['an empty name', { name: '   ' }, 'name'],
  ])('refuses %s before touching the database', async (_case, change, field) => {
    const { prisma, findUnique } = setup();
    const error = await createUser(prisma, { ...VALID, ...change }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(z.ZodError);
    expect(describeInvalidInput(error as z.ZodError)).toContain(`--${field}:`);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses input that is not an account at all', async () => {
    const { prisma } = setup();
    const error = (await createUser(prisma, null).catch((caught: unknown) => caught)) as z.ZodError;
    expect(describeInvalidInput(error)).toMatch(/^ {2}--input: /);
  });

  it('never echoes the values it refuses', async () => {
    const { prisma } = setup();
    const error = (await createUser(prisma, { ...VALID, password: 'tiny-secret' }).catch(
      (caught: unknown) => caught,
    )) as z.ZodError;
    expect(describeInvalidInput(error)).not.toContain('tiny-secret');
  });
});
