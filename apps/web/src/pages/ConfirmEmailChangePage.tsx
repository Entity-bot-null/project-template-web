import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { call, describeFailure } from '../api/errors';
import { useAuth } from '../auth';
import { getState } from '../auth/session';
import { type LinkToken, useLinkToken } from '../auth/useLinkToken';
import { Alert } from '../components/Alert';
import { FocusHeading } from '../components/FocusHeading';

type Outcome = 'changed' | 'invalid-link' | 'taken' | null;

// Confirms a new address with the link sent to it. The token is handled by
// useLinkToken (out of the address bar and the history at once, in memory
// only). Opening the link changes nothing: the button does, so a mail
// scanner that fetches the link does no harm.
export function ConfirmEmailChangePage() {
  // Keyed by the link: a second link opened in this tab starts the page over.
  const { linkId, ...link } = useLinkToken();
  return <ConfirmEmailChangeContent key={linkId} {...link} />;
}

function ConfirmEmailChangeContent({ token, dropToken }: LinkToken) {
  const auth = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function submit(currentToken: string) {
    setSubmitting(true);
    setFailure(null);
    const result = await call(
      api.POST('/api/auth/email-changes/confirm', { body: { token: currentToken } }),
    );
    setSubmitting(false);
    if (result.ok) {
      dropToken();
      setOutcome('changed');
      // Every session of the account ended on the server; this browser's
      // may be one of them, or another account's: it signs out either way.
      // The store's state now, not this render's: a boot refresh may have
      // signed this tab in while the request was on its way, or may still be
      // on its way (signing out now keeps it from landing).
      if (getState().status !== 'anonymous') void auth.signOut();
      return;
    }
    const { status } = result.failure;
    if (status === 404 || status === 409) {
      dropToken();
      setOutcome(status === 404 ? 'invalid-link' : 'taken');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  if (outcome === 'changed') {
    return (
      <main className="auth-page stack">
        <FocusHeading>Email address changed</FocusHeading>
        <Alert tone="info">
          Your account now uses this address, and every session of it was signed out.
        </Alert>
        <p>
          <Link to="/sign-in">Sign in with your new address</Link>
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
            ? 'This address is now used by another account: your address was not changed.'
            : outcome === 'invalid-link'
              ? 'This link was already used, has expired, or was replaced by a newer one. Your address was not changed.'
              : 'This link is incomplete. Open the whole link from the message.'}
        </Alert>
        <p>
          <Link to="/account">Back to your account</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Confirm your new address</h1>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(token);
        }}
      >
        <p>
          Use this address for your account from now on. Every session of the account will be signed
          out: sign in again with this address.
        </p>
        {failure !== null && <Alert>{failure}</Alert>}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Confirming…' : 'Use this address'}
        </button>
      </form>
    </main>
  );
}
