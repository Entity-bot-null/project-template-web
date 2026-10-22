import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { consumeAccountToken, hashAccountToken } from '../auth/account-tokens.js';
import { normalizeEmail } from '../auth/auth.constants.js';
import { checkPassword, hashPassword } from '../auth/password.js';
import { passwordProblem } from '../auth/password-policy.js';
import { lockUser, revokeSessionsLocked } from '../auth/sessions.service.js';
import { errorSummary } from '../common/logging/error-summary.js';
import { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import type { EmailChangeRequestPayload } from '../infrastructure/mail/templates/email-change-confirmation.template.js';
import type { EmailChangedPayload } from '../infrastructure/mail/templates/email-changed.template.js';
import type { PasswordChangedPayload } from '../infrastructure/mail/templates/password-changed.template.js';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { onceMoreOnWriteConflict } from '../prisma/write-conflicts.js';

const ACCOUNT_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

/** One answer for every link that does not work: unknown, used, expired, or for an account that changed. */
export const INVALID_EMAIL_LINK = 'This link is invalid or has expired';
/** The address got an account of its own after the link was sent. */
export const ADDRESS_TAKEN = 'This address is used by another account';
export const SAME_ADDRESS = 'newEmail: This is already the address of the account';
export const WRONG_CURRENT_PASSWORD = 'The current password is wrong';

// Changing the account's address (docs/security.md#change-of-email), in three
// steps, so that a session in someone else's hands cannot take the account:
//   1. asking, signed in and with the current password: a link goes to the
//      NEW address (or, if it has an account, a notice to its owner, and the
//      person asking is answered the same: no enumeration);
//   2. confirming from the new address: the address changes, every session
//      ends, and the PREVIOUS address gets a notice with a link to undo it;
//   3. undoing, from the previous address, within days: it comes back, with
//      a new password (whoever changed it knew the old one), and every
//      session ends again.
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailOutboxService,
  ) {}

  /** A change can be confirmed: email is configured. */
  get available(): boolean {
    return this.mail.enabled;
  }

  /**
   * Asks to move the account to `newEmail`, after the current password is
   * checked again (a session alone is not enough: it may be someone else's).
   * Answers once that check is done; whether the new address has an account
   * is looked up after the answer, so neither the answer nor its timing says.
   */
  async request(userId: string, currentPassword: string, newEmail: string): Promise<void> {
    if (!this.available)
      throw new ServiceUnavailableException('Changing the email is not available');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, securityVersion: true },
    });
    if (user === null) throw new NotFoundException('User not found');
    const address = normalizeEmail(newEmail);
    if (address === user.email) throw new BadRequestException(SAME_ADDRESS);
    if (!(await checkPassword(user.passwordHash, currentPassword))) {
      // 403, not 401: the session is fine, the confirmation is not.
      throw new ForbiddenException(WRONG_CURRENT_PASSWORD);
    }
    const work: Promise<void> = this.queueLink(user.id, address, user.securityVersion)
      .catch((error: unknown) => {
        this.logger.error(`Could not queue a change of email: ${errorSummary(error)}`);
      })
      .finally(() => {
        this.pending.delete(work);
      });
    this.pending.add(work);
  }

  /** Resolves once every request received so far has been queued (specs). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /**
   * Moves the account to the new address of a confirmation link, which works
   * once and only while the account is as it was when it was asked for. In one
   * transaction under the account's lock: the token is taken, the address
   * replaced, the securityVersion raised and every session ended (sign in
   * again with the new address), the other links of the account dropped, and
   * a notice with an undo link queued to the previous address.
   */
  async confirm(token: string, now = Date.now()): Promise<void> {
    const owner = await this.ownerOf(token, 'email_change', now);
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockUser(tx, owner.userId);
        const account = await tx.user.findUnique({
          where: { id: owner.userId },
          select: { id: true, email: true, securityVersion: true },
        });
        if (account === null) throw new NotFoundException(INVALID_EMAIL_LINK);
        const used = await consumeAccountToken(tx, token, 'email_change', account, now);
        if (used?.targetEmail == null) throw new NotFoundException(INVALID_EMAIL_LINK);
        await tx.user.update({
          where: { id: account.id },
          data: { email: used.targetEmail, securityVersion: { increment: 1 } },
        });
        await revokeSessionsLocked(tx, account.id);
        await tx.accountToken.deleteMany({
          where: {
            userId: account.id,
            purpose: { in: ['password_reset', 'email_change'] },
            usedAt: null,
          },
        });
        // The securityVersion right after this change ranks its undo link
        // among the account's others (revert), whenever the notice goes out.
        const payload: EmailChangedPayload = {
          changedAt: new Date(now).toISOString(),
          securityVersion: String(account.securityVersion + 1),
        };
        await this.mail.enqueue(tx, {
          kind: 'email_changed',
          to: account.email,
          userId: account.id,
          payload,
        });
      }, ACCOUNT_TRANSACTION);
    } catch (error) {
      throw takenAsConflict(error);
    }
    this.mail.notifyQueued();
    this.logger.log(`Email of user ${owner.userId} changed: every session ended`);
  }

  /**
   * Undoes a change of address with the link sent to the previous one: that
   * address comes back, with a new password (the policy is checked first, so
   * a refused one leaves the link usable). The link works once, for days,
   * whatever happened to the account since. In one transaction under the
   * account's lock: the address and the password replaced, the
   * securityVersion raised, every session ended, every other link of the
   * account dropped except the undo links of earlier changes (the earliest
   * owner wins), and
   * a notice queued to the restored address.
   */
  async revert(token: string, password: string, now = Date.now()): Promise<void> {
    const owner = await this.ownerOf(token, 'email_revert', now);
    const account = await this.prisma.user.findUnique({
      where: { id: owner.userId },
      select: { name: true },
    });
    if (account === null || owner.targetEmail === null) {
      throw new NotFoundException(INVALID_EMAIL_LINK);
    }
    const problem = passwordProblem(password, { email: owner.targetEmail, name: account.name });
    if (problem !== undefined) throw new BadRequestException(`password: ${problem}`);
    // Hashed before the transaction: it holds the account's lock meanwhile.
    const passwordHash = await hashPassword(password);
    let dropped: { dropped: number; unclaimed: number };
    try {
      // The undo drops several notices of the account (expireQueued): the
      // outbox's sweep or a retry from the command line may update some of
      // them in another order, and PostgreSQL then aborts one of the two as a
      // deadlock. Nothing of the undo committed: it runs once more.
      dropped = await onceMoreOnWriteConflict(() =>
        this.prisma.$transaction(async (tx) => {
          await lockUser(tx, owner.userId);
          const current = await tx.user.findUnique({
            where: { id: owner.userId },
            select: { id: true, email: true, securityVersion: true },
          });
          if (current === null) throw new NotFoundException(INVALID_EMAIL_LINK);
          const used = await consumeAccountToken(tx, token, 'email_revert', current, now, false);
          if (used?.targetEmail == null) throw new NotFoundException(INVALID_EMAIL_LINK);
          await tx.user.update({
            where: { id: current.id },
            data: { email: used.targetEmail, passwordHash, securityVersion: { increment: 1 } },
          });
          await revokeSessionsLocked(tx, current.id);
          // Every other link of the account, except the undo links of EARLIER
          // changes (a lower securityVersion right after the change), however
          // late their messages went out: the earliest owner wins. Whoever took
          // the account and undoes their own later change cannot void the
          // owner's link; the owner's link voids theirs.
          await tx.accountToken.deleteMany({
            where: {
              userId: current.id,
              usedAt: null,
              NOT: { purpose: 'email_revert', securityVersion: { lt: used.securityVersion } },
            },
          });
          // Notices of this change or later ones that still wait in the outbox
          // would mint undo links after this one is used: dropped unsent. One
          // being composed right now is refused by its template, which reads
          // its row under this lock (email-changed.template.ts); one composed
          // before it goes out with a link the deleteMany above voids.
          const superseded = await this.mail.expireQueued(tx, {
            kind: 'email_changed',
            userId: current.id,
            key: 'securityVersion',
            from: used.securityVersion,
            reason: 'superseded',
          });
          const payload: PasswordChangedPayload = {
            changedAt: new Date(now).toISOString(),
            via: 'reset',
          };
          await this.mail.enqueue(tx, {
            kind: 'password_changed',
            to: used.targetEmail,
            userId: current.id,
            payload,
          });
          return superseded;
        }, ACCOUNT_TRANSACTION),
      );
    } catch (error) {
      throw takenAsConflict(error);
    }
    this.mail.recordExpired('email_changed', dropped.unclaimed);
    this.mail.notifyQueued();
    this.logger.log(`Change of email of user ${owner.userId} undone: every session ended`);
  }

  // The account a link is for, read before the transaction (the password
  // policy needs the restored address): checked again, locked, inside it.
  private async ownerOf(
    token: string,
    purpose: 'email_change' | 'email_revert',
    now: number,
  ): Promise<{ userId: string; targetEmail: string | null }> {
    const row = await this.prisma.accountToken.findUnique({
      where: { tokenHash: hashAccountToken(token) },
      select: { userId: true, purpose: true, targetEmail: true, usedAt: true, expiresAt: true },
    });
    // Only a link that can still work goes further (no password check
    // against its account, no hashing for a used or expired one).
    if (row?.purpose !== purpose || row.usedAt !== null || row.expiresAt.getTime() <= now) {
      throw new NotFoundException(INVALID_EMAIL_LINK);
    }
    return { userId: row.userId, targetEmail: row.targetEmail };
  }

  // The link is bound to the account as it was when it was asked for (its
  // securityVersion, raised by every password change, reset and change of
  // address): a message still in the outbox then is sent with no link.
  private async queueLink(userId: string, address: string, securityVersion: number): Promise<void> {
    const queued = await this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.findUnique({ where: { email: address }, select: { id: true } });
      const payload: EmailChangeRequestPayload = { securityVersion: String(securityVersion) };
      const result =
        owner === null
          ? await this.mail.enqueue(tx, {
              kind: 'email_change_confirmation',
              to: address,
              userId,
              payload,
            })
          : await this.mail.enqueue(tx, {
              kind: 'email_change_existing',
              to: address,
              userId: owner.id,
            });
      return result === 'queued';
    });
    if (queued) this.mail.notifyQueued();
  }
}

// users.email is unique: an account took the address after the link was sent.
function takenAsConflict(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(ADDRESS_TAKEN);
  }
  return error;
}
