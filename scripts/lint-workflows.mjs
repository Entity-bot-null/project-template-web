// `pnpm lint:workflows` and the CI step "Lint GitHub workflows": actionlint
// (syntax, expressions, shellcheck on every `run:`) and zizmor (security:
// excessive permissions, template injection, unpinned actions, persisted
// credentials, cache poisoning, Dependabot cooldown), then shellcheck on the
// repository's shell scripts (the web image's entrypoint check), which
// workflows do not cover. Needs Docker. Any finding fails
// (docs/ci-cd.md#workflow-security).
//
// With GH_TOKEN set (CI), zizmor also runs its online audits: impostor
// commits (a pinned SHA that is not in the action's repository) and actions
// with known vulnerabilities.
import { execFileSync } from 'node:child_process';
import { runTool } from './tool-image.mjs';

const actionlint = runTool('actionlint', ['-color']);
const zizmor = runTool(
  'zizmor',
  [
    ...(process.env.GH_TOKEN ? [] : ['--offline']),
    '--config',
    '.github/zizmor.yml',
    '--min-severity',
    'low',
    '.github',
  ],
  { env: ['GH_TOKEN'] },
);

// Tracked and new files, not ignored ones (node_modules). shellcheck comes
// with the pinned actionlint image.
const shellScripts = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.sh'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => file.length > 0);
const shellcheck =
  shellScripts.length > 0 ? runTool('actionlint', shellScripts, { entrypoint: 'shellcheck' }) : 0;
process.exit(actionlint || zizmor || shellcheck);
