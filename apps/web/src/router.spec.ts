import { describe, expect, it } from 'vitest';
import { basenameFrom } from './router';

describe('basenameFrom', () => {
  it("turns the build's base into the router's basename", () => {
    expect(basenameFrom('/app/')).toBe('/app');
    expect(basenameFrom('/')).toBe('/');
  });
});
