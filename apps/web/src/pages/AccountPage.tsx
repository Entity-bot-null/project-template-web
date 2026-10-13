import { useState } from 'react';
import { describeFailure } from '../api/errors';
import { useAuth } from '../auth';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { Alert } from '../components/Alert';
import { PasswordField } from '../components/PasswordField';

interface FieldErrors {
  current: string | null;
  next: string | null;
}

const NO_ERRORS: FieldErrors = { current: null, next: null };

// The signed-in person's own account: who they are, and a new password
// (confirmed with the current one). A change signs every other session out;
// this one carries on in the new session the API answers with.
export function AccountPage() {
  const auth = useAuth();
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
    </section>
  );
}
