// Pre-push guard (docs/git-hooks.md). Git writes one line per pushed ref on
// stdin: "<local ref> <local sha> <remote ref> <remote sha>". Changes reach
// main only through pull requests, so pushes to a protected branch (deletions
// included) are refused here, before the server is involved; this works on
// any hosting plan, with or without server-side branch protection.
//
// Escape hatch for the very first push of a new repository only:
//   git push --no-verify -u origin main
import { readFileSync } from 'node:fs';
import { branchNameProblem } from '../check-branch-name.mjs';

const PROTECTED = new Set(['main', 'master']);

const problems = [];
for (const line of readFileSync(0, 'utf8').split('\n')) {
  const [, , remoteRef] = line.trim().split(/\s+/);
  if (!remoteRef?.startsWith('refs/heads/')) continue;
  const branch = remoteRef.slice('refs/heads/'.length);
  if (PROTECTED.has(branch)) {
    problems.push(
      `Direct pushes to "${branch}" are not allowed: push a feature branch and open a pull request.`,
    );
    continue;
  }
  const problem = branchNameProblem(branch);
  if (problem) problems.push(problem);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`pre-push: ${problem}`);
  process.exit(1);
}
