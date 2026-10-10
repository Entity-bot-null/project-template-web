// Tests of the tool image resolver (scripts/tool-image.mjs). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pullableImage, toolImage } from './tool-image.mjs';

const DIGEST = `@sha256:${'a'.repeat(64)}`;
const MIRROR = 'mirror.example';

/** @param {boolean} available what the mirror answers */
function mirrorWith(available) {
  /** @type {string[]} */
  const pulled = [];
  return {
    pulled,
    /** @param {string} reference */
    pull: (reference) => {
      pulled.push(reference);
      return available;
    },
  };
}

describe('pullableImage', () => {
  test('without a mirror, the pinned reference is used and nothing is pulled', () => {
    const { pull, pulled } = mirrorWith(true);
    const image = `semgrep/semgrep:1.0.0${DIGEST}`;
    assert.equal(pullableImage(image, { mirror: '', pull }), image);
    assert.deepEqual(pulled, []);
  });

  test('a Docker Hub image is pulled from the mirror by its digest, the tag dropped', () => {
    const { pull, pulled } = mirrorWith(true);
    const expected = `${MIRROR}/semgrep/semgrep${DIGEST}`;
    assert.equal(
      pullableImage(`semgrep/semgrep:1.0.0${DIGEST}`, { mirror: MIRROR, pull }),
      expected,
    );
    assert.deepEqual(pulled, [expected]);
  });

  test('an official image gets the library/ namespace, with or without docker.io', () => {
    const { pull } = mirrorWith(true);
    for (const image of [`postgres:18-alpine${DIGEST}`, `docker.io/library/postgres:18${DIGEST}`]) {
      assert.equal(
        pullableImage(image, { mirror: MIRROR, pull }),
        `${MIRROR}/library/postgres${DIGEST}`,
      );
    }
  });

  test('an image of another registry is used as pinned', () => {
    const { pull, pulled } = mirrorWith(true);
    for (const image of [
      `ghcr.io/zizmorcore/zizmor:1.0.0${DIGEST}`,
      `public.ecr.aws/docker/library/redis:8${DIGEST}`,
      `localhost:5000/tool:1${DIGEST}`,
    ]) {
      assert.equal(pullableImage(image, { mirror: MIRROR, pull }), image);
    }
    assert.deepEqual(pulled, []);
  });

  test('when the mirror does not have it, Docker Hub is used as before', () => {
    const { pull } = mirrorWith(false);
    const image = `rhysd/actionlint:1.7.0${DIGEST}`;
    assert.equal(pullableImage(image, { mirror: MIRROR, pull }), image);
  });

  test('every pinned tool image resolves to a reference with the same digest', () => {
    const { pull } = mirrorWith(true);
    const names = ['actionlint', 'zizmor', 'semgrep', 'gitleaks'];
    for (const name of names) {
      const image = toolImage(name);
      const digest = image.slice(image.indexOf('@'));
      assert.ok(pullableImage(image, { mirror: MIRROR, pull }).endsWith(digest), name);
    }
  });
});
