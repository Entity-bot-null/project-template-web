import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

const TOKEN = /^#token=([A-Za-z0-9_-]{43})$/;

/**
 * The one-time token of an emailed link (`/page#token=...`), for the pages
 * those links open (docs/security.md#password-recovery-and-change). The token
 * travels after #, which a browser never sends to a server; it is read once,
 * then taken out of the address bar and the history at once (replace, not
 * push), so it is not left on screen, in a bookmark or for the back button.
 * It lives in the page's memory only, never in browser storage. `drop()`
 * forgets it once used or refused. Opening the page changes nothing: only
 * the page's form spends the token, so a mail scanner that fetches the link
 * does no harm. Null: no token, or not a well-formed one.
 */
export function useLinkToken(): [token: string | null, drop: () => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(() => TOKEN.exec(location.hash)?.[1] ?? null);

  useEffect(() => {
    if (location.hash !== '') {
      void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  const drop = useCallback(() => {
    setToken(null);
  }, []);
  return [token, drop];
}
