import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="auth-page stack">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </main>
  );
}
