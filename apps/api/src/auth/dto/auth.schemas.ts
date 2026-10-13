import { z } from 'zod';
import { ROLES } from '../../common/types/request-user.js';
import { PASSWORD_MAX_INPUT_LENGTH } from '../auth.constants.js';

export const SignInSchema = z.object({
  // Trimmed before the format check; the service lowercases it. The meta
  // keeps `format: email` in the contract, which the pipe would drop.
  email: z.string().trim().max(254).pipe(z.email()).meta({ format: 'email' }),
  // No password policy on sign-in: whatever was accepted when it was set
  // must keep working. The maximum only bounds the hashing work.
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_INPUT_LENGTH),
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
// guard accepts exactly this, so a new claim changes both at once. sv is the
// user's securityVersion when the token was minted: once it moves on (a new
// password), the guard refuses the token at once instead of letting it live
// out its 15 minutes.
export const AccessTokenPayloadSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
  sv: z.number().int().nonnegative(),
});
export type AccessTokenPayload = z.infer<typeof AccessTokenPayloadSchema>;

// What this deployment offers, so the web app shows only what works.
export const AuthCapabilitiesSchema = z.object({
  /** Email is configured: "Forgot your password?" can send a link. */
  passwordReset: z.boolean(),
});
export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>;

export const PasswordResetRequestSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()).meta({ format: 'email' }),
});
export type PasswordResetRequestDto = z.infer<typeof PasswordResetRequestSchema>;

// A token is 32 random bytes in base64url: anything else is refused before
// any lookup.
export const ONE_TIME_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid link');

// The policy (password-policy.ts) is checked by the service, which knows the
// account; the schema bounds the size.
const newPassword = z.string().min(1, 'Password is required').max(PASSWORD_MAX_INPUT_LENGTH);

export const PasswordResetConfirmSchema = z.object({
  token: ONE_TIME_TOKEN,
  password: newPassword,
});
export type PasswordResetConfirmDto = z.infer<typeof PasswordResetConfirmSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(PASSWORD_MAX_INPUT_LENGTH),
  newPassword,
});
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;
