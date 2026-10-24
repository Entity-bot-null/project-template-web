import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { errorSummary } from '../common/logging/error-summary.js';
import { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import type { SignUpConfirmationPayload } from '../infrastructure/mail/templates/sign-up-confirmation.template.js';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashAccountToken } from './account-tokens.js';
import { normalizeEmail, SIGN_UP_ENABLED, SIGN_UP_MAX_FAILED_ATTEMPTS } from './auth.constants.js';
import { AuthService, type SignInResult } from './auth.service.js';
import type { AuthUser, SignUpDto } from './dto/auth.schemas.js';
import { checkPassword, hashPassword } from './password.js';
import { passwordProblem } from './password-policy.js';
import { SessionsService } from './sessions.service.js';

const ACCOUNT_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

/** One answer for every link that does not work: unknown, replaced, used or expired. */
export const INVALID_SIGN_UP_LINK = 'This link is invalid or has expired';
/** The password given with the link is not the one chosen at sign-up. */
export const WRONG_SIGN_UP_PASSWORD = 'This is not the password chosen at sign-up';
/** An account appeared for the address after the sign-up (an operator created it). */
export const ACCOUNT_EXISTS = 'An account with this address exists: sign in';
export const SIGN_UP_CLOSED = 'Sign-up is closed';

/** The sign-up's message was held back (per-address limits): its replacement is rolled back. */
class HeldBack extends Error {}

// "Create an account" (docs/security.md#sign-up), when SIGN_UP_ENABLED. Two
// steps, and no account until the second:
//   1. asking: the answer is the same, at once, for any address (looked up
//      after the answer). A new address gets a sign-up and a confirmation
//      link; one with an account gets a notice to its owner instead.
//   2. confirming: the link's token AND the password chosen at sign-up. A
//      person who opens a link they did not ask for (someone signed up with
//      their address) cannot finish it; the one who asked is signed in.
@Injectable()
export class SignUpService {
  private readonly logger = new Logger(SignUpService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailOutboxService,
    private readonly sessions: SessionsService,
    private readonly auth: AuthService,
    @Inject(SIGN_UP_ENABLED) private readonly enabled: boolean,
  ) {}

  /** Sign-up is open here: SIGN_UP_ENABLED, and email to confirm it. */
  get available(): boolean {
    return this.enabled && this.mail.enabled;
  }

  /**
   * Asks to create an account. The password policy is checked first (its
   * answer says nothing about the address). Then it returns before the
   * address is looked up: the answer and its timing are the same whether an
   * account exists or not, and the rest happens after it.
   */
  request({ email, name, password }: SignUpDto): void {
    if (!this.available) throw new ForbiddenException(SIGN_UP_CLOSED);
    const address = normalizeEmail(email);
    const problem = passwordProblem(password, { email: address, name });
    if (problem !== undefined) throw new BadRequestException(`password: ${problem}`);
    const work: Promise<void> = this.register(address, name, password)
      .catch((error: unknown) => {
        this.logger.error(`Could not record a sign-up: ${errorSummary(error)}`);
      })
      .finally(() => {
        this.pending.delete(work);
      });
    this.pending.add(work);
  }

