import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { PasswordField } from './PasswordField';

function Field({ error = null, hint }: { error?: string | null; hint?: string }) {
  const [value, setValue] = useState('');
  return (
    <PasswordField
      label="New password"
      autoComplete="new-password"
      value={value}
      onChange={setValue}
      error={error}
      hint={hint}
    />
  );
}

describe('PasswordField', () => {
  it('hides what is typed until asked, and hides it again, keeping the value', async () => {
    render(<Field />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('New password');
    await user.type(input, 'violet harbour');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');

    const toggle = screen.getByRole('button', { name: 'Show new password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-controls', input.id);
    await user.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('violet harbour');
    expect(screen.getByRole('button', { name: 'Hide new password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // From the keyboard too: it is a real button.
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(input).toHaveAttribute('type', 'password');
  });

  it('describes the field with its hint and its error', () => {
    render(<Field hint="At least 15 characters." error="Use at least 15 characters (3 now)." />);
    const input = screen.getByLabelText('New password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'At least 15 characters. Use at least 15 characters (3 now).',
    );
  });

  it('is described by nothing when there is nothing to say', () => {
    render(<Field />);
    const input = screen.getByLabelText('New password');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).not.toHaveAttribute('aria-describedby');
  });
});
