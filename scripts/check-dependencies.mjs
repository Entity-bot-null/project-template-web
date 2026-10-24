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
// 4. Release-delay exemptions (minimumReleaseAgeExclude): exact versions
//    only, each with an expiry date no further away than the delay itself,
//    written as a plain block list, and nothing else applied by pnpm.
// 5. Release sets: packages published together as one release (Prisma's CLI
//    and the client whose code it generates) resolve to one version wherever
//    the workspace uses them, so an update cannot move one of them alone.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseAllDocuments } from 'yaml';

// --- License expressions -------------------------------------------------------

/**
 * A parsed SPDX license expression.
 * @typedef {{ license: string; exception?: string } | { all: LicenseNode[] } | { any: LicenseNode[] }} LicenseNode
 */

// An identifier: "MIT", "GPL-2.0-or-later", "Apache-2.0+" (this version or
// any later one), "LicenseRef-x", "DocumentRef-y:LicenseRef-x".
const LICENSE_ID = /^[A-Za-z0-9.-]+(?::[A-Za-z0-9.-]+)?\+?$/;
const EXCEPTION_ID = /^[A-Za-z0-9.-]+(?::[A-Za-z0-9.-]+)?$/;
const OPERATORS = new Set(['AND', 'OR', 'WITH']);

/**
 * Parses an SPDX license expression (SPDX specification, annex "SPDX license
 * expressions"): WITH binds tighter than AND, AND tighter than OR, and
 * parentheses group. Operators in any letter case: package.json files write
 * "MIT and ISC" too. Throws a SyntaxError on anything else.
 * @param {string} expression
 * @returns {LicenseNode}
 */
export function parseLicenseExpression(expression) {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let position = 0;
  /** @param {string | undefined} token @param {string} operator */
  const is = (token, operator) => token?.toUpperCase() === operator;
  /** @param {string} what */
  const fail = (what) => {
    throw new SyntaxError(`${what} in license expression "${expression}"`);
  };

  /** @returns {LicenseNode} */
  function anyOf() {
    const terms = [allOf()];
    while (is(tokens[position], 'OR')) {
      position += 1;
      terms.push(allOf());
    }
    return terms.length === 1 ? /** @type {LicenseNode} */ (terms[0]) : { any: terms };
  }

  /** @returns {LicenseNode} */
  function allOf() {
    const terms = [term()];
    while (is(tokens[position], 'AND')) {
      position += 1;
      terms.push(term());
    }
    return terms.length === 1 ? /** @type {LicenseNode} */ (terms[0]) : { all: terms };
  }

  /** @returns {LicenseNode} */
  function term() {
    const token = tokens[position];
    position += 1;
    if (token === '(') {
      const inner = anyOf();
      if (tokens[position] !== ')') fail('Unclosed parenthesis');
      position += 1;
      // WITH applies to a single license, never to a group.
      if (is(tokens[position], 'WITH')) fail('WITH after a group');
      return inner;
    }
    if (token === undefined || token === ')' || OPERATORS.has(token.toUpperCase())) {
      return fail(`Missing license before "${token ?? 'the end'}"`);
    }
    if (!LICENSE_ID.test(token)) return fail(`Invalid license identifier "${token}"`);
    if (!is(tokens[position], 'WITH')) return { license: token };
    const exception = tokens[position + 1];
    if (exception === undefined || !EXCEPTION_ID.test(exception)) {
      return fail('Missing exception after WITH');
    }
    position += 2;
    return { license: token, exception };
  }

  const tree = anyOf();
  if (position !== tokens.length) fail(`Unexpected "${tokens[position]}"`);
  return tree;
}

/**
 * Whether a license expression, as pnpm reports it ("MIT", "(MIT OR
 * CC0-1.0)", "MIT and ISC"), can be complied with using allowed licenses
 * only: every license of an AND, at least one branch of an OR. An exception
 * (WITH) only adds permissions, so the license it extends decides. Anything
 * that does not parse is not allowed. Identifiers compare in any letter case,
 * as SPDX specifies.
 * @param {string} expression
 * @param {Set<string>} allowed
 */
