import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHARE_IMAGE } from './site';

// The width and height of a PNG, from its IHDR chunk (the first one).
function pngSize(file: Buffer) {
  expect(file.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(file.toString('latin1', 12, 16)).toBe('IHDR');
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

describe('SHARE_IMAGE', () => {
  it('is the PNG in public/, at the size the pages declare', () => {
    const file = readFileSync(new URL(`../../public${SHARE_IMAGE.path}`, import.meta.url));
    expect(pngSize(file)).toEqual({ width: SHARE_IMAGE.width, height: SHARE_IMAGE.height });
  });

  it('has the shape and size social networks expect for a large picture (1.91:1)', () => {
    expect(Math.abs(SHARE_IMAGE.width / SHARE_IMAGE.height - 1.91)).toBeLessThan(0.01);
    expect(SHARE_IMAGE.width).toBeGreaterThanOrEqual(1200);
  });
});
