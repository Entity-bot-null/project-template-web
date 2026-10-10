import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/errors';
import { deferred } from '../test/http';
import { useLoader } from './useLoader';

const okResult = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const failed: ApiResult<never> = { ok: false, failure: { status: 503, message: 'down' } };

describe('useLoader', () => {
  it('loads on mount', async () => {
    const { result } = renderHook(() => useLoader(() => Promise.resolve(okResult(1))));
    expect(result.current.state).toEqual({ kind: 'loading' });
    await waitFor(() => {
      expect(result.current.state).toEqual({ kind: 'loaded', data: 1 });
    });
  });

  it('retries a failure and keeps the failed state visible meanwhile', async () => {
    const load = vi.fn<() => Promise<ApiResult<number>>>().mockResolvedValueOnce(failed);
    const { result } = renderHook(() => useLoader(load));
    await waitFor(() => {
      expect(result.current.state.kind).toBe('failed');
    });

    const gate = deferred<ApiResult<number>>();
    load.mockReturnValueOnce(gate.promise);
    let retried!: Promise<boolean>;
    act(() => {
      retried = result.current.retry();
    });
    expect(result.current.state).toMatchObject({ kind: 'failed', retrying: true });

    gate.resolve(okResult(2));
    await act(async () => {
      await expect(retried).resolves.toBe(true);
    });
    expect(result.current.state).toEqual({ kind: 'loaded', data: 2 });
  });

  it('drops a stale response when the key changes', async () => {
    const slow = deferred<ApiResult<string>>();
    const load = vi.fn((key: string) =>
      key === 'a' ? slow.promise : Promise.resolve(okResult('b')),
    );
    const { result, rerender } = renderHook(({ k }) => useLoader(() => load(k), k), {
      initialProps: { k: 'a' },
    });
    rerender({ k: 'b' });
    await waitFor(() => {
      expect(result.current.state).toEqual({ kind: 'loaded', data: 'b' });
    });

    await act(async () => {
      slow.resolve(okResult('a'));
      await slow.promise;
    });
    expect(result.current.state).toEqual({ kind: 'loaded', data: 'b' });
  });
});