export function isAllowed(expression, allowed) {
  /** @type {LicenseNode} */
  let tree;
  try {
    tree = parseLicenseExpression(expression);
  } catch {
    return false;
  }
  const permitted = new Set([...allowed].map((id) => id.toLowerCase()));
  /** @param {LicenseNode} node @returns {boolean} */
  const complies = (node) => {
    if ('any' in node) return node.any.some(complies);
    if ('all' in node) return node.all.every(complies);
    const id = node.license.toLowerCase();
    // "X+" is X or any later version: X itself is one of the choices.
    return permitted.has(id) || (id.endsWith('+') && permitted.has(id.slice(0, -1)));
  };
  return complies(tree);
}

// --- Release-delay exemptions ----------------------------------------------------

/** @typedef {{ entry: string; expires: string }} Exemption */

const EXCLUDE_KEY = /\bminimumReleaseAgeExclude\b/;
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
// "name@1.2.3", "@scope/name@1.2.3", "name@1.2.3 || 1.2.4": what pnpm accepts
// besides bare names and patterns, which exempt every version.
const EXACT_VERSIONS = new RegExp(
  String.raw`^(?:@[^\s@/*]+/)?[^\s@/*]+@${VERSION}(?:\s*\|\|\s*${VERSION})*$`,
);
const ENTRY_FORMAT = `"  - 'name@version' # expires YYYY-MM-DD: reason"`;

/** @param {string} date "YYYY-MM-DD" @param {number} days */
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** @param {string} date "YYYY-MM-DD", a day that exists */
function isDate(date) {
  const time = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === date;
}

/**
 * The release-delay exemptions (minimumReleaseAgeExclude) and what is wrong
 * with them. An exemption lets one release install before it is
 * `releaseAgeMinutes` old: for an urgent security fix only, so each entry
 * names exact versions (a bare name or a pattern exempts every future release
 * too) and the date it expires, at most one delay ahead (the version is old
 * enough by then). The date is checked on every run: an expired entry fails.
 *
 * The setting must be a plain block list, one entry per line with its date in
 * a comment; any other form (flow style, an alias, a quoted key) fails, since
 * an entry there carries no date. `applied` is what pnpm itself reads
 * (`pnpm config get minimumReleaseAgeExclude --json`): an exemption pnpm
 * applies that the list does not hold (written in a form this reader does not
 * see, or set by a global configuration or a PNPM_CONFIG_* variable) fails too.
 * @param {{ workspace: string; applied: unknown; today: string; releaseAgeMinutes: number }} input
 *   `today` is "YYYY-MM-DD" (UTC).
 * @returns {{ exemptions: Exemption[]; problems: string[] }}
 */
