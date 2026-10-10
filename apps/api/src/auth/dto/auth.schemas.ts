import { z } from 'zod';
import { ROLES } from '../../common/types/request-user.js';
import { PASSWORD_MAX_LENGTH } from '../auth.constants.js';

export const SignInSchema = z.object({
  // Trimmed before the format check; the service lowercases it. The meta
  // keeps `format: email` in the contract, which the pipe would drop.
  email: z.string().trim().max(254).pipe(z.email()).meta({ format: 'email' }),
  // No password policy on sign-in: whatever was accepted when it was set
  // must keep working. The maximum only bounds the hashing work.
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
});
export type SignInDto = z.infer<typeof SignInSchema>;

export const AuthUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(ROLES),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

// The refresh token never appears in a body: it travels as an httpOnly cookie.
export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  user: AuthUserSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

// The claims of the access token: the signer builds exactly this and the
// guard accepts exactly this, so a new claim changes both at once.
export const AccessTokenPayloadSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
});
export type AccessTokenPayload = z.infer<typeof AccessTokenPayloadSchema>;
