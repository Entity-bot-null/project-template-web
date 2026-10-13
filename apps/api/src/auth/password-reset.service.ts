import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { errorSummary } from '../common/logging/error-summary.js';
import { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import type { PasswordChangedPayload } from '../infrastructure/mail/templates/password-changed.template.js';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { consumeAccountToken, tokenOwner } from './account-tokens.js';
import { normalizeEmail } from './auth.constants.js';
import { hashPassword } from './password.js';
import { passwordProblem } from './password-policy.js';
import { lockUser, revokeSessionsLocked } from './sessions.service.js';

const ACCOUNT_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

/** One answer for every link that does not work: unknown, used, expired, or for an account that changed. */
export const INVALID_RESET_LINK = 'This link is invalid or has expired';

// "Forgot your password?" (docs/security.md#password-recovery). Two steps:
// asking for a link, which answers the same at once for any address (the
// account is looked up after the answer), and choosing a new password with the
// link's token, which ends every session of the account.
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailOutboxService,
  ) {}

  /** A link can be sent: email is configured. */
  get available(): boolean {
    return this.mail.enabled;
  }

  /**
   * Asks for a reset link for an address. Returns before the address is even
   * looked up: the answer, its status and its timing are the same whether an
   * account exists or not. Then, for an account, the message is queued (the
   * outbox limits how many one address gets); for no account, nothing.
   */
  request(email: string): void {
    if (!this.available)
      throw new ServiceUnavailableException('Password recovery is not available');
    const work: Promise<void> = this.queueLink(normalizeEmail(email))
      .catch((error: unknown) => {
        this.logger.error(`Could not queue a password reset message: ${errorSummary(error)}`);
      })
      .finally(() => {
        this.pending.delete(work);
      });
    this.pending.add(work);
  }

  /** Resolves once every request received so far has been looked up and queued (specs). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /**
   * Sets a new password with a reset link's token, which works once. The
   * policy is checked first, so a refused password leaves the link usable.
   * Then, in one transaction under the account's lock: the token is taken
   * (it must still match the account: same securityVersion and email), the
   * password replaced, the securityVersion raised (every access token ends at
   * once), every session revoked, any other reset link dropped, and a notice
   * queued to the address. Nobody is signed in: the person signs in with the
   * new password.
   */
  async confirm(token: string, password: string): Promise<void> {
    const ownerId = await tokenOwner(this.prisma, token, 'password_reset');
    const owner =
      ownerId === undefined
        ? null
        : await this.prisma.user.findUnique({
            where: { id: ownerId },
            select: { id: true, email: true, name: true },
          });
    if (owner === null) throw new NotFoundException(INVALID_RESET_LINK);
    const problem = passwordProblem(password, { email: owner.email, name: owner.name });
    if (problem !== undefined) throw new BadRequestException(`password: ${problem}`);

    // Hashed before the transaction: it holds the account's lock meanwhile.
    const passwordHash = await hashPassword(password);
    const changedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, owner.id);
      const account = await tx.user.findUnique({
        where: { id: owner.id },
        select: { id: true, email: true, securityVersion: true },
      });
      if (account === null) throw new NotFoundException(INVALID_RESET_LINK);
      const used = await consumeAccountToken(tx, token, 'password_reset', account);
      if (used === undefined) throw new NotFoundException(INVALID_RESET_LINK);
      await tx.user.update({
        where: { id: account.id },
        data: { passwordHash, securityVersion: { increment: 1 } },
      });
      await revokeSessionsLocked(tx, account.id);
      await tx.accountToken.deleteMany({
        where: { userId: account.id, purpose: 'password_reset', usedAt: null },
      });
      const payload: PasswordChangedPayload = { changedAt: changedAt.toISOString(), via: 'reset' };
      await this.mail.enqueue(tx, {
        kind: 'password_changed',
        to: account.email,
        userId: account.id,
        payload,
      });
    }, ACCOUNT_TRANSACTION);
    this.mail.notifyQueued();
    this.logger.log(`Password reset for user ${owner.id}: every session ended`);
  }

  private async queueLink(email: string): Promise<void> {
    const queued = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { email },
        select: { id: true, email: true },
      });
      if (user === null) return false;
      const result = await this.mail.enqueue(tx, {
        kind: 'password_reset',
        to: user.email,
        userId: user.id,
      });
      return result === 'queued';
    });
    if (queued) this.mail.notifyQueued();
  }
}
