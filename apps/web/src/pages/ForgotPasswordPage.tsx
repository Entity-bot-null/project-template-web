import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { call, describeFailure } from '../api/errors';
import { emailError } from '../auth/validation';
import { Alert } from '../components/Alert';
import { TextField } from '../components/TextField';

// Asks for a reset link. The API answers the same for every address, so the
// page does too: it never says whether an account exists.
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit() {
    const problem = emailError(email);
    setError(problem);
    if (problem !== null) return;
    setSubmitting(true);
    setFailure(null);
    const address = email.trim();
    const result = await call(api.POST('/api/auth/password-resets', { body: { email: address } }));
    setSubmitting(false);
    if (result.ok) {
      setSentTo(address);
      return;
    }
    setFailure(
      result.failure.status === 503
        ? 'Password recovery is not available here. Ask your administrator for help.'
        : describeFailure(result.failure),
    );
  }

  if (sentTo !== null) {
    return (
      <main className="auth-page stack">
        <h1>Check your email</h1>
        <Alert tone="info">
          If an account exists for {sentTo}, a message with a link to choose a new password is on
          its way. The link works once, for 30 minutes.
        </Alert>
        <p>
          Nothing after a few minutes? Look in your spam folder, or{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSentTo(null);
            }}
          >
            ask again
          </button>
          .
        </p>
        <p>
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Forgot your password?</h1>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>
          Enter the email address of your account: we will send you a link to choose a new password.
        </p>
        {failure !== null && <Alert>{failure}</Alert>}
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          error={error}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send the link'}
        </button>
        <p>
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      </form>
    </main>
  );
}
