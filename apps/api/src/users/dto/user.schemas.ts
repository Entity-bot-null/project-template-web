import { z } from 'zod';
import { pageOf } from '../../common/pagination.js';
import { ROLES } from '../../common/types/request-user.js';

// What the API says about a user. Never the password hash: every query goes
// through USER_SELECT, so a new column is private until added here.
export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(ROLES),
  createdAt: z.iso.datetime(),
});
export type UserResponse = z.infer<typeof UserSchema>;

export const UserPageSchema = pageOf(UserSchema);

export const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
} as const;
