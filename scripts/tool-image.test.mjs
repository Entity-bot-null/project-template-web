// Tests of the tool image resolver (scripts/tool-image.mjs). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildContexts, ensureImage, pullableImage, toolImage } from './tool-image.mjs';

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

  test('an ECR Public image is pulled from the mirror under its Docker Hub name', () => {
    const { pull, pulled } = mirrorWith(true);
    assert.equal(
      pullableImage(`public.ecr.aws/docker/library/redis:8${DIGEST}`, { mirror: MIRROR, pull }),
      `${MIRROR}/library/redis${DIGEST}`,
    );
    assert.equal(
      pullableImage(`public.ecr.aws/hashicorp/terraform:1.0.0${DIGEST}`, { mirror: MIRROR, pull }),
      `${MIRROR}/hashicorp/terraform${DIGEST}`,
    );
    assert.deepEqual(pulled, [
      `${MIRROR}/library/redis${DIGEST}`,
      `${MIRROR}/hashicorp/terraform${DIGEST}`,
    ]);
  });

  test('when the mirror does not have an ECR Public image, ECR Public is used as before', () => {
    const { pull } = mirrorWith(false);
    const image = `public.ecr.aws/docker/library/postgres:18-alpine${DIGEST}`;
    assert.equal(pullableImage(image, { mirror: MIRROR, pull }), image);
  });

  test('an image of another registry is used as pinned', () => {
    const { pull, pulled } = mirrorWith(true);
    for (const image of [
      `ghcr.io/zizmorcore/zizmor:1.0.0${DIGEST}`,
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
    const names = [
      'actionlint',
      'zizmor',
      'semgrep',
      'gitleaks',
      'terraform',
      'ubuntu',
      'postgres',
      'redis',
      'mailpit',
    ];
    for (const name of names) {
      const image = toolImage(name);
      const digest = image.slice(image.indexOf('@'));
      assert.ok(pullableImage(image, { mirror: MIRROR, pull }).endsWith(digest), name);
    }
  });
});

describe('buildContexts', () => {
  const NODE = `public.ecr.aws/docker/library/node:24-bookworm-slim${DIGEST}`;
  const NGINX = `ghcr.io/nginx/nginx-unprivileged:1.31-alpine${DIGEST}`;
  const DOCKERFILE = [
    '# syntax=docker/dockerfile:1',
    `FROM ${NODE} AS base`,
    'FROM base AS build',
    `FROM --platform=linux/amd64 ${NODE} AS hardened`,
    `FROM ${NGINX} AS runtime`,
    'FROM node:24 AS unpinned',
  ].join('\n');

  test('each base image pinned by digest gets its mirror copy, once', () => {
    const { pull: has, pulled: asked } = mirrorWith(true);
    assert.deepEqual(buildContexts(DOCKERFILE, { mirror: MIRROR, has }), [
      `${NODE}=docker-image://${MIRROR}/library/node${DIGEST}`,
    ]);
    // Stages, other registries and unpinned references are not asked for.
    assert.deepEqual(asked, [`${MIRROR}/library/node${DIGEST}`]);
  });

  test('an image the mirror does not have is built from its pinned registry', () => {
    const { pull: has } = mirrorWith(false);
    assert.deepEqual(buildContexts(DOCKERFILE, { mirror: MIRROR, has }), []);
  });

  test('without a mirror, nothing changes and nothing is asked', () => {
    const { pull: has, pulled: asked } = mirrorWith(true);
    assert.deepEqual(buildContexts(DOCKERFILE, { mirror: '', has }), []);
    assert.deepEqual(asked, []);
  });

  test("the applications' Dockerfiles get a context for their ECR Public base image", () => {
    const { pull: has } = mirrorWith(true);
    for (const file of ['apps/api/Dockerfile', 'apps/web/Dockerfile']) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const contexts = buildContexts(text, { mirror: MIRROR, has });
      assert.ok(contexts.length > 0, file);
      for (const context of contexts) {
        const [image, copy] = context.split('=docker-image://');
        assert.ok(image && copy && copy.endsWith(image.slice(image.indexOf('@'))), context);
      }
    }
  });
});

/**
 * A fake `docker`: `image inspect` answers whether the image is here, and each
 * `pull` takes the next answer of the list.
 * @param {{ present?: boolean, pulls?: { status: number, stderr?: string }[] }} answers
 */
function dockerWith({ present = false, pulls = [] }) {
  /** @type {string[]} */
  const calls = [];
  /** @type {number[]} */
  const paused = [];
  let next = 0;
  return {
    calls,
    paused,
    pause: (/** @type {number} */ ms) => {
      paused.push(ms);
    },
    run: (/** @type {string} */ _command, /** @type {string[]} */ args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'image') return { status: present ? 0 : 1, stdout: '', stderr: '' };
      const answer = pulls[next++] ?? { status: 0 };
      return { stdout: '', stderr: '', ...answer };
    },
  };
}

const IMAGE = `public.ecr.aws/docker/library/postgres:18-alpine${DIGEST}`;
const RATE_LIMITED = { status: 1, stderr: 'toomanyrequests: Rate exceeded' };

describe('ensureImage', () => {
  test('an image already here is not pulled again', () => {
    const docker = dockerWith({ present: true });
    ensureImage(IMAGE, docker);
    assert.deepEqual(docker.calls, ['image inspect']);
  });

  test("a pull the registry's rate limit refused is retried after a growing pause", () => {
    // CI runners share their addresses, and Docker Hub, GHCR and ECR Public
    // all limit anonymous pulls per address.
    const docker = dockerWith({ pulls: [RATE_LIMITED, RATE_LIMITED, { status: 0 }] });
    ensureImage(IMAGE, docker);
    assert.deepEqual(docker.calls, [
      'image inspect',
      'pull --quiet',
      'pull --quiet',
      'pull --quiet',
    ]);
    assert.deepEqual(docker.paused, [5000, 10_000]);
  });

  test('any other failure is left to docker run, which reports it', () => {
    const docker = dockerWith({ pulls: [{ status: 1, stderr: 'manifest unknown' }] });
    ensureImage(IMAGE, docker);
    assert.deepEqual(docker.calls, ['image inspect', 'pull --quiet']);
    assert.deepEqual(docker.paused, []);
  });

  test('it gives up after four attempts', () => {
    const docker = dockerWith({ pulls: Array.from({ length: 6 }, () => RATE_LIMITED) });
    ensureImage(IMAGE, docker);
    assert.equal(docker.calls.filter((call) => call === 'pull --quiet').length, 4);
    assert.deepEqual(docker.paused, [5000, 10_000, 20_000]);
  });
});
