import { createRoutesFromElements, Route } from 'react-router';
import { GuestOnly, RequireAuth, RequireRole } from './auth';
import { AppLayout } from './components/AppLayout';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { SignInPage } from './pages/SignInPage';

// Every route, guarded as a layout route. Add a screen by placing its route
// under the guard it needs; the matching API routes need @Auth() as well.
export const routes = createRoutesFromElements(
  <Route errorElement={<RouteErrorPage />}>
    <Route element={<GuestOnly />}>
      <Route path="sign-in" element={<SignInPage />} />
    </Route>
    <Route element={<RequireAuth />}>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route element={<RequireRole role="admin" />}>
          <Route path="admin/users" element={<AdminUsersPage />} />
        </Route>
      </Route>
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Route>,
);
