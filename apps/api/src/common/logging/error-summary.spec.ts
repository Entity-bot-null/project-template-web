import { describe, expect, it } from 'vitest';
import { Prisma } from '../../prisma/generated/client.js';
import { errorSummary } from './error-summary.js';

describe('errorSummary', () => {
  it("logs Prisma's errors by class and code, never their message (it can quote arguments)", () => {
    const known = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on email ada@example.test',
      { code: 'P2002', clientVersion: 'test' },
    );
    expect(errorSummary(known)).toBe('PrismaClientKnownRequestError P2002');
    const validation = new Prisma.PrismaClientValidationError(
      'Invalid invocation: where: { email: "ada@example.test" }',
      { clientVersion: 'test' },
    );
    expect(errorSummary(validation)).toBe('PrismaClientValidationError');
    expect(errorSummary(validation)).not.toContain('ada@');
  });

  it('keeps the message of other errors, and stringifies anything else', () => {
    expect(errorSummary(new Error('database down'))).toBe('database down');
    expect(errorSummary('plain')).toBe('plain');
  });
});
