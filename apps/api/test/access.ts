import type { Server } from 'node:http';
import request from 'supertest';
import { expect } from 'vitest';

/** An id no record has (a valid UUID, so the route's validation lets it through). */
export const MISSING_ID = '0190b6a1-0000-7000-8000-00000000dead';

type Headers = Record<string, string>;

export interface RecordAccess {
  /** `get` by default. A `delete` checks no admin: the owner's call removes the record. */
  method?: 'get' | 'put' | 'patch' | 'delete';
  /** The route of one record, e.g. `(id) => \`/api/notes/${id}\``. */
  path: (id: string) => string;
  /** A record the owner holds. */
  id: string;
  /** The owner's headers (`asUser(...)`). */
  owner: Headers;
  /** Another account with the owner's role: it must not reach the record. */
  other: Headers;
  /** An admin's headers, when admins may reach the record. */
  admin?: Headers;
  /** The body of a write. */
  body?: object;
  /** What the owner gets: 200 by default. */
  status?: number;
}

/**
 * Object-level authorization (BOLA/IDOR) of a route on one owned record
 * (docs/authorization.md#tests): without a token, 401; from another account,
 * 404 with exactly the answer of a record that does not exist, so ids cannot
 * be probed; the owner, and an admin when given, get through. The refusals
 * come first, so a write reaches the record only from the owner.
 */
export async function expectRecordAccess(server: Server, access: RecordAccess): Promise<void> {
  const method = access.method ?? 'get';
  if (method === 'delete' && access.admin !== undefined) {
    throw new Error('A delete removes the record: check the admin with a record of its own.');
  }
  const send = (id: string, headers: Headers = {}) => {
    const call = request(server)[method](access.path(id)).set(headers);
    return access.body === undefined ? call : call.send(access.body);
  };

  await send(access.id).expect(401);
  const foreign = await send(access.id, access.other).expect(404);
  const missing = await send(MISSING_ID, access.owner).expect(404);
  expect(foreign.body).toEqual(missing.body);
  if (access.admin !== undefined) await send(access.id, access.admin).expect(access.status ?? 200);
  await send(access.id, access.owner).expect(access.status ?? 200);
}
