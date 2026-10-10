import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { jsonOnly } from './json-only.middleware.js';

function run(method: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const contentType = lower['content-type'];
  const req = {
    method,
    get: (name: string) => lower[name.toLowerCase()],
    // Express answers false when the type does not match.
    is: (type: string) => (contentType?.split(';')[0]?.trim() === type ? type : false),
  } as unknown as Request;
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const next = vi.fn<() => void>();
  jsonOnly(req, res as unknown as Response, next);
  return { res, next };
}

describe('jsonOnly', () => {
  it('lets JSON bodies through, with or without parameters', () => {
    expect(
      run('POST', { 'Content-Type': 'application/json', 'Content-Length': '2' }).next,
    ).toHaveBeenCalledOnce();
    expect(
      run('PATCH', { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': '2' })
        .next,
    ).toHaveBeenCalledOnce();
  });

  it('lets requests without a body through', () => {
    expect(run('GET').next).toHaveBeenCalledOnce();
    expect(run('POST', { 'Content-Length': '0' }).next).toHaveBeenCalledOnce();
    expect(run('DELETE').next).toHaveBeenCalledOnce();
  });

  it('refuses form and text bodies with 415 and the error envelope', () => {
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
    ]) {
      const { res, next } = run('POST', { 'Content-Type': type, 'Content-Length': '10' });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(415);
      expect(res.json).toHaveBeenCalledWith({
        data: null,
        message: 'Request bodies must be application/json',
      });
    }
  });

  it('treats a chunked body like any other', () => {
    const { res } = run('PUT', { 'Transfer-Encoding': 'chunked', 'Content-Type': 'text/plain' });
    expect(res.status).toHaveBeenCalledWith(415);
  });

  it('refuses a form even without a body: a bodiless form POST must not reach a handler', () => {
    const forms: Record<string, string>[] = [
      { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '0' },
      { 'Content-Type': 'text/plain;charset=UTF-8' },
      { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': '0' },
    ];
    for (const headers of forms) {
      const { res, next } = run('POST', headers);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(415);
    }
  });
});