export function checkReleaseAgeExemptions({ workspace, applied, today, releaseAgeMinutes }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Exemption[]} */
  const exemptions = [];
  /** @type {string[]} entries as written, valid or not */
  const listed = [];
  const maxDays = Math.ceil(releaseAgeMinutes / 1440);
  const latest = addDays(today, maxDays);
  let inList = false;

  workspace.split(/\r?\n/).forEach((line, index) => {
    const where = `pnpm-workspace.yaml:${index + 1}`;
    // Comments and blank lines, inside the list too.
    if (/^\s*(?:#|$)/.test(line)) return;
    if (inList) {
      const item = /^\s*-[ \t]+(.*)$/.exec(line);
      if (item) {
        const problem = judgeEntry(item[1] ?? '');
        if (typeof problem === 'string') problems.push(`${where}: ${problem}`);
        return;
      }
      // A top-level key ends the list; anything else inside it is unexpected.
      inList = false;
      if (!/^\S/.test(line)) {
        problems.push(
          `${where}: write minimumReleaseAgeExclude as a block list, one ${ENTRY_FORMAT} per line.`,
        );
        return;
      }
    }
    if (!EXCLUDE_KEY.test(line.replace(/\s#.*$/, ''))) return;
    if (/^minimumReleaseAgeExclude:[ \t]*(?:#.*)?$/.test(line)) {
      inList = true;
      return;
    }
    problems.push(
      `${where}: write minimumReleaseAgeExclude as a block list, one ${ENTRY_FORMAT} per line: written another way (inline, an alias, a quoted key), an entry carries no expiry date.`,
    );
  });

  /**
   * @param {string} text an item of the list, after "- "
   * @returns {string | undefined} the problem, if any
   */
  function judgeEntry(text) {
    if (/^"[^"]*\\/.test(text)) {
      return `minimumReleaseAgeExclude entry ${text}: write it without escapes, in single quotes (${ENTRY_FORMAT}), so what review reads is what pnpm applies.`;
    }
    const parsed =
      /^(?:'((?:[^']|'')*)'|"([^"]*)"|([^\s'"#](?:[^#]*[^\s#])?))(?:[ \t]+#[ \t]*(.*))?$/.exec(
        text,
      );
    if (!parsed) {
      return `minimumReleaseAgeExclude entry ${text}: write it as ${ENTRY_FORMAT}.`;
    }
    const entry = parsed[1]?.replaceAll("''", "'") ?? parsed[2] ?? parsed[3] ?? '';
    const comment = parsed[4] ?? '';
    listed.push(entry);
    if (entry.includes('*')) {
      return `minimumReleaseAgeExclude entry "${entry}": a wildcard exempts every matching package and version, future releases included, from the release delay. Name the one version: name@version.`;
    }
    if (!EXACT_VERSIONS.test(entry)) {
      return `minimumReleaseAgeExclude entry "${entry}": name the exact version (name@1.2.3, or name@1.2.3 || 1.2.4). A bare name or a range exempts every version, future releases included.`;
    }
    const expires = /^expires (\d{4}-\d{2}-\d{2})(?![\w-])/.exec(comment)?.[1];
    if (expires === undefined || !isDate(expires)) {
      return `minimumReleaseAgeExclude entry "${entry}": add its expiry date and the reason in a comment, "# expires YYYY-MM-DD: reason", at most ${maxDays} days ahead (the release delay).`;
    }
    if (expires < today) {
      return `minimumReleaseAgeExclude entry "${entry}" expired on ${expires}: remove it. The version is old enough to install without it by now.`;
    }
    if (expires > latest) {
      return `minimumReleaseAgeExclude entry "${entry}" expires on ${expires}, more than ${maxDays} days ahead: an exemption is only needed until the version is as old as the release delay.`;
    }
    exemptions.push({ entry, expires });
    return undefined;
  }

  /** @type {unknown[]} */
  let appliedEntries = [];
  if (Array.isArray(applied)) appliedEntries = applied;
  else if (applied !== null && applied !== undefined) {
    problems.push(
      `pnpm reports minimumReleaseAgeExclude as ${JSON.stringify(applied)}, not a list: write it in pnpm-workspace.yaml as a block list, one ${ENTRY_FORMAT} per line.`,
    );
  }
  for (const entry of appliedEntries) {
    if (typeof entry === 'string' && listed.includes(entry)) continue;
    problems.push(
      `pnpm applies ${JSON.stringify(entry)} from minimumReleaseAgeExclude, but pnpm-workspace.yaml does not list it as a dated block-list entry: written in another form, or set by a global pnpm configuration or a PNPM_CONFIG_* variable. Remove it, or list it as ${ENTRY_FORMAT}.`,
    );
  }
  for (const entry of listed) {
    if (appliedEntries.includes(entry)) continue;
    problems.push(
      `pnpm does not apply ${JSON.stringify(entry)}, which pnpm-workspace.yaml lists under minimumReleaseAgeExclude: pnpm reads the file differently from this check. Write the setting as a plain block list.`,
    );
  }
  return { exemptions, problems };
}

// --- Release sets ----------------------------------------------------------------

// Packages published together as one release, which work only at the same
// version. Prisma's CLI generates the client code that @prisma/client runs:
// a grouped update that moves one of them and leaves the other behind (as
// when the install policy refuses the other's new version) still builds and
// can pass every test, with the generated code and its runtime from two
// releases.

/**
 * @typedef {{ packages: string[]; reason: string }} ReleaseSet
 * @typedef {{ specifier: string; version: string }} LockedDependency
 * @typedef {{
 *   dependencies?: Record<string, LockedDependency>;
 *   devDependencies?: Record<string, LockedDependency>;
 *   optionalDependencies?: Record<string, LockedDependency>;
 * }} Importer
 */

/** @type {readonly ('dependencies' | 'devDependencies' | 'optionalDependencies')[]} */
const DEPENDENCY_TYPES = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * The problems of the release sets against the lockfile: the members of a
 * set that the workspace uses directly must resolve to one version, in every
 * workspace package; a member left out is fine (not every project needs all
 * of them). A set that matches no direct dependency fails too: it would apply
 * unseen to packages added later. A resolved version is compared without its
 * peer suffix ("7.10.0(prisma@7.10.0)" is 7.10.0).
 * @param {Record<string, Importer>[]} importers the `importers` of each
 *   document of pnpm-lock.yaml (pnpm's own installation is one, the
 *   workspace's dependencies another)
 * @param {Record<string, ReleaseSet>} sets
 * @returns {string[]}
 */
export function checkReleaseSets(importers, sets) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, set] of Object.entries(sets)) {
    if (
      !Array.isArray(set.packages) ||
      set.packages.length < 2 ||
      typeof set.reason !== 'string' ||
      set.reason.trim() === ''
    ) {
      problems.push(
        `scripts/dependency-policy.json: the release set "${name}" needs two packages or more and its reason.`,
      );
      continue;
    }
    /** @type {Map<string, string[]>} each resolved version, and where */
    const versions = new Map();
    for (const document of importers) {
      for (const [importer, dependencies] of Object.entries(document)) {
        for (const type of DEPENDENCY_TYPES) {
          for (const pkg of set.packages) {
            const locked = dependencies[type]?.[pkg];
            if (locked === undefined) continue;
            const version = locked.version.replace(/\(.*$/, '');
            versions.set(version, [...(versions.get(version) ?? []), `${pkg} in ${importer}`]);
          }
        }
      }
    }
    if (versions.size === 0) {
      problems.push(
        `scripts/dependency-policy.json: the release set "${name}" applies to no direct dependency in pnpm-lock.yaml. Remove it.`,
      );
    } else if (versions.size > 1) {
      const found = [...versions]
        .map(([version, where]) => `${version} (${where.join(', ')})`)
        .join(', ');
      problems.push(
        `Release set "${name}": ${set.packages.join(', ')} must resolve to one version, found ${found}. Update them together, in one pull request. ${set.reason}`,
      );
    }
  }
  return problems;
}

