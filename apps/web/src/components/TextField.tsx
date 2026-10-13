import { useId } from 'react';

// A labelled text input with its error, wired the same way on every form: the
// label names the input, aria-invalid marks it, and the error describes it,
// so screen readers announce the problem with the field.
export function TextField({
  label,
  value,
  onChange,
  error,
  type = 'text',
  name,
  autoComplete,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  type?: 'text' | 'email';
  name?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        name={name}
        autoComplete={autoComplete}
        maxLength={maxLength}
        value={value}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error !== null && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}
