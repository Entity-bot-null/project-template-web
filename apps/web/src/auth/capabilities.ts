import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { call } from '../api/errors';

/** What this deployment offers (GET /api/auth/capabilities); null until known. */
export interface Capabilities {
  passwordReset: boolean;
  signUp: boolean;
}

let pending: Promise<Capabilities | null> | undefined;

// Asked once per page load: it only changes with a deployment. A failure
// counts as "nothing offered" (no link to a feature that may not work) and
// is forgotten, so the next screen that needs it asks again.
function load(): Promise<Capabilities | null> {
  pending ??= call(api.GET('/api/auth/capabilities')).then((result) => {
    if (result.ok) return result.data;
    pending = undefined;
    return null;
  });
  return pending;
}

/** What the deployment offers; null while unknown or when it could not be asked. */
export function useCapabilities(): Capabilities | null {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  useEffect(() => {
    let current = true;
    void load().then((value) => {
      if (current) setCapabilities(value);
    });
    return () => {
      current = false;
    };
  }, []);
  return capabilities;
}

export function resetCapabilitiesForTests(): void {
  pending = undefined;
}
