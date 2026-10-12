// The pinned tool images of .github/tool-images/Dockerfile (docs/ci-cd.md#pinning).
//
//   node scripts/tool-image.mjs <name>     print the image reference (workflows)
//
// Imported by the scripts that run a tool in Docker, so CI and the local
// commands run the same pinned image the same way.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DOCKERFILE = new URL('../.github/tool-images/Dockerfile', import.meta.url);

/** @param {string} name the stage name, e.g. "trivy" */
export function toolImage(name) {
  const source = readFileSync(DOCKERFILE, 'utf8');
  for (const line of source.split('\n')) {
    const match = /^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/i.exec(line.trim());
    const [, image, stage] = match ?? [];
    if (image && stage === name) {
      if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
        throw new Error(`Tool image "${name}" must be pinned by digest: ${image}`);
      }
      return image;
    }
  }
  throw new Error(`No tool image named "${name}" in .github/tool-images/Dockerfile`);
}

// Docker Hub limits anonymous pulls per address, and CI runners share theirs;
// ECR Public limits them too ("toomanyrequests: Data limit exceeded"). With
// TOOL_IMAGE_MIRROR set (CI sets mirror.gcr.io, a mirror of Docker Hub), an
// image hosted on Docker Hub, or republished on ECR Public with Docker Hub's
// digest, is pulled from the mirror by that digest. The digest makes the
// content identical whatever the source, and the pinned registry is used as
// before when the mirror does not have it. Without the variable (local runs)
// nothing changes.

/**
 * The reference to run: the mirror's copy of a Docker Hub or ECR Public image,
 * when a mirror is set and has it; the pinned reference otherwise.
 * @param {string} image a reference pinned by digest
 * @param {{ mirror?: string; pull?: (reference: string) => boolean }} [options]
 */
export function pullableImage(
  image,
  { mirror = process.env.TOOL_IMAGE_MIRROR, pull = dockerPull } = {},
) {
  if (!mirror) return image;
  const at = image.indexOf('@');
  const parts = image.slice(0, at).split('/');
  const host = parts.length > 1 ? (parts[0] ?? '') : '';
  const isHost = host.includes('.') || host.includes(':') || host === 'localhost';
  /** @type {string[]} the repository on Docker Hub */
  let repository;
  if (!isHost) repository = parts;
  else if (['docker.io', 'index.docker.io'].includes(host)) repository = parts.slice(1);
  // ECR Public republishes Docker Hub images with their digests: Docker's
  // official ones under docker/library/, a publisher's under its own
  // namespace (hashicorp/terraform).
  else if (host === 'public.ecr.aws') repository = parts.slice(parts[1] === 'docker' ? 2 : 1);
  else return image;
  const path = repository.join('/').replace(/:[^/]*$/, '');
  const copy = `${mirror}/${path.includes('/') ? path : `library/${path}`}${image.slice(at)}`;
  return pull(copy) ? copy : image;
}

/** @param {string} reference */
function dockerPull(reference) {
  return spawnSync('docker', ['pull', '--quiet', reference], { stdio: 'ignore' }).status === 0;
}

// The answers of a registry that limits anonymous pulls per address: Docker
// Hub ("toomanyrequests"), ECR Public ("Rate exceeded"), GHCR (429).
const RATE_LIMITED = /toomanyrequests|rate exceeded|too many requests|\b429\b/i;

/**
 * Makes sure an image is here before `docker run` uses it. CI runners share
 * their addresses, and every registry the pins use limits anonymous pulls per
 * address: a pull refused for that is retried after 5, 10 and 20 seconds.
 * Any other failure is left to `docker run`, which reports it.
 * @param {string} reference
 * @param {{ run?: Run, pause?: (ms: number) => void, attempts?: number }} [options]
 */
export function ensureImage(reference, { run = spawnRun, pause = sleep, attempts = 4 } = {}) {
  if (run('docker', ['image', 'inspect', reference], { stdio: 'ignore' }).status === 0) return;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pull = run('docker', ['pull', '--quiet', reference], { encoding: 'utf8' });
    if (pull.status === 0) return;
    const output = [pull.stderr, pull.stdout].filter((part) => typeof part === 'string').join('');
    if (attempt === attempts || !RATE_LIMITED.test(output)) return;
    const waitMs = 5000 * 2 ** (attempt - 1);
    console.error(
      `${reference}: the registry limited anonymous pulls; retrying in ${waitMs / 1000} s (attempt ${attempt + 1} of ${attempts}).`,
    );
    pause(waitMs);
  }
}

/**
 * How the scripts call `docker`; the tests pass a fake.
 * @typedef {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptions) => { status: number | null, stdout?: unknown, stderr?: unknown }} Run
 */

/** @type {Run} */
const spawnRun = (command, args, options) => spawnSync(command, args, options);

/** Blocks for `ms`: the scripts run their tools one after another anyway. */
function sleep(/** @type {number} */ ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs a tool image with the repository mounted at `mount` (also the working
 * directory) and returns its exit status.
 * @param {string} name
 * @param {string[]} args
 * @param {{ env?: string[]; mount?: string; entrypoint?: string; source?: string; input?: string }} [options]
 *   variables passed through from this process; where the image expects the
 *   code (default /repo); another program of the image than its default one;
 *   the directory mounted (default the current one); text written to the
 *   tool's standard input
 */
export function runTool(
  name,
  args,
  { env = [], mount = '/repo', entrypoint, source = process.cwd(), input } = {},
) {
  const passEnv = env.filter((key) => process.env[key]).flatMap((key) => ['-e', key]);
  const image = pullableImage(toolImage(name));
  ensureImage(image);
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      ...(input === undefined ? [] : ['-i']),
      '-v',
      `${source}:${mount}`,
      '-w',
      mount,
      ...passEnv,
      ...(entrypoint ? ['--entrypoint', entrypoint] : []),
      image,
      ...args,
    ],
    input === undefined ? { stdio: 'inherit' } : { stdio: ['pipe', 'inherit', 'inherit'], input },
  );
  if (run.error) {
    console.error(
      `Could not start Docker (${run.error.message}). These checks need Docker; CI runs them on every pull request.`,
    );
    return 1;
  }
  return run.status ?? 1;
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/tool-image.mjs <name>');
    process.exit(2);
  }
  console.log(toolImage(name));
}
