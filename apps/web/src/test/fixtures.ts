import type { AuthUser } from '../auth';

// Shapes follow the generated contract types, so a contract change that
// breaks a fixture fails the type check.
export const member: AuthUser = {
  id: '0190b6a1-0000-7000-8000-000000000001',
  email: 'member@example.com',
  name: 'Member',
  role: 'member',
};

export const admin: AuthUser = {
  id: '0190b6a1-0000-7000-8000-000000000002',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
};
