import { useAuth } from '../auth';

export function HomePage() {
  const auth = useAuth();
  if (auth.status !== 'authenticated') return null;
  return (
    <section className="stack">
      <h1>Welcome, {auth.user.name}</h1>
      <p>
        Signed in as <strong>{auth.user.email}</strong> ({auth.user.role}).
      </p>
    </section>
  );
}
