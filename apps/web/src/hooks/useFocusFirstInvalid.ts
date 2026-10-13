import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * After a submit that did not go through, moves the keyboard focus to the
 * form's first invalid field (aria-invalid), so a screen reader announces
 * the problem with it instead of nothing. Put `formRef` on the form and call
 * `focusInvalid()` once the submit has settled; a form left without invalid
 * fields (a general failure, shown in an alert) keeps its focus.
 */
export function useFocusFirstInvalid() {
  const formRef = useRef<HTMLFormElement>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);
  const focusInvalid = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);
  return { formRef, focusInvalid };
}
