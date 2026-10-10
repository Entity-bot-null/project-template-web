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

// Docker Hub limits anonymous pulls per address, and CI runners share theirs.
// With TOOL_IMAGE_MIRROR set (CI sets mirror.gcr.io, a mirror of Docker Hub),
// an image hosted on Docker Hub is pulled from the mirror by its digest. The
// digest makes the content identical whatever the source, and Docker Hub is
// used as before when the mirror does not have it. Without the variable
// (local runs) nothing changes.

/**
 * The reference to run: the mirror's copy of a Docker Hub image, when a mirror
 * is set and has it; the pinned reference otherwise.
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
  const dockerHub = ['', 'docker.io', 'index.docker.io'].includes(host);
  const isHost = host.includes('.') || host.includes(':') || host === 'localhost';
  if (!dockerHub && isHost) return image;
  const path = (isHost ? parts.slice(1) : parts).join('/').replace(/:[^/]*$/, '');
  const copy = `${mirror}/${path.includes('/') ? path : `library/${path}`}${image.slice(at)}`;
  return pull(copy) ? copy : image;
}

/** @param {string} reference */
function dockerPull(reference) {
  return spawnSync('docker', ['pull', '--quiet', reference], { stdio: 'ignore' }).status === 0;
}

/**
 * Runs a tool image with the repository mounted at `mount` (also the working
 * directory) and returns its exit status.
 * @param {string} name
 * @param {string[]} args
 * @param {{ env?: string[]; mount?: string; entrypoint?: string; source?: string }} [options]
 *   variables passed through from this process; where the image expects the
 *   code (default /repo); another program of the image than its default one;
 *   the directory mounted (default the current one)
 */
export function runTool(
  name,
  args,
  { env = [], mount = '/repo', entrypoint, source = process.cwd() } = {},
) {
  const passEnv = env.filter((key) => process.env[key]).flatMap((key) => ['-e', key]);
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${source}:${mount}`,
      '-w',
      mount,
      ...passEnv,
      ...(entrypoint ? ['--entrypoint', entrypoint] : []),
      pullableImage(toolImage(name)),
      ...args,
    ],
    { stdio: 'inherit' },
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
