import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult } from '../api/errors';

export type LoadState<T> =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: T }
  | { kind: 'failed'; failure: ApiFailure; retrying: boolean };

type Key = string | number | null;

const LOADING: LoadState<never> = { kind: 'loading' };

/**
 * Runs `load` on mount and whenever `key` changes, and exposes the outcome
 * plus a `retry`. The latest `load` is kept in a ref, so an inline closure is
 * fine; pass what it closes over as `key` to reload when it changes. Every
 * request takes a number and only the latest may set state, so a response
 * that lands after unmount, after a key change or after a retry is dropped.
 * While retrying, the failed state stays (with `retrying`), so the retry
 * button keeps its place and keyboard focus.
 */
export function useLoader<T>(
  load: () => Promise<ApiResult<T>>,
  key: Key = null,
): { state: LoadState<T>; retry: () => Promise<boolean> } {
  const [stored, setStored] = useState<{ key: Key; value: LoadState<T> }>({
    key,
    value: LOADING,
  });
  const state = stored.key === key ? stored.value : LOADING;
  const requestId = useRef(0);
  const loadRef = useRef(load);
  const stateRef = useRef(state);

  // Fresh before paint, so a click on a just-painted retry button is never lost.
  useLayoutEffect(() => {
    loadRef.current = load;
    stateRef.current = state;
  });

  const run = useCallback(async (forKey: Key): Promise<boolean> => {
    const id = ++requestId.current;
    const result = await loadRef.current();
    if (id !== requestId.current) return false;
    setStored({
      key: forKey,
      value: result.ok
        ? { kind: 'loaded', data: result.data }
        : { kind: 'failed', failure: result.failure, retrying: false },
    });
    return result.ok;
  }, []);

  useEffect(() => {
    void run(key);
    return () => {
      requestId.current += 1;
    };
  }, [run, key]);

  const retry = useCallback((): Promise<boolean> => {
    const current = stateRef.current;
    if (current.kind !== 'failed' || current.retrying) return Promise.resolve(false);
    const next = { ...current, retrying: true };
    stateRef.current = next;
    setStored({ key, value: next });
    return run(key);
  }, [run, key]);

  return { state, retry };
}
