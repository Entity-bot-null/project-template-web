import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuthService, type SignInResult } from '../auth/auth.service.js';
import { checkPassword, hashPassword } from '../auth/password.js';
import { passwordProblem } from '../auth/password-policy.js';
import { lockUser, revokeSessionsLocked, SessionsService } from '../auth/sessions.service.js';
import { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import type { PasswordChangedPayload } from '../infrastructure/mail/templates/password-changed.template.js';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ACCOUNT_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

// What the signed-in person changes about their own account
// (docs/security.md#password-change).
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly mail: MailOutboxService,
  ) {}

  /**
   * Replaces the password, after the current one is checked again (a session
   * alone is not enough: it may be someone else's). In one transaction under
   * the account's lock: the password, a raised securityVersion (every access
   * token ends at once), every session revoked, any reset link dropped, a
   * notice queued to the address. Then this browser carries on in a new
   * session; every other one is signed out.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<SignInResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, passwordHash: true },
    });
    if (user === null) throw new NotFoundException('User not found');
    const problem = passwordProblem(newPassword, { email: user.email, name: user.name });
    if (problem !== undefined) throw new BadRequestException(`newPassword: ${problem}`);
    if (!(await checkPassword(user.passwordHash, currentPassword))) {
      // 403, not 401: the session is fine, the confirmation is not.
      throw new ForbiddenException('The current password is wrong');
    }

    const passwordHash = await hashPassword(newPassword);
    const payload: PasswordChangedPayload = { changedAt: new Date().toISOString(), via: 'change' };
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, user.id);
      const current = await tx.user.findUnique({
        where: { id: user.id },
        select: { email: true, passwordHash: true },
      });
      // Another change or a reset got there first: this request was checked
      // against a password that is no longer the account's.
      if (current?.passwordHash !== user.passwordHash) {
        throw new ConflictException('The password changed meanwhile');
      }
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, securityVersion: { increment: 1 } },
      });
      await revokeSessionsLocked(tx, user.id);
      await tx.accountToken.deleteMany({
        where: { userId: user.id, purpose: 'password_reset', usedAt: null },
      });
      await this.mail.enqueue(tx, {
        kind: 'password_changed',
        to: current.email,
        userId: user.id,
        payload,
      });
    }, ACCOUNT_TRANSACTION);
    this.mail.notifyQueued();
    this.logger.log(`Password changed by user ${user.id}: every other session ended`);

    const refresh = await this.sessions.create(user.id, passwordHash);
    const { passwordHash: _hash, ...authUser } = user;
    return { session: await this.auth.sessionFor(authUser, refresh.securityVersion), refresh };
  }
}
