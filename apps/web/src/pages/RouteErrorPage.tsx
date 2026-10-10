import { useEffect } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { reportError } from '../monitoring/errorTracking';

// The last line of defense for errors thrown while rendering a route. The
// detail goes to the console and to the error tracker when the deployment has
// one (docs/observability.md#error-tracking); the user gets a way out, never a
// stack trace. A 404 is a wrong link, not a bug: not reported.
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  useEffect(() => {
    console.error('Unhandled route error', error);
    if (!notFound) reportError(error, { source: 'route' });
  }, [error, notFound]);
  const title = notFound ? 'Page not found' : 'Something went wrong';
  return (
    <main className="auth-page stack">
      <h1>{title}</h1>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </main>
  );
}
