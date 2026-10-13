import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { call, describeFailure } from '../api/errors';
import { useAuth } from '../auth';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { Alert } from '../components/Alert';
import { PasswordField } from '../components/PasswordField';

const TOKEN = /^#token=([A-Za-z0-9_-]{43})$/;

type Outcome = 'changed' | 'invalid-link' | null;

// Chooses a new password with the link of a reset message. The token arrives
// after # (a browser never sends that part to a server), is read once, then
// taken out of the address bar and the history at once, so it is not left
// on screen, in a bookmark or for the back button. It lives in this page's
// memory only (never in browser storage) and is dropped once used. Opening
// the link changes nothing: only the form's submit spends it, so a mail
// client or a scanner that fetches the link does no harm.
export function ResetPasswordPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(() => TOKEN.exec(location.hash)?.[1] ?? null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    if (location.hash !== '') {
      void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  async function submit(currentToken: string) {
    const problem = newPasswordError(password);
    setError(problem);
    if (problem !== null) return;
    setSubmitting(true);
    setFailure(null);
    const result = await call(
      api.POST('/api/auth/password-resets/confirm', { body: { token: currentToken, password } }),
    );
    setSubmitting(false);
    if (result.ok) {
      setToken(null);
      setPassword('');
      setOutcome('changed');
      // Every session of the account ended on the server. This browser's
      // may be one of them, or another account's (a shared computer): it
      // signs out either way rather than guess.
      if (auth.status === 'authenticated') void auth.signOut();
      return;
    }
    if (result.failure.status === 404) {
      setToken(null);
      setOutcome('invalid-link');
    } else if (result.failure.status === 400) {
      setError('Choose another password: this one is among the most used, or too easy to guess.');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  if (outcome === 'changed') {
    return (
      <main className="auth-page stack">
        <h1>Password changed</h1>
        <Alert tone="info">
          Your password was changed, and every session of your account was signed out.
        </Alert>
        <p>
          <Link to="/sign-in">Sign in with your new password</Link>
        </p>
      </main>
    );
  }

  if (token === null) {
    return (
      <main className="auth-page stack">
        <h1>This link does not work</h1>
        <Alert>
          {outcome === 'invalid-link'
            ? 'This link was already used, has expired, or was replaced by a newer one.'
            : 'This link is incomplete. Open the whole link from the message, or ask for a new one.'}
        </Alert>
        <p>
          <Link to="/forgot-password">Ask for a new link</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Choose a new password</h1>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(token);
        }}
      >
        {failure !== null && <Alert>{failure}</Alert>}
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={error}
          hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters. A few words you can remember work well.`}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save the new password'}
        </button>
      </form>
    </main>
  );
}
