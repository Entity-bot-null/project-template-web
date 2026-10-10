import { Injectable, NotFoundException } from '@nestjs/common';
import type { Page, PageQuery } from '../common/pagination.js';
import type { RequestUser } from '../common/types/request-user.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { USER_SELECT } from './dto/user.schemas.js';

type User = Awaited<ReturnType<UsersService['me']>>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async me(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    // A valid token for a deleted account.
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // Bounded by the page size; ordered by a unique key so pages never overlap
  // or skip rows when several share a creation time.
  async list({ limit, offset }: PageQuery): Promise<Page<User>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        select: USER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count(),
    ]);
    return { items, total };
  }

  // Object-level authorization (BOLA/IDOR, docs/authorization.md): the
  // ownership rule is part of the query, not a check in the controller. A
  // member may only read themselves; anyone else's record answers 404, exactly
  // like a missing one, so ids cannot be probed for existence. The database
  // compares the ids as UUIDs, whatever their letter case.
  async findVisible(actor: RequestUser, id: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { AND: [{ id }, actor.role === 'admin' ? {} : { id: actor.id }] },
      select: USER_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
