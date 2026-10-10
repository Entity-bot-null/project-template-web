import { useState } from 'react';
import { describeFailure } from '../api/errors';
import { useAuth } from '../auth';
import { emailError, passwordError } from '../auth/validation';
import { Alert } from '../components/Alert';

interface FieldErrors {
  email: string | null;
  password: string | null;
}

// On success the session store switches to authenticated and GuestOnly
// sends the user on (back where they came from, or home).
export function SignInPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({ email: null, password: null });
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const next = { email: emailError(email), password: passwordError(password) };
    setErrors(next);
    if (next.email !== null || next.password !== null) return;

    setSubmitting(true);
    setFailure(null);
    // Never throws: every failure, an answer that is not a session included,
    // comes back as a result (session.ts), so the button always comes back.
    const result = await auth.signIn(email.trim(), password);
    if (!result.ok) {
      setSubmitting(false);
      setFailure(
        result.failure.status === 401
          ? 'Invalid email or password.'
          : describeFailure(result.failure),
      );
    }
  }

  return (
    <main className="auth-page">
      <h1>Sign in</h1>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {auth.status === 'anonymous' && auth.signedOut === 'failed' && (
          <Alert>
            You are signed out here, but the server could not be reached to end the session.{' '}
            <button type="button" onClick={() => void auth.retrySignOut()}>
              Retry sign-out
            </button>
          </Alert>
        )}
        {failure !== null && <Alert>{failure}</Alert>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            aria-invalid={errors.email !== null}
            aria-describedby={errors.email === null ? undefined : 'email-error'}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          {errors.email !== null && (
            <span id="email-error" className="field-error">
              {errors.email}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={errors.password !== null}
            aria-describedby={errors.password === null ? undefined : 'password-error'}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          {errors.password !== null && (
            <span id="password-error" className="field-error">
              {errors.password}
            </span>
          )}
        </div>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
