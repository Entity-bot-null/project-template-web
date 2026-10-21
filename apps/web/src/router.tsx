import { createRoutesFromElements, Route } from 'react-router';
import { GuestOnly, RequireAuth, RequireRole } from './auth';
import { AppLayout } from './components/AppLayout';
import { LoadingScreen } from './components/LoadingScreen';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { SignInPage } from './pages/SignInPage';

/** A build's base (`/app/`) as a router basename (`/app`); `/` stays `/`. */
export function basenameFrom(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') || '/';
}

/**
 * Where the app is served on the site's origin: the build's base (/app/ in
 * vite.config.ts; the specs run at /). Every route below is relative to it.
 */
export const BASENAME = basenameFrom(import.meta.env.BASE_URL);

// Every route, guarded as a layout route. Add a screen by placing its route
// under the guard it needs; the matching API routes need @Auth() as well, and
// its pattern goes in the API's Web Vitals pages (WEB_VITALS_ROUTES, in
// apps/api/src/telemetry/web-vitals.schemas.ts: webVitalsReporter.spec.ts
// fails until it is there). Screens few visits need are loaded when opened
// (lazy): the bundle every visit downloads stays within its budget
// (docs/testing.md#performance-budget).
export const routes = createRoutesFromElements(
  <Route errorElement={<RouteErrorPage />} hydrateFallbackElement={<LoadingScreen />}>
    <Route element={<GuestOnly />}>
      <Route path="sign-in" element={<SignInPage />} />
      <Route
        path="forgot-password"
        lazy={() =>
          import('./pages/ForgotPasswordPage').then(({ ForgotPasswordPage }) => ({
            Component: ForgotPasswordPage,
          }))
        }
      />
      <Route
        path="sign-up"
        lazy={() =>
          import('./pages/SignUpPage').then(({ SignUpPage }) => ({ Component: SignUpPage }))
        }
      />
    </Route>
    {/* Signed in or not: a person may open an emailed link in any state. */}
    <Route
      path="accept-invitation"
      lazy={() =>
        import('./pages/AcceptInvitationPage').then(({ AcceptInvitationPage }) => ({
          Component: AcceptInvitationPage,
        }))
      }
    />
    <Route
      path="confirm-email-change"
      lazy={() =>
        import('./pages/ConfirmEmailChangePage').then(({ ConfirmEmailChangePage }) => ({
          Component: ConfirmEmailChangePage,
        }))
      }
    />
    <Route
      path="revert-email-change"
      lazy={() =>
        import('./pages/RevertEmailChangePage').then(({ RevertEmailChangePage }) => ({
          Component: RevertEmailChangePage,
        }))
      }
    />
    <Route
      path="confirm-sign-up"
      lazy={() =>
        import('./pages/ConfirmSignUpPage').then(({ ConfirmSignUpPage }) => ({
          Component: ConfirmSignUpPage,
        }))
      }
    />
    <Route
      path="reset-password"
      lazy={() =>
        import('./pages/ResetPasswordPage').then(({ ResetPasswordPage }) => ({
          Component: ResetPasswordPage,
        }))
      }
    />
    <Route element={<RequireAuth />}>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route
          path="account"
          lazy={() =>
            import('./pages/AccountPage').then(({ AccountPage }) => ({ Component: AccountPage }))
          }
        />
        <Route element={<RequireRole role="admin" />}>
          <Route path="admin/users" element={<AdminUsersPage />} />
          <Route
            path="admin/invitations"
            lazy={() =>
              import('./pages/AdminInvitationsPage').then(({ AdminInvitationsPage }) => ({
                Component: AdminInvitationsPage,
              }))
            }
          />
        </Route>
      </Route>
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Route>,
);
