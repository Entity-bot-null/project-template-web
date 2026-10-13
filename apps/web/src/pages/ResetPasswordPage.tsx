import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { call, describeFailure } from '../api/errors';
import { useAuth } from '../auth';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { useLinkToken } from '../auth/useLinkToken';
import { Alert } from '../components/Alert';
import { PasswordField } from '../components/PasswordField';

type Outcome = 'changed' | 'invalid-link' | null;

// Chooses a new password with the link of a reset message. The token is
// handled by useLinkToken: out of the address bar and the history at once,
// in memory only, dropped once used; opening the link changes nothing.
export function ResetPasswordPage() {
  const auth = useAuth();
  const [token, dropToken] = useLinkToken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

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
      dropToken();
      setPassword('');
      setOutcome('changed');
      // Every session of the account ended on the server. This browser's
      // may be one of them, or another account's (a shared computer): it
      // signs out either way rather than guess.
      if (auth.status === 'authenticated') void auth.signOut();
      return;
    }
    if (result.failure.status === 404) {
      dropToken();
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
