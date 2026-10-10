import { describe, expect, it } from 'vitest';
import { Role } from '../../prisma/generated/client.js';
import { ROLES } from './request-user.js';

describe('ROLES', () => {
  it('lists exactly the roles of the database enum', () => {
    expect([...ROLES].sort()).toEqual(Object.values(Role).sort());
  });
});
