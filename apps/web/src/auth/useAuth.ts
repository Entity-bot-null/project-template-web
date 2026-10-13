import { useSyncExternalStore } from 'react';
import {
  acceptInvitation,
  changePassword,
  confirmSignUp,
  getState,
  retrySignOut,
  signIn,
  signOut,
  subscribe,
} from './session';
import type { AuthState } from './types';

export type Auth = AuthState & {
  signIn: typeof signIn;
  signOut: typeof signOut;
  retrySignOut: typeof retrySignOut;
  changePassword: typeof changePassword;
  confirmSignUp: typeof confirmSignUp;
  acceptInvitation: typeof acceptInvitation;
};

/** Reactive view of the session store: status, user and the actions. */
export function useAuth(): Auth {
  const state = useSyncExternalStore(subscribe, getState, getState);
  return {
    ...state,
    signIn,
    signOut,
    retrySignOut,
    changePassword,
    confirmSignUp,
    acceptInvitation,
  };
}
