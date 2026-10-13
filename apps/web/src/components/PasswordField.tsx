import { useId, useState } from 'react';

// A password input with a button that shows or hides what was typed: people
// check a long passphrase before submitting it (NIST SP 800-63B-4 asks for
// the option). The button only changes how the field is shown, never its
// value or its checks; it is a real button, reachable with the keyboard,
// whose pressed state screen readers announce.
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error: string | null;
  hint?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const describedBy = [
    hint === undefined ? null : `${id}-hint`,
    error === null ? null : `${id}-error`,
  ]
    .filter((part) => part !== null)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          aria-invalid={error !== null}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        {/* The name starts with the visible word, as speech input expects. */}
        <button
          type="button"
          aria-pressed={visible}
          aria-controls={id}
          aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          onClick={() => {
            setVisible(!visible);
          }}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint !== undefined && (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      )}
      {error !== null && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}
