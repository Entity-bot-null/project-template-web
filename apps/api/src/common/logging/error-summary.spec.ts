import { describe, expect, it } from 'vitest';
import { Prisma } from '../../prisma/generated/client.js';
import { errorSummary, loggableStack, reportableError } from './error-summary.js';

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

const validation = () =>
  new Prisma.PrismaClientValidationError(
    'Invalid `prisma.user.findUnique()` invocation:\n\n{\n  where: {\n    email: "ada@example.test",\n  }\n}',
    { clientVersion: 'test' },
  );

describe('loggableStack', () => {
  it("keeps a Prisma error's frames and drops its message", () => {
    const stack = loggableStack(validation());
    expect(stack.split('\n')[0]).toBe('PrismaClientValidationError');
    expect(stack).toMatch(/\n\s+at /);
    expect(stack).not.toContain('ada@example.test');
  });

  it('keeps the whole stack of other errors', () => {
    const error = new Error('boom');
    expect(loggableStack(error)).toBe(error.stack);
    expect(loggableStack('plain')).toBe('plain');
  });
});

describe('reportableError', () => {
  it('reports a Prisma error by class, code and frames, without its message', () => {
    const known = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on email ada@example.test',
      { code: 'P2002', clientVersion: 'test' },
    );
    const reported = reportableError(known) as Error;
    expect(reported).toMatchObject({ name: 'PrismaClientKnownRequestError', message: 'P2002' });
    const withheld = reportableError(validation()) as Error;
    expect(withheld.name).toBe('PrismaClientValidationError');
    expect(`${withheld.message}\n${withheld.stack ?? ''}`).not.toContain('ada@example.test');
  });

  it('reports any other error as it is', () => {
    const error = new Error('boom');
    expect(reportableError(error)).toBe(error);
  });
});