  /** Resolves once every request received so far has been recorded (specs). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /**
   * Creates the account of a sign-up with its link's token and the password
   * chosen with it, and signs the person in. A wrong password counts against
   * the sign-up (dropped after SIGN_UP_MAX_FAILED_ATTEMPTS); the link then
   * stops working. Two confirmations of one link: the second finds it gone.
   * Like a sign-in, a session this browser already had (previousToken) ends.
   */
  async confirm(
    token: string,
    password: string,
    previousToken?: string,
    now = Date.now(),
  ): Promise<SignInResult> {
    if (!this.available) throw new ForbiddenException(SIGN_UP_CLOSED);
    const tokenHash = hashAccountToken(token);
    const signUp = await this.prisma.signUp.findUnique({
      where: { tokenHash },
      select: { id: true, email: true, name: true, passwordHash: true, expiresAt: true },
    });
    if (signUp?.expiresAt == null || signUp.expiresAt.getTime() <= now) {
      throw new NotFoundException(INVALID_SIGN_UP_LINK);
    }
    // The attempt is spent before the password is checked: requests sent in
    // parallel each spend one, and none is checked past the limit.
    const attempts = await this.reserveAttempt(signUp.id, tokenHash);
    if (attempts === undefined) throw new NotFoundException(INVALID_SIGN_UP_LINK);
    if (!(await checkPassword(signUp.passwordHash, password))) {
      if (attempts >= SIGN_UP_MAX_FAILED_ATTEMPTS) {
        await this.prisma.signUp.deleteMany({ where: { id: signUp.id, tokenHash } });
        this.logger.warn(`Sign-up ${signUp.id} dropped after ${String(attempts)} wrong passwords`);
      }
      throw new UnauthorizedException(WRONG_SIGN_UP_PASSWORD);
    }

    let user: AuthUser;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        // Still this sign-up, with this link: not replaced, used or dropped
        // since the password was checked. Locked until the account exists.
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "sign_ups"
          WHERE "id" = ${signUp.id}::uuid AND "token_hash" = ${tokenHash}
          FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundException(INVALID_SIGN_UP_LINK);
        await tx.signUp.delete({ where: { id: signUp.id } });
        return tx.user.create({
          data: {
            email: signUp.email,
            name: signUp.name,
            role: 'member',
            passwordHash: signUp.passwordHash,
          },
          select: { id: true, email: true, name: true, role: true },
        });
      }, ACCOUNT_TRANSACTION);
    } catch (error) {
      // users.email is unique: an account created for the address meanwhile.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(ACCOUNT_EXISTS);
      }
      throw error;
    }
    this.logger.log(`Account ${user.id} created by sign-up`);
    if (previousToken !== undefined) await this.sessions.retire(previousToken, 'sign-in');
    const refresh = await this.sessions.create(user.id, signUp.passwordHash);
    return { session: await this.auth.sessionFor(user, refresh), refresh };
  }

  private async register(email: string, name: string, password: string): Promise<void> {
    // Hashed before the transaction, which holds the address's lock meanwhile.
    const passwordHash = await hashPassword(password);
    let queued: boolean;
    try {
      queued = await this.prisma.$transaction(async (tx) => {
        // Requests for one address, one at a time (any instance).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sign-up:${email}`}, 0))`;
        const account = await tx.user.findUnique({ where: { email }, select: { id: true } });
        if (account !== null) {
          const result = await this.mail.enqueue(tx, {
            kind: 'sign_up_existing',
            to: email,
            userId: account.id,
          });
          return result === 'queued';
        }
        // A new sign-up replaces the address's earlier one, and with it its
        // link; but only if its own message goes out: past the per-address
        // limits it is rolled back, and the earlier one stays as it was.
        await tx.signUp.deleteMany({ where: { email } });
        const signUp = await tx.signUp.create({
          data: { email, name, passwordHash },
          select: { id: true },
        });
        const payload: SignUpConfirmationPayload = { signUpId: signUp.id };
        const result = await this.mail.enqueue(tx, {
          kind: 'sign_up_confirmation',
          to: email,
          payload,
        });
        if (result !== 'queued') throw new HeldBack();
        return true;
      }, ACCOUNT_TRANSACTION);
    } catch (error) {
      if (!(error instanceof HeldBack)) throw error;
      queued = false;
    }
    if (queued) this.mail.notifyQueued();
  }

  // Atomic, in one statement: the attempt's number, or undefined once the
  // limit is spent (or the sign-up is gone, replaced or confirmed). A wrong
  // password on the last attempt drops the sign-up; a right one confirms it.
  private async reserveAttempt(id: string, tokenHash: string): Promise<number | undefined> {
    const rows = await this.prisma.$queryRaw<{ failedAttempts: number }[]>`
      UPDATE "sign_ups" SET "failed_attempts" = "failed_attempts" + 1
      WHERE "id" = ${id}::uuid AND "token_hash" = ${tokenHash}
        AND "failed_attempts" < ${SIGN_UP_MAX_FAILED_ATTEMPTS}
      RETURNING "failed_attempts" AS "failedAttempts"`;
    return rows[0]?.failedAttempts;
  }
}
