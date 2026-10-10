// Branch naming (docs/branching.md): <type>/<short-description>, for example
// feat/user-invitations or fix/ABC-123-session-expiry. Used by the pre-push
// hook and by CI on every pull request.
//
//   node scripts/check-branch-name.mjs [branch]   (default: the current one)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BRANCH_TYPES = [
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'ci',
  'build',
  'perf',
  'hotfix',
  'release',
];

/** Branches opened by bots (dependencies, release pull requests) keep their own naming. */
const BOT_PREFIXES = ['dependabot/', 'renovate/', 'release-please--'];

const PATTERN = new RegExp(`^(${BRANCH_TYPES.join('|')})/[A-Za-z0-9][A-Za-z0-9._-]*$`);

/**
 * @param {string} name
 * @returns {string | null} why the name is rejected, or null when it is fine
 */
export function branchNameProblem(name) {
  if (BOT_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  if (PATTERN.test(name)) return null;
  return `Branch "${name}" must be <type>/<description> (letters, digits, ".", "_", "-"), type one of: ${BRANCH_TYPES.join(', ')}. See docs/branching.md.`;
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) {
  const name =
    process.argv[2] ??
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  // Detached HEAD (tag checkouts, some CI setups) has no branch to judge.
  const problem = name === 'HEAD' ? null : branchNameProblem(name);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Branch name OK: ${name}`);
}
