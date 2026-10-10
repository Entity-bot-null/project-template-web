import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { hashPassword } from '../src/auth/password.js';
import type { Role } from '../src/common/types/request-user.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { envelopeOf } from './http.js';

export const TEST_PASSWORD = 'correct-horse-battery';

/** Creates a user with a real argon2 hash; the role defaults to member. */
export async function seedUser(
  prisma: PrismaService,
  data: { email: string; name?: string; role?: Role },
) {
  return prisma.user.create({
    data: {
      email: data.email,
      name: data.name ?? data.email.split('@')[0] ?? data.email,
      role: data.role ?? 'member',
      passwordHash: await hashPassword(TEST_PASSWORD),
    },
  });
}

export interface SignedIn {
  accessToken: string;
  /** The Set-Cookie headers of the response. */
  setCookies: string[];
  /** `refresh_token=<value>`, ready for a Cookie header. */
  refreshCookie: string;
}

/** Signs in through the API and returns what a browser would hold. */
export async function signIn(
  server: Server,
  email: string,
  password = TEST_PASSWORD,
): Promise<SignedIn> {
  const res = await request(server).post('/api/auth/sign-in').send({ email, password }).expect(200);
  const setCookies = cookiesOf(res);
  const refresh = setCookies.find((cookie) => cookie.startsWith('refresh_token='));
  if (refresh === undefined) throw new Error('sign-in set no refresh cookie');
  return {
    accessToken: envelopeOf<{ accessToken: string }>(res).data.accessToken,
    setCookies,
    refreshCookie: refresh.split(';', 1)[0] ?? refresh,
  };
}

export function cookiesOf(res: request.Response): string[] {
  const header: unknown = res.headers['set-cookie'];
  if (Array.isArray(header)) {
    return header.filter((value): value is string => typeof value === 'string');
  }
  return typeof header === 'string' ? [header] : [];
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A bearer header minted with the app's own signer: the guard verifies tokens
 * offline, so suites that only need "some admin" need no database row.
 */
export function asUser(app: INestApplication, id: string, role: Role = 'member') {
  return bearer(app.get(JwtService).sign({ sub: id, role }));
}
