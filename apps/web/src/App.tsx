import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { boot } from './auth';
import { routes } from './router';

const router = createBrowserRouter(routes);

// One refresh per page load restores the session from the httpOnly cookie;
// the guards show a loading screen until it settles. boot() is idempotent,
// so StrictMode's double effect costs nothing.
export function App() {
  useEffect(() => {
    void boot();
  }, []);
  return <RouterProvider router={router} />;
}
