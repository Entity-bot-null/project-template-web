import { Navigate, Outlet, useLocation } from 'react-router';
import { LoadingScreen } from '../components/LoadingScreen';
import { returnPath } from './return-path';
import type { Role } from './types';
import { useAuth } from './useAuth';

// Layout routes (docs/security.md#route-protection):
//   <Route element={<RequireAuth />}> ... </Route>
//   <Route element={<RequireRole role="admin" />}> ... </Route>
// While the boot refresh runs nothing is decided, so they show a loading
// screen instead of flashing the wrong page. They decide what to SHOW; the
// API decides what is ALLOWED, so every protected screen calls routes that
// the API guards too.

/** Signed in, any role. Anonymous visitors go to sign-in and come back after. */
export function RequireAuth() {
  const auth = useAuth();
  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'anonymous') return <ToSignIn signedOut={auth.signedOut !== undefined} />;
  // Keyed by the user: when the session switches to someone else (another tab
  // signed in as them), the pages under it start over, so nothing loaded for
  // the previous user stays on screen or lands late.
  return <Outlet key={auth.user.id} />;
}

/** Signed in with one of the roles; other roles are sent home. */
export function RequireRole({ role }: { role: Role | readonly Role[] }) {
  const auth = useAuth();
  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'anonymous') return <ToSignIn signedOut={auth.signedOut !== undefined} />;
  const allowed: readonly Role[] = typeof role === 'string' ? [role] : role;
  if (!allowed.includes(auth.user.role)) return <Navigate to="/" replace />;
  return <Outlet key={auth.user.id} />;
}

/**
 * Sign-in and similar screens. Once signed in, the user continues where the
 * guard stopped them, or goes home.
 */
export function GuestOnly() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'authenticated') {
    return <Navigate to={returnPath(location.state)} replace />;
  }
  return <Outlet />;
}

// The way back is remembered, except after a sign-out: whoever signs in next
// starts at home, not on the page the previous user left.
function ToSignIn({ signedOut }: { signedOut: boolean }) {
  const location = useLocation();
  const from = signedOut ? undefined : { from: location.pathname + location.search };
  return <Navigate to="/sign-in" replace state={from} />;
}
