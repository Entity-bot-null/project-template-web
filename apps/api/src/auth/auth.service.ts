import { Injectable, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import { ACCESS_TOKEN_TTL_SEC, normalizeEmail } from './auth.constants.js';
import type { AccessTokenPayload, AuthSession, AuthUser } from './dto/auth.schemas.js';
import { checkPassword, dummyPasswordHash } from './password.js';
import { type IssuedSession, type RetireOutcome, SessionsService } from './sessions.service.js';

export interface SignInResult {
  /** The response body. */
  session: AuthSession;
  /** The refresh token, for the cookie only. */
  refresh: IssuedSession;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
  ) {}

  // The dummy hash is built at boot: built on first use, the first sign-in with
  // an unknown email after every start would pay a hash on top of the verify,
  // a timing signal that the account does not exist. A failure here is retried
  // on first use instead of stopping the boot.
  async onModuleInit(): Promise<void> {
    await dummyPasswordHash().catch(() => undefined);
  }

  // One answer for an unknown email and a wrong password, in the same time
  // (an unknown email is checked against a dummy hash): the response never
  // reveals whether an account exists. A session this browser already had is
  // ended first: one family per browser, and a stale token presented here
  // after its rotation is reported as theft like at refresh.
  async signIn(email: string, password: string, previousToken?: string): Promise<SignInResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, email: true, name: true, role: true, passwordHash: true },
    });
    const valid = await checkPassword(user?.passwordHash ?? (await dummyPasswordHash()), password);
    if (!user || !valid) throw new UnauthorizedException('Invalid email or password');
    const { passwordHash, ...authUser } = user;
    if (previousToken !== undefined) await this.sessions.retire(previousToken, 'sign-in');
    const refresh = await this.sessions.create(authUser.id, passwordHash);
    return { session: await this.sessionFor(authUser, refresh), refresh };
  }

  async refresh(token: string): Promise<SignInResult> {
    const { user, securityVersion, session } = await this.sessions.rotate(token);
    return {
      session: await this.sessionFor(user, { ...session, securityVersion }),
      refresh: session,
    };
  }

  /** `only`: the sessions this logout ends; any other one is left alone (SessionsService.retire). */
  logout(token: string, only?: readonly string[]): Promise<RetireOutcome> {
    return this.sessions.retire(token, 'logout', only);
  }

  // The access token carries the id, the role and the securityVersion, read
  // fresh from the database at sign-in and at every refresh: a role change
  // applies at the next refresh, at most ACCESS_TOKEN_TTL_SEC later; a new
  // password at once (the guard compares the securityVersion). Also used by
  // the account flows that start a session (a password change). The body
  // names the session (its family, the same across refreshes), which the
  // client hands back to end only that session.
  async sessionFor(
    user: AuthUser,
    { securityVersion, familyId }: { securityVersion: number; familyId: string },
  ): Promise<AuthSession> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role, sv: securityVersion };
    return {
      accessToken: await this.jwt.signAsync(payload),
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      sessionId: familyId,
      user,
    };
  }
}
