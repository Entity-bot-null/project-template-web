// The pinned tool images of scripts/tool-images/Dockerfile (docs/ci-cd.md#pinning).
//
//   node scripts/tool-image.mjs <name>     print the image reference (workflows)
//   node scripts/tool-image.mjs --mirrored <name>
//                                          the mirror's copy when TOOL_IMAGE_MIRROR
//                                          is set and has it (service containers)
//   node scripts/tool-image.mjs --build-contexts <Dockerfile>
//                                          a build context per base image the
//                                          mirror has (docker/build-push-action)
//
// Imported by the scripts that run a tool in Docker, so CI and the local
// commands run the same pinned image the same way.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DOCKERFILE = new URL('./tool-images/Dockerfile', import.meta.url);

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
  throw new Error(`No tool image named "${name}" in scripts/tool-images/Dockerfile`);
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
 *   `pull` answers whether the mirror has the copy (default: it pulls it)
 */
export function pullableImage(
  image,
  { mirror = process.env.TOOL_IMAGE_MIRROR, pull = dockerPull } = {},
) {
  if (!mirror) return image;
  const copy = mirrorReference(image, mirror);
  return copy && pull(copy) ? copy : image;
}

/**
 * Build contexts that replace each base image of a Dockerfile pinned by
 * digest with the mirror's copy, where the mirror has it: BuildKit uses a
 * context named like a FROM reference instead of pulling it, so the
 * Dockerfile keeps its pins (and Dependabot its updates). Same digest, same
 * content. One `<reference>=docker-image://<copy>` line each.
 * @param {string} dockerfile the Dockerfile's text
 * @param {{ mirror?: string; has?: (reference: string) => boolean }} [options]
 */
export function buildContexts(
  dockerfile,
  { mirror = process.env.TOOL_IMAGE_MIRROR, has = manifestExists } = {},
) {
  if (!mirror) return [];
  const images = new Set();
  for (const line of dockerfile.split('\n')) {
    // FROM [--platform=…] <image> [AS <stage>]; a stage name has no digest.
    const words = line.trim().split(/\s+/);
    if (words[0]?.toUpperCase() !== 'FROM') continue;
    const image = words.slice(1).find((word) => !word.startsWith('--'));
    if (image && /@sha256:[0-9a-f]{64}$/.test(image)) images.add(image);
  }
  return [...images].flatMap((image) => {
    const copy = mirrorReference(image, mirror);
    return copy && has(copy) ? [`${image}=docker-image://${copy}`] : [];
  });
}

/**
 * The mirror's name for an image of Docker Hub or ECR Public, by its digest;
 * undefined for any other registry.
 * @param {string} image a reference pinned by digest
 * @param {string} mirror
 */
function mirrorReference(image, mirror) {
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
  else return undefined;
  const path = repository.join('/').replace(/:[^/]*$/, '');
  return `${mirror}/${path.includes('/') ? path : `library/${path}`}${image.slice(at)}`;
}

/** @param {string} reference */
function dockerPull(reference) {
  return spawnSync('docker', ['pull', '--quiet', reference], { stdio: 'ignore' }).status === 0;
}

/**
 * Whether the registry has the image, asked without pulling it: for the
 * service containers and the builds, which pull it themselves.
 * @param {string} reference
 */
function manifestExists(reference) {
  return spawnSync('docker', ['manifest', 'inspect', reference], { stdio: 'ignore' }).status === 0;
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
  const [first, second] = process.argv.slice(2);
  if (first === '--mirrored' && second) {
    console.log(pullableImage(toolImage(second), { pull: manifestExists }));
  } else if (first === '--build-contexts' && second) {
    for (const context of buildContexts(readFileSync(second, 'utf8'))) console.log(context);
  } else if (first && !first.startsWith('--')) {
    console.log(toolImage(first));
  } else {
    console.error(
      'Usage: node scripts/tool-image.mjs [--mirrored] <name> | --build-contexts <Dockerfile>',
    );
    process.exit(2);
  }
}
