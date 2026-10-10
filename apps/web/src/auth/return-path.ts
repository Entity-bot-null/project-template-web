/**
 * Where to go after signing in: the path a guard recorded in the navigation
 * state, if it is a path inside this app. The value never comes from the URL,
 * and is checked anyway, so sign-in cannot become an open redirect.
 */
export function returnPath(state: unknown): string {
  const from =
    typeof state === 'object' && state !== null && 'from' in state ? state.from : undefined;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}
