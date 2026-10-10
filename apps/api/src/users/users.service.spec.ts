import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../common/types/request-user.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const MEMBER: RequestUser = { id: '0190b6a1-0000-7000-8000-000000000001', role: 'member' };
const ADMIN: RequestUser = { id: '0190b6a1-0000-7000-8000-000000000002', role: 'admin' };
const OTHER_ID = '0190b6a1-0000-7000-8000-000000000003';
const record = (id: string) => ({ id, email: `${id}@example.com`, name: 'N', role: 'member' });

function setup(found: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(found);
  const findMany = vi.fn().mockReturnValue('findMany-query');
  const count = vi.fn().mockReturnValue('count-query');
  const $transaction = vi.fn().mockResolvedValue([[record(OTHER_ID)], 7]);
  const prisma = {
    user: { findFirst, findMany, count },
    $transaction,
  } as unknown as PrismaService;
  return { service: new UsersService(prisma), findFirst, findMany };
}

describe('UsersService.findVisible (object-level authorization)', () => {
  it("keeps a member to their own record inside the query: anyone else's is not found", async () => {
    const { service, findFirst } = setup(null);
    await expect(service.findVisible(MEMBER, OTHER_ID)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ id: OTHER_ID }, { id: MEMBER.id }] } }),
    );
  });

  it('lets an admin query any record', async () => {
    const { service, findFirst } = setup(record(OTHER_ID));
    await service.findVisible(ADMIN, OTHER_ID);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ id: OTHER_ID }, {}] } }),
    );
  });

  it('lets a member read their own record', async () => {
    const { service } = setup(record(MEMBER.id));
    await expect(service.findVisible(MEMBER, MEMBER.id)).resolves.toEqual(record(MEMBER.id));
  });

  it('lets an admin read any record', async () => {
    const { service } = setup(record(OTHER_ID));
    await expect(service.findVisible(ADMIN, OTHER_ID)).resolves.toEqual(record(OTHER_ID));
  });

  it('answers the same 404 for a record that does not exist', async () => {
    const { service } = setup(null);
    await expect(service.findVisible(ADMIN, OTHER_ID)).rejects.toThrow('User not found');
  });
});

describe('UsersService.list', () => {
  it('returns one bounded page in a stable order, with the total', async () => {
    const { service, findMany } = setup();
    await expect(service.list({ limit: 10, offset: 20 })).resolves.toEqual({
      items: [record(OTHER_ID)],
      total: 7,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        skip: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});
