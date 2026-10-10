// `pnpm secrets:scan`: secretlint over every file git tracks, including any
// forced past .gitignore (secretlint skips gitignored files unless told not
// to), plus the new files a commit would pick up. In batches, to stay under
// the command-line length limit on Windows.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SECRETLINT = 'node_modules/secretlint/bin/secretlint.js';
const BATCH_SIZE = 100;
// Tracked files, and untracked ones that .gitignore does not exclude.
const LIST_FILES = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];

const files = execFileSync('git', LIST_FILES, { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0 && existsSync(file));

let failed = false;
for (let start = 0; start < files.length; start += BATCH_SIZE) {
  const batch = files.slice(start, start + BATCH_SIZE);
  const run = spawnSync(
    process.execPath,
    [SECRETLINT, '--maskSecrets', '--no-gitignore', ...batch],
    { stdio: 'inherit' },
  );
  if (run.status !== 0) failed = true;
}
console.log(`secretlint: ${files.length} files scanned.`);
process.exit(failed ? 1 : 0);
