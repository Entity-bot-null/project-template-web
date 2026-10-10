// The Deploy workflow's record of the images it published
// (docs/ci-cd.md#deployment). A run that builds an image pushes it, scans
// the digest it pushed, and records `<image>@<digest>` as the artifact
// `image-<image>-<commit>`. A later deployment of the same commit (production
// after staging, a redeployment) reuses that record instead of building
// again: production runs the very digests staging ran.
//
// A record is trusted only from a run of this same workflow whose own commit
// is on main, whose workflow file was therefore reviewed. The registry tag
// `<image>:<commit>` is never trusted: any workflow of the repository with
// `packages: write`, on any branch, can push it.
//
//   node scripts/recorded-images.mjs <commit SHA> <image>...
//
// Prints the JSON map image → run id holding its record (an image without
// one is left out: it gets built) and writes it as the `records` output when
// GITHUB_OUTPUT is set. Reads GITHUB_API_URL, GITHUB_REPOSITORY,
// GITHUB_RUN_ID and GH_TOKEN; run it in a clone with main's history
// (origin/main). Any failure to ask GitHub fails: a deployment never
// rebuilds an image silently because the record could not be read.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The artifact name of an image's record.
 * @param {string} image
 * @param {string} sha
 */
export function recordName(image, sha) {
  return `image-${image}-${sha}`;
}

/**
 * GET on GitHub's REST API, answered with the parsed JSON body.
 * @typedef {(path: string) => Promise<any>} Request
 */

/**
 * The id of the newest run that recorded `image` for `sha` and can be
 * trusted, or null.
 * @param {{
 *   repository: string;
 *   runId: number;
 *   sha: string;
 *   image: string;
 *   request: Request;
 *   isOnMain: (sha: string) => boolean;
 *   log?: (line: string) => void;
 * }} options
 * @returns {Promise<number | null>}
 */
export async function findRecord({ repository, runId, sha, image, request, isOnMain, log }) {
  if (!COMMIT.test(sha)) throw new Error(`Not a commit SHA: ${sha}`);
  if (!IMAGE.test(image)) throw new Error(`Not an image name: ${image}`);
  const self = await request(`/repos/${repository}/actions/runs/${String(runId)}`);
  // A hundred records of one image and commit is far beyond any real
  // history (each deployment adds one). The API does not list them strictly
  // by age: newest first by their creation time.
  const listing = await request(
    `/repos/${repository}/actions/artifacts?name=${encodeURIComponent(recordName(image, sha))}&per_page=100`,
  );
  /** @type {{ expired?: boolean; created_at?: string; workflow_run?: { id?: unknown } }[]} */
  const artifacts = [...(listing.artifacts ?? [])];
  artifacts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const artifact of artifacts) {
    const candidate = artifact.workflow_run?.id;
    if (artifact.expired === true || typeof candidate !== 'number' || candidate === runId) continue;
    const run = await request(`/repos/${repository}/actions/runs/${String(candidate)}`);
    // An artifact of that name can come from any workflow, on any branch.
    if (run.workflow_id !== self.workflow_id) {
      log?.(`${image}: run ${String(candidate)} belongs to another workflow: ignored.`);
    } else if (run.head_repository?.full_name !== repository) {
      log?.(`${image}: run ${String(candidate)} ran a fork's code: ignored.`);
    } else if (typeof run.head_sha !== 'string' || !isOnMain(run.head_sha)) {
      // This workflow's file, edited and dispatched from a branch.
      log?.(`${image}: run ${String(candidate)} ran from a commit that is not on main: ignored.`);
    } else {
      return candidate;
    }
  }
  return null;
}

/**
 * True when `sha` is on origin/main (git: the clone needs main's history).
 * @param {string} sha
 */
export function isOnOriginMain(sha) {
  if (!COMMIT.test(sha)) return false;
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']).status === 0;
}

/**
 * @param {string} name
 * @returns {string}
 */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [sha = '', ...images] = process.argv.slice(2);
  if (images.length === 0) {
    console.error('Usage: node scripts/recorded-images.mjs <commit SHA> <image>...');
    process.exit(2);
  }
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const token = required('GH_TOKEN');
  /** @type {Request} */
  const request = async (path) => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} to GET ${path}`);
    return response.json();
  };
  /** @type {Record<string, number>} */
  const records = {};
  for (const image of images) {
    const found = await findRecord({
      repository: required('GITHUB_REPOSITORY'),
      runId: Number(required('GITHUB_RUN_ID')),
      sha,
      image,
      request,
      isOnMain: isOnOriginMain,
      log: (line) => {
        console.log(line);
      },
    });
    if (found === null) console.log(`${image}: no record of ${sha}: it will be built.`);
    else {
      console.log(`${image}: reusing the build recorded by run ${String(found)}.`);
      records[image] = found;
    }
  }
  const json = JSON.stringify(records);
  console.log(json);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `records=${json}\n`);
}