function main() {
  const policy = JSON.parse(
    readFileSync(new URL('dependency-policy.json', import.meta.url), 'utf8'),
  );
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

  // --- Release-delay exemptions ------------------------------------------------

  // What pnpm itself applies, from every source it reads: the file is only
  // one of them. Through the shell, like the license listing.
  const applied = JSON.parse(
    execSync('pnpm config get minimumReleaseAgeExclude --json', { encoding: 'utf8' }) || 'null',
  );
  const { exemptions, problems: exemptionProblems } = checkReleaseAgeExemptions({
    workspace,
    applied,
    today: new Date().toISOString().slice(0, 10),
    // The configured delay when valid (it was judged above), else the floor.
    releaseAgeMinutes:
      releaseAge >= minimumReleaseAgeAtLeast ? releaseAge : minimumReleaseAgeAtLeast,
  });
  problems.push(...exemptionProblems);
  for (const { entry, expires } of exemptions) {
    console.warn(
      `Release-delay exemption: ${entry} installs before it is ${releaseAge} minutes old, until ${expires} (minimumReleaseAgeExclude in pnpm-workspace.yaml).`,
    );
  }

  // --- Release sets ------------------------------------------------------------

  // pnpm-lock.yaml holds two YAML documents: pnpm's own installation
  // (packageManagerDependencies), then the workspace's dependencies.
  const documents = parseAllDocuments(lockfile);
  const unreadable = documents.flatMap((document) => document.errors);
  if (unreadable.length > 0) {
    problems.push(`pnpm-lock.yaml does not parse as YAML: ${unreadable[0]?.message}`);
  } else {
    const importers = documents.map((document) => document.toJS()?.importers ?? {});
    problems.push(...checkReleaseSets(importers, policy.releaseSets.sets));
  }

  // --- Report ----------------------------------------------------------------

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      'Dependency policy: replace the dependency or restore the setting, or record a reviewed exception with its reason in scripts/dependency-policy.json (docs/security.md#dependency-policy).',
    );
    return 1;
  }
  console.log(
    `Dependency policy OK: ${checked} lockfile sources, licenses of ${prodPackages.size} production and ${allPackages.size} total packages, release sets on one version (${Object.keys(policy.releaseSets.sets).join(', ')}).`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
