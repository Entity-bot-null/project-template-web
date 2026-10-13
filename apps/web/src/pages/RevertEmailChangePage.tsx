import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { call, describeFailure, failedField } from '../api/errors';
import { useAuth } from '../auth';
import { getState } from '../auth/session';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { type LinkToken, useLinkToken } from '../auth/useLinkToken';
import { Alert } from '../components/Alert';
import { FocusHeading } from '../components/FocusHeading';
import { PasswordField } from '../components/PasswordField';
import { useFocusFirstInvalid } from '../hooks/useFocusFirstInvalid';

type Outcome = 'reverted' | 'invalid-link' | 'taken' | null;

// Undoes a change of address with the link sent to the previous one: that
// address comes back with a new password, chosen here (whoever changed the
// address knew the old one), and every session of the account ends. The
// token is handled by useLinkToken; only the form's submit spends it.
export function RevertEmailChangePage() {
  // Keyed by the link: a second link opened in this tab starts the page over.
  const { linkId, ...link } = useLinkToken();
  return <RevertEmailChangeContent key={linkId} {...link} />;
}

function RevertEmailChangeContent({ token, dropToken }: LinkToken) {
  const { formRef, focusInvalid } = useFocusFirstInvalid();
  const auth = useAuth();
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
      api.POST('/api/auth/email-changes/revert', { body: { token: currentToken, password } }),
    );
    setSubmitting(false);
    if (result.ok) {
      dropToken();
      setPassword('');
      setOutcome('reverted');
      // The store's state now, not this render's: a boot refresh may have
      // signed this tab in while the request was on its way.
      if (getState().status === 'authenticated') void auth.signOut();
      return;
    }
    const { status } = result.failure;
    if (failedField(result.failure) === 'password') {
      setError('Choose another password: this one is among the most used, or too easy to guess.');
    } else if (status === 404 || status === 409) {
      dropToken();
      setOutcome(status === 404 ? 'invalid-link' : 'taken');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  if (outcome === 'reverted') {
    return (
      <main className="auth-page stack">
        <FocusHeading>Your address is back</FocusHeading>
        <Alert tone="info">
          Your account uses this address again, with the password you just chose. Every session of
          it was signed out.
        </Alert>
        <p>
          <Link to="/sign-in">Sign in</Link>
        </p>
      </main>
    );
  }

  if (token === null) {
    return (
      <main className="auth-page stack">
        <FocusHeading>This link does not work</FocusHeading>
        <Alert>
          {outcome === 'taken'
            ? 'This address now belongs to another account, so it cannot come back. Ask your administrator for help.'
            : outcome === 'invalid-link'
              ? 'This link was already used or has expired. If your account was taken, ask your administrator for help.'
              : 'This link is incomplete. Open the whole link from the message.'}
        </Alert>
        <p>
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Undo the change of address</h1>
      <form
        ref={formRef}
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(token).then(focusInvalid);
        }}
      >
        <p>
          Your account comes back to this address. Choose a new password: whoever changed the
          address may know the old one. Every session of the account will be signed out.
        </p>
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
          {submitting ? 'Saving…' : 'Undo the change'}
        </button>
      </form>
    </main>
  );
}
