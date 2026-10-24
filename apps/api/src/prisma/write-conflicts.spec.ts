import { describe, expect, it } from 'vitest';
import { Prisma } from './generated/client.js';
import { isWriteConflict, onceMoreOnWriteConflict } from './write-conflicts.js';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`failure ${code}`, {
    code,
    clientVersion: 'test',
    ...(meta === undefined ? {} : { meta }),
  });
const raw = (kind: string) =>
  known('P2010', { driverAdapterError: { cause: { originalCode: '40P01', kind } } });

describe('isWriteConflict', () => {
  it("is a model query's P2034 and a raw query's P2010 that the adapter calls a write conflict", () => {
    expect(isWriteConflict(known('P2034'))).toBe(true);
    expect(isWriteConflict(raw('TransactionWriteConflict'))).toBe(true);
    expect(isWriteConflict(raw('CheckViolation'))).toBe(false);
    expect(isWriteConflict(known('P2010'))).toBe(false);
    expect(isWriteConflict(known('P2002'))).toBe(false);
    expect(isWriteConflict(new Error('P2034'))).toBe(false);
  });
});

describe('onceMoreOnWriteConflict', () => {
  it('runs the work once more after a write conflict, and only once', async () => {
    let runs = 0;
    await expect(
      onceMoreOnWriteConflict(() => {
        runs += 1;
        return runs === 1
          ? Promise.reject(raw('TransactionWriteConflict'))
          : Promise.resolve('done');
      }),
    ).resolves.toBe('done');
    expect(runs).toBe(2);

    runs = 0;
    await expect(
      onceMoreOnWriteConflict(() => {
        runs += 1;
        return Promise.reject(known('P2034'));
      }),
    ).rejects.toThrow('P2034');
    expect(runs).toBe(2);

    runs = 0;
    await expect(
      onceMoreOnWriteConflict(() => {
        runs += 1;
        return Promise.reject(known('P2002'));
      }),
    ).rejects.toThrow('P2002');
    expect(runs).toBe(1);
  });
});
