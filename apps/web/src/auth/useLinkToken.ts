import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

const TOKEN = /^#token=([A-Za-z0-9_-]{43})$/;

const read = (hash: string): string | null => TOKEN.exec(hash)?.[1] ?? null;

/** What a page an emailed link opens gets from useLinkToken. */
export interface LinkToken {
  /** The link's token; null when there is none, or it was used or refused. */
  token: string | null;
  /** Forgets the token once used or refused. */
  dropToken: () => void;
}

/**
 * The one-time token of an emailed link (`/page#token=...`), for the pages
 * those links open (docs/security.md#password-recovery-and-change). The token
 * travels after #, which a browser never sends to a server; it is read, then
 * taken out of the address bar and the history at once (replace, not push),
 * so it is not left on screen, in a bookmark or for the back button. It lives
 * in the page's memory only, never in browser storage, and is dropped once
 * used. Opening the page changes nothing: only the page's form spends the
 * token, so a mail scanner that fetches the link does no harm.
 *
 * A second link opened in the same tab changes only the part after #, so the
 * page stays mounted: its token replaces the first one, and `linkId` changes,
 * for the page to start over (as a React key on its content).
 */
export function useLinkToken(): LinkToken & { linkId: number } {
  const location = useLocation();
  const navigate = useNavigate();
  const [link, setLink] = useState(() => ({
    key: location.key,
    token: read(location.hash),
    id: 0,
  }));
  // Adjusted while rendering, as React recommends for state that follows a
  // change: a navigation that brings a # part is a link opened again.
  if (location.hash !== '' && location.key !== link.key) {
    setLink({ key: location.key, token: read(location.hash), id: link.id + 1 });
  }

  useEffect(() => {
    if (location.hash !== '') {
      void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  const dropToken = useCallback(() => {
    setLink((current) => ({ ...current, token: null }));
  }, []);
  return { token: link.token, dropToken, linkId: link.id };
}
