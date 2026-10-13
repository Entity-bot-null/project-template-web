import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { describeFailure, failedField } from '../api/errors';
import { useAuth } from '../auth';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { type LinkToken, useLinkToken } from '../auth/useLinkToken';
import { Alert } from '../components/Alert';
import { FocusHeading } from '../components/FocusHeading';
import { PasswordField } from '../components/PasswordField';
import { TextField } from '../components/TextField';
import { useFocusFirstInvalid } from '../hooks/useFocusFirstInvalid';

type Outcome = 'invalid-link' | 'exists' | null;

// Accepts an invitation with the link of its message: the person chooses
// their name and password, the account is created with the role the
// administrator chose, and signed in. The token is handled by useLinkToken
// (out of the address bar and the history at once, in memory only); only
// the form's submit spends it.
export function AcceptInvitationPage() {
  // Keyed by the link: a second link opened in this tab starts the page over.
  const { linkId, ...link } = useLinkToken();
  return <AcceptInvitationContent key={linkId} {...link} />;
}

function AcceptInvitationContent({ token, dropToken }: LinkToken) {
  const { formRef, focusInvalid } = useFocusFirstInvalid();
  const auth = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name: string | null; password: string | null }>({
    name: null,
    password: null,
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function submit(currentToken: string) {
    const found = {
      name: name.trim().length === 0 ? 'Enter your name.' : null,
      password: newPasswordError(password, { name }),
    };
    setErrors(found);
    if (found.name !== null || found.password !== null) return;
    setSubmitting(true);
    setFailure(null);
    const result = await auth.acceptInvitation(currentToken, name.trim(), password);
    setSubmitting(false);
    if (result.ok) {
      dropToken();
      setPassword('');
      void navigate('/', { replace: true });
      return;
    }
    const { status } = result.failure;
    const field = failedField(result.failure);
    if (field === 'password') {
      setErrors({
        name: null,
        password: 'Choose another password: this one is among the most used, or too easy to guess.',
      });
    } else if (field === 'name') {
      setErrors({ name: 'Enter your name (up to 100 characters).', password: null });
    } else if (status === 404 || status === 409) {
      dropToken();
      setOutcome(status === 404 ? 'invalid-link' : 'exists');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  if (outcome === 'exists') {
    return (
      <main className="auth-page stack">
        <FocusHeading>You already have an account</FocusHeading>
        <Alert tone="info">An account with this address exists: sign in with it.</Alert>
        <p>
          <Link to="/sign-in">Sign in</Link>
        </p>
      </main>
    );
  }

  if (token === null) {
    return (
      <main className="auth-page stack">
        <FocusHeading>This invitation does not work</FocusHeading>
        <Alert>
          {outcome === 'invalid-link'
            ? 'This invitation was already used, has expired, or was revoked or replaced. Ask the person who invited you for a new one.'
            : 'This link is incomplete. Open the whole link from the message.'}
        </Alert>
        <p>
          <Link to="/sign-in">Go to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Accept your invitation</h1>
      <form
        ref={formRef}
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(token).then(focusInvalid);
        }}
      >
        <p>Choose your name and a password to create your account.</p>
        {failure !== null && <Alert>{failure}</Alert>}
        <TextField
          label="Name"
          name="name"
          autoComplete="name"
          maxLength={100}
          value={name}
          onChange={setName}
          error={errors.name}
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters. A few words you can remember work well.`}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create my account'}
        </button>
      </form>
    </main>
  );
}
