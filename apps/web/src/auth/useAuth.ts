import { useSyncExternalStore } from 'react';
import { getState, retrySignOut, signIn, signOut, subscribe } from './session';
import type { AuthState } from './types';

export type Auth = AuthState & {
  signIn: typeof signIn;
  signOut: typeof signOut;
  retrySignOut: typeof retrySignOut;
};

/** Reactive view of the session store: status, user and the actions. */
export function useAuth(): Auth {
  const state = useSyncExternalStore(subscribe, getState, getState);
  return { ...state, signIn, signOut, retrySignOut };
}
