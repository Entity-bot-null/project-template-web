import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRecordAccess } from '../../test/access.js';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { asUser, bearer, seedUser, signIn } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';
import type { UserResponse } from './dto/user.schemas.js';

interface Seeded {
  id: string;
  email: string;
}

interface UserPage {
  items: UserResponse[];
  total: number;
}

describe('Users (integration)', () => {
  let t: TestApp;
  let admin: Seeded;
  let member: Seeded;
  let other: Seeded;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    admin = await seedUser(t.prisma, { email: 'admin@example.com', role: 'admin' });
    member = await seedUser(t.prisma, { email: 'member@example.com' });
    other = await seedUser(t.prisma, { email: 'other@example.com' });
  });

  afterAll(async () => {
    await t.app.close();
  });

  const asAdmin = () => asUser(t.app, admin.id, 'admin');
  const asMember = () => asUser(t.app, member.id, 'member');

  describe('GET /api/users/me', () => {
    it('needs a valid access token', async () => {
      const res = await request(t.server).get('/api/users/me').expect(401);
      expect(res.body).toEqual({ data: null, message: 'Missing access token' });
      await request(t.server).get('/api/users/me').set(bearer('forged.token.value')).expect(401);
    });

    it('returns the caller, never the password hash', async () => {
      const { accessToken } = await signIn(t.server, member.email);
      const res = await request(t.server).get('/api/users/me').set(bearer(accessToken)).expect(200);
      expect(envelopeOf(res).data).toMatchObject({
        id: member.id,
        email: member.email,
        role: 'member',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });
  });

  describe('GET /api/users (admins only)', () => {
    it('needs a valid access token', async () => {
      const res = await request(t.server).get('/api/users').expect(401);
      expect(res.body).toEqual({ data: null, message: 'Missing access token' });
    });

    it('refuses members', async () => {
      const res = await request(t.server).get('/api/users').set(asMember()).expect(403);
      expect(envelopeOf(res).data).toBeNull();
    });

    it('pages through every user for an admin', async () => {
      const first = envelopeOf<UserPage>(
        await request(t.server).get('/api/users?limit=2&offset=0').set(asAdmin()).expect(200),
      ).data;
      expect(first.total).toBe(3);
      expect(first.items).toHaveLength(2);
      const rest = envelopeOf<UserPage>(
        await request(t.server).get('/api/users?limit=2&offset=2').set(asAdmin()).expect(200),
      ).data;
      const ids = [...first.items, ...rest.items].map((user) => user.id);
      expect(new Set(ids)).toEqual(new Set([admin.id, member.id, other.id]));
    });

    it('rejects a page size above the maximum', async () => {
      const res = await request(t.server).get('/api/users?limit=1000').set(asAdmin()).expect(400);
      expect(envelopeOf(res).message).toMatch(/^limit: /);
    });
  });

  describe('GET /api/users/:id (owner or admin)', () => {
    it('needs a valid access token', async () => {
      const res = await request(t.server).get(`/api/users/${member.id}`).expect(401);
      expect(res.body).toEqual({ data: null, message: 'Missing access token' });
    });

    it("lets the owner and admins read a record; another member gets a missing record's 404", async () => {
      await expectRecordAccess(t.server, {
        path: (id) => `/api/users/${id}`,
        id: member.id,
        owner: asMember(),
        other: asUser(t.app, other.id, 'member'),
        admin: asAdmin(),
      });
    });

    it('lets a member read themselves whatever the letter case of the id', async () => {
      const res = await request(t.server)
        .get(`/api/users/${member.id.toUpperCase()}`)
        .set(asMember())
        .expect(200);
      expect(envelopeOf<UserResponse>(res).data.id).toBe(member.id);
    });

    it('rejects an id that is not a UUID', async () => {
      await request(t.server).get('/api/users/123').set(asAdmin()).expect(400);
    });
  });
});
