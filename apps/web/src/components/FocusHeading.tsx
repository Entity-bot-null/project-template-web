import { type ReactNode, useEffect, useRef } from 'react';

/**
 * The heading of a view that replaces another one after an action (a
 * confirmation, a link that does not work): it takes the keyboard focus when
 * it appears, so a screen reader reads where the person is now instead of
 * leaving them on a button that is gone.
 */
export function FocusHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}
