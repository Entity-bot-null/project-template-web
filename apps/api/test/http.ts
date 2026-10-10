import type request from 'supertest';

export interface Envelope<T> {
  data: T;
  message: string;
}

/**
 * The JSON body of a response, typed as the API envelope. supertest parses
 * bodies as `any`; this names the expected shape, and the assertions on it
 * do the checking.
 */
export function envelopeOf<T = unknown>(res: request.Response): Envelope<T> {
  return res.body as Envelope<T>;
}
