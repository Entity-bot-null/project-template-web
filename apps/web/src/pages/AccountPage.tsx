import { useState } from 'react';
import { api } from '../api/client';
import { call, describeFailure } from '../api/errors';
import { useAuth } from '../auth';
import { useCapabilities } from '../auth/capabilities';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { emailError } from '../auth/validation';
import { Alert } from '../components/Alert';
import { PasswordField } from '../components/PasswordField';
import { TextField } from '../components/TextField';

interface FieldErrors {
  current: string | null;
  next: string | null;
}

const NO_ERRORS: FieldErrors = { current: null, next: null };

// The signed-in person's own account: who they are, a new password
// (confirmed with the current one; every other session is signed out, this
// one carries on in the new session the API answers with), and, where email
// works, a new address (confirmed from that address).
export function AccountPage() {
  const auth = useAuth();
  const capabilities = useCapabilities();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  if (auth.status !== 'authenticated') return null;
  const { user } = auth;

  async function submit() {
    const found: FieldErrors = {
      current: current.length === 0 ? 'Enter your current password.' : null,
      next: newPasswordError(next, { email: user.email, name: user.name }),
    };
    setErrors(found);
    setChanged(false);
    if (found.current !== null || found.next !== null) return;
    setSubmitting(true);
    setFailure(null);
    // Stores the new session the API answers with (src/auth/session.ts).
    const result = await auth.changePassword(current, next);
    setSubmitting(false);
    if (result.ok) {
      setCurrent('');
      setNext('');
      setChanged(true);
      return;
    }
    const { status } = result.failure;
    if (status === 403) {
      setErrors({ ...NO_ERRORS, current: 'Your current password is not correct.' });
    } else if (status === 400) {
      setErrors({
        ...NO_ERRORS,
        next: 'Choose another password: this one is among the most used, or too easy to guess.',
      });
    } else if (status === 409) {
      setFailure('Your password was changed in another session meanwhile. Sign in again with it.');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  return (
    <section className="stack" aria-labelledby="account-heading">
      <h1 id="account-heading">Your account</h1>
      <dl className="account-details">
        <dt>Name</dt>
        <dd>{user.name}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
      </dl>
      <form
        className="stack auth-form"
        noValidate
        aria-labelledby="password-heading"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="password-heading">Change your password</h2>
        {changed && (
          <Alert tone="info">
            Your password was changed. Every other session of your account was signed out.
          </Alert>
        )}
        {failure !== null && <Alert>{failure}</Alert>}
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          error={errors.current}
        />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          error={errors.next}
          hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters, without your name or email.`}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Change password'}
        </button>
      </form>
      {capabilities?.emailChange === true && <ChangeEmailForm currentEmail={user.email} />}
    </section>
  );
}

// Asks to move the account to another address. Nothing changes here: a link
// goes to the new address, and the change happens when it is opened (then
// every session, this one included, is signed out). The answer is the same
// whether the new address has an account or not.
function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email: string | null; password: string | null }>({
    email: null,
    password: null,
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const address = newEmail.trim();
    const found = {
      email:
        emailError(address) ??
        (address.toLowerCase() === currentEmail ? 'This is already your address.' : null),
      password: password.length === 0 ? 'Enter your current password.' : null,
    };
    setErrors(found);
    setSentTo(null);
    if (found.email !== null || found.password !== null) return;
    setSubmitting(true);
    setFailure(null);
    const result = await call(
      api.POST('/api/account/email', { body: { newEmail: address, currentPassword: password } }),
    );
    setSubmitting(false);
    if (result.ok) {
      setNewEmail('');
      setPassword('');
      setSentTo(address);
      return;
    }
    const { status } = result.failure;
    if (status === 403) {
      setErrors({ email: null, password: 'Your current password is not correct.' });
    } else if (status === 400) {
      setErrors({ email: 'This is already your address.', password: null });
    } else if (status === 503) {
      setFailure('Changing the address is not available here.');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  return (
    <form
      className="stack auth-form"
      noValidate
      aria-labelledby="email-heading"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 id="email-heading">Change your email</h2>
      {sentTo !== null && (
        <Alert tone="info">
          A link is on its way to {sentTo}. Your address changes when you open it; until then
          nothing changes. Then every session is signed out: sign in with the new address.
        </Alert>
      )}
      {failure !== null && <Alert>{failure}</Alert>}
      <TextField
        label="New email"
        type="email"
        autoComplete="email"
        value={newEmail}
        onChange={setNewEmail}
        error={errors.email}
      />
      <PasswordField
        label="Current password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={errors.password}
      />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Change email'}
      </button>
    </form>
  );
}
