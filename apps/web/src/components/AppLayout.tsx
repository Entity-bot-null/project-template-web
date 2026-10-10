import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth';

/** The frame of every signed-in screen. Links are shown by role; the API enforces it. */
export function AppLayout() {
  const auth = useAuth();
  if (auth.status !== 'authenticated') return null;
  return (
    <div className="layout">
      <header className="layout-header">
        <nav aria-label="Main">
          <NavLink to="/" end>
            Home
          </NavLink>
          {auth.user.role === 'admin' && <NavLink to="/admin/users">Users</NavLink>}
        </nav>
        <div className="layout-account">
          <span>{auth.user.email}</span>
          <button type="button" onClick={() => void auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}
