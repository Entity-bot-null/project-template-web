// `pnpm deps:check` (part of `pnpm security`, so of `pnpm verify` and CI):
// the dependency policy in scripts/dependency-policy.json
// (docs/security.md#dependency-policy).
//
// 1. Sources: every package in pnpm-lock.yaml resolves from the registry with
//    a sha512 integrity hash. A git repository, a tarball URL or a local
//    directory bypasses the registry, its integrity checks and the release
//    delay; pnpm already refuses them for transitive dependencies
//    (blockExoticSubdeps), this covers the direct ones.
// 2. Licenses: production dependencies (what the images ship) use an allowed
//    license; development tools may also use the development-only ones.
//    Unknown licenses fail.
// 3. Install settings: pnpm-workspace.yaml keeps the release delay, the trust
//    policy and the block on transitive sources outside the registry.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('dependency-policy.json', import.meta.url), 'utf8'));
/** @type {string[]} */
const problems = [];

// --- Sources ---------------------------------------------------------------

const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
/** @type {string | undefined} */
let current;
let checked = 0;
for (const line of lockfile.split('\n')) {
  // Package keys sit at two spaces of indentation: "  name@version:".
  const key = /^ {2}'?([^\s'][^']*?)'?:\s*$/.exec(line);
  if (key) current = key[1];
  if (!line.trimStart().startsWith('resolution:')) continue;
  checked += 1;
  if (/\{integrity: sha512-[A-Za-z0-9+/=]+\}/.test(line)) continue;
  const name = current?.replace(/@[^@]+$/, '') ?? '(unknown)';
  if (Object.hasOwn(policy.sources.exceptions, name)) continue;
  problems.push(
    `${current}: not resolved from the registry with a sha512 hash (${line.trim()}). Use a registry release, or add a reviewed exception to scripts/dependency-policy.json.`,
  );
}

// --- Licenses --------------------------------------------------------------

/**
 * @param {string[]} flags
 * @returns {Record<string, { name: string; versions: string[] }[]>}
 */
function licenses(...flags) {
  // Through the shell: pnpm is a .cmd shim on Windows. The command is constant.
  const output = execSync(`pnpm licenses list --json ${flags.join(' ')}`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

/**
 * SPDX expressions as pnpm reports them: "MIT", "(MIT OR CC0-1.0)", "MIT and ISC".
 * @param {string} expression
 * @param {Set<string>} allowed
 */
function isAllowed(expression, allowed) {
  return expression
    .replace(/[()]/g, '')
    .split(/\s+or\s+/i)
    .some((alternative) =>
      alternative
        .split(/\s+and\s+/i)
        .every((id) => allowed.has(id.replace(/\s+with\s+.*$/i, '').trim())),
    );
}

/**
 * @param {Record<string, { name: string; versions: string[] }[]>} byLicense
 * @param {Set<string>} allowed
 * @param {string} scope
 * @param {Set<string>} [skip] packages already judged
 * @returns {Set<string>} the packages checked
 */
function checkLicenses(byLicense, allowed, scope, skip = new Set()) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [expression, packages] of Object.entries(byLicense)) {
    for (const pkg of packages) {
      seen.add(pkg.name);
      if (skip.has(pkg.name) || isAllowed(expression, allowed)) continue;
      const exception = policy.licenses.exceptions[pkg.name];
      if (exception?.license === expression) continue;
      problems.push(
        `${pkg.name}@${pkg.versions.join(', ')} (${scope}): license "${expression}" is not allowed by scripts/dependency-policy.json.`,
      );
    }
  }
  return seen;
}

const production = new Set(policy.licenses.allowed);
const development = new Set([...production, ...policy.licenses.allowedInDevelopment]);
// Production packages were judged by the stricter list already.
const prodPackages = checkLicenses(licenses('--prod'), production, 'production');
const allPackages = checkLicenses(licenses(), development, 'development', prodPackages);

// --- Install settings --------------------------------------------------------

// The settings in pnpm-workspace.yaml that keep the supply chain policy: an
// edit that weakens one fails here, in review's sight, not silently.
const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
// Top-level scalar settings ("key: value", no indentation), by name.
/** @type {Map<string, string>} */
const settings = new Map();
for (const line of workspace.split(/\r?\n/)) {
  const [, key, value] = /^([A-Za-z]\w*):[ \t]*([^\s#]+)/.exec(line) ?? [];
  if (key && value) settings.set(key, value);
}
/** @param {string} key */
const setting = (key) => settings.get(key);
const { minimumReleaseAgeAtLeast, required } = policy.installSettings;
const releaseAge = Number(setting('minimumReleaseAge'));
if (!(releaseAge >= minimumReleaseAgeAtLeast)) {
  problems.push(
    `pnpm-workspace.yaml: minimumReleaseAge is ${setting('minimumReleaseAge') ?? 'not set'}, the policy requires at least ${minimumReleaseAgeAtLeast} minutes. For an urgent fix, exempt the one package with minimumReleaseAgeExclude instead.`,
  );
}
for (const [key, value] of Object.entries(/** @type {Record<string, string>} */ (required))) {
  if (setting(key) !== value) {
    problems.push(
      `pnpm-workspace.yaml: ${key} is ${setting(key) ?? 'not set'}, the policy requires ${value}.`,
    );
  }
}

// --- Release-delay exemptions (advisory) -----------------------------------

const exempted = /^minimumReleaseAgeExclude:\r?\n((?: {2}- .*\r?\n)+)/m
  .exec(workspace)?.[1]
  ?.trim()
  .split(/\r?\n/);
if (exempted) {
  console.warn(
    `Advisory: ${exempted.length} packages skip the minimumReleaseAge delay (minimumReleaseAgeExclude in pnpm-workspace.yaml). Remove each one once the version it covers is old enough.`,
  );
}

// --- Report ----------------------------------------------------------------

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(
    'Dependency policy: replace the dependency or restore the setting, or record a reviewed exception with its reason in scripts/dependency-policy.json (docs/security.md#dependency-policy).',
  );
  process.exit(1);
}
console.log(
  `Dependency policy OK: ${checked} lockfile sources, licenses of ${prodPackages.size} production and ${allPackages.size} total packages.`,
);
