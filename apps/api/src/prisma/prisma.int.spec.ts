import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from './prisma.service.js';

// The database client against the test database: the pool settings reach
// the server, and the boot really talks to it.
describe('PrismaService (integration)', () => {
  const services: PrismaService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.onModuleDestroy();
  });

  it('connects at boot, and runs every statement under the statement timeout', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const prisma = new PrismaService();
    services.push(prisma);
    await prisma.onModuleInit();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Database connected \(/));
    const [row] = await prisma.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(row?.statement_timeout).toBe('30s');
  });
});
