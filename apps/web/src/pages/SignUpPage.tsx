import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { call, describeFailure } from '../api/errors';
import { newPasswordError, PASSWORD_MIN_LENGTH } from '../auth/password-rules';
import { emailError } from '../auth/validation';
import { Alert } from '../components/Alert';
import { PasswordField } from '../components/PasswordField';

interface FieldErrors {
  name: string | null;
  email: string | null;
  password: string | null;
}

const NO_ERRORS: FieldErrors = { name: null, email: null, password: null };

// "Create an account". The API answers the same for every address, so the
// page does too: it never says whether the address already has an account
// (its owner gets a message saying so). The account exists once the emailed
// link is confirmed with this password.
export function SignUpPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit() {
    const found: FieldErrors = {
      name: name.trim().length === 0 ? 'Enter your name.' : null,
      email: emailError(email),
      password: newPasswordError(password, { email, name }),
    };
    setErrors(found);
    if (found.name !== null || found.email !== null || found.password !== null) return;
    setSubmitting(true);
    setFailure(null);
    const address = email.trim();
    const result = await call(
      api.POST('/api/auth/sign-ups', { body: { name: name.trim(), email: address, password } }),
    );
    setSubmitting(false);
    if (result.ok) {
      setPassword('');
      setSentTo(address);
      return;
    }
    const { status } = result.failure;
    if (status === 400) {
      setErrors({
        ...NO_ERRORS,
        password: 'Choose another password: this one is among the most used, or too easy to guess.',
      });
    } else if (status === 403) {
      setFailure('Sign-up is closed here. Ask your administrator for an account.');
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  if (sentTo !== null) {
    return (
      <main className="auth-page stack">
        <h1>Check your email</h1>
        <Alert tone="info">
          A message is on its way to {sentTo}. Open its link and enter the password you just chose
          to finish creating your account; the link works for 24 hours.
        </Alert>
        <p>
          If this address already has an account, the message says so instead. Nothing after a few
          minutes? Look in your spam folder, or{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSentTo(null);
            }}
          >
            try again
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
      <h1>Create an account</h1>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {failure !== null && <Alert>{failure}</Alert>}
        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            name="name"
            autoComplete="name"
            maxLength={100}
            value={name}
            aria-invalid={errors.name !== null}
            aria-describedby={errors.name === null ? undefined : 'name-error'}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {errors.name !== null && (
            <span id="name-error" className="field-error">
              {errors.name}
            </span>
          )}
        </div>
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
        <PasswordField
          label="Password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters. A few words you can remember work well.`}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Create my account'}
        </button>
        <p>
          Already have an account? <Link to="/sign-in">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
