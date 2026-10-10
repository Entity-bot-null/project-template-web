import type { operations } from '../api/client';

// Shapes come from the generated contract: sign-in and refresh answer with
// the same session body.
export type AuthSession =
  operations['AuthController_signIn']['responses'][200]['content']['application/json']['data'];
export type AuthUser = AuthSession['user'];
export type Role = AuthUser['role'];

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export type AuthState =
  | { status: 'loading'; user: null }
  // signedOut: the user signed out on this page; 'failed' when the server
  // could not be reached to end the session (the sign-in page offers a retry).
  | { status: 'anonymous'; user: null; signedOut?: 'done' | 'failed' }
  | { status: 'authenticated'; user: AuthUser };
