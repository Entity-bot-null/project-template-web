import { describe, expect, it } from 'vitest';
import { failure, json, ok } from '../test/http';
import {
  call,
  describeFailure,
  failureOf,
  NETWORK_ERROR_MESSAGE,
  NOT_AN_ENVELOPE_MESSAGE,
} from './errors';

const outcome = (response: Response, body?: unknown) =>
  Promise.resolve(
    response.ok
      ? { data: body as { data?: unknown; message: string }, response }
      : { error: body, response },
  );

describe('call', () => {
  it('unwraps the data of a successful envelope', async () => {
    const response = ok({ id: 1 });
    await expect(call(outcome(response, await response.clone().json()))).resolves.toEqual({
      ok: true,
      data: { id: 1 },
    });
  });

  it('folds a bodyless success to null', async () => {
    await expect(call(outcome(new Response(null, { status: 204 })))).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  it('fails a success answer that is not the envelope: not the API answering', async () => {
    // A proxy, a captive portal or a deploy in progress can answer 2xx with
    // something else; its body must never reach a screen as data.
    const notAnEnvelope = { ok: false, failure: { status: 502, message: NOT_AN_ENVELOPE_MESSAGE } };
    for (const body of [
      {},
      [],
      'ok',
      42,
      { data: { id: 1 } },
      { message: 'ok' },
      { data: null, message: 1 },
    ]) {
      await expect(call(outcome(json(200, body), body)), JSON.stringify(body)).resolves.toEqual(
        notAnEnvelope,
      );
    }
    // 200 with an empty body: openapi-fetch reads no data.
    await expect(
      call(outcome(new Response('', { status: 200, headers: { 'Content-Length': '0' } }))),
    ).resolves.toEqual(notAnEnvelope);
    await expect(call(outcome(json(201, null), null))).resolves.toEqual(notAnEnvelope);
  });

  it('accepts an envelope whose data is null', async () => {
    await expect(call(outcome(ok(null), { data: null, message: 'Done' }))).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  it('keeps the status and server message of an error envelope', async () => {
    const response = failure(409, 'Already exists');
    await expect(
      call(outcome(response, { data: null, message: 'Already exists' })),
    ).resolves.toEqual({ ok: false, failure: { status: 409, message: 'Already exists' } });
  });

  it('turns a network error into status 0', async () => {
    await expect(call(Promise.reject(new TypeError('Failed to fetch')))).resolves.toEqual({
      ok: false,
      failure: { status: 0, message: NETWORK_ERROR_MESSAGE },
    });
  });
});

describe('failureOf', () => {
  it('reads Retry-After on a 429', () => {
    expect(failureOf(json(429, {}, { 'Retry-After': '12' }), undefined)).toEqual({
      status: 429,
      message: 'HTTP 429',
      retryAfterSec: 12,
    });
    expect(failureOf(json(429, {}, { 'Retry-After': 'soon' }), undefined).retryAfterSec).toBe(
      undefined,
    );
  });
});

describe('describeFailure', () => {
  it('gives users a message by status, never the raw server text', () => {
    expect(describeFailure({ status: 0, message: 'x' })).toBe(NETWORK_ERROR_MESSAGE);
    expect(describeFailure({ status: 403, message: 'Not allowed for this role' })).toBe(
      'You do not have access to this.',
    );
    expect(describeFailure({ status: 429, message: 'x', retryAfterSec: 30 })).toContain(
      '30 seconds',
    );
    expect(describeFailure({ status: 503, message: 'Database unreachable' })).toBe(
      'The service is unavailable. Try again later.',
    );
    expect(describeFailure({ status: 418, message: 'x' })).toBe('Something went wrong (418).');
  });
});
