// Tests of scripts/check-dependencies.mjs (`node --test scripts/check-dependencies.test.mjs`):
// the license expression evaluator, the rules for release-delay exemptions
// and the release sets. Pure functions on strings and parsed lockfiles: the
// real policy run, with pnpm, is `pnpm deps:check`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkReleaseAgeExemptions, checkReleaseSets, isAllowed } from './check-dependencies.mjs';

describe('isAllowed: SPDX license expressions', () => {
  const allowed = new Set(['MIT', 'ISC', 'Apache-2.0']);
  /** @param {string} expression */
  const judge = (expression) => isAllowed(expression, allowed);

  test('a single identifier', () => {
    assert.equal(judge('MIT'), true);
    assert.equal(judge('GPL-3.0-only'), false);
  });

  test('parentheses group: a choice that is copyleft on every branch fails', () => {
    // Every way to comply includes GPL-3.0.
    assert.equal(judge('(MIT OR GPL-2.0) AND GPL-3.0'), false);
    assert.equal(judge('GPL-3.0 AND (MIT OR GPL-2.0)'), false);
    assert.equal(judge('MIT AND (ISC OR GPL-3.0)'), true);
    assert.equal(judge('(MIT OR GPL-3.0) AND (GPL-2.0 OR ISC)'), true);
    assert.equal(judge('((MIT OR GPL-3.0) AND (ISC OR GPL-2.0))'), true);
    assert.equal(judge('(GPL-3.0 OR LGPL-2.1) AND MIT'), false);
  });

  test('AND binds tighter than OR', () => {
    // MIT OR (GPL-2.0 AND GPL-3.0): MIT alone complies.
    assert.equal(judge('MIT OR GPL-2.0 AND GPL-3.0'), true);
    // (GPL-3.0 AND MIT) OR GPL-2.0: no allowed branch.
    assert.equal(judge('GPL-3.0 AND MIT OR GPL-2.0'), false);
    assert.equal(judge('GPL-3.0 AND MIT OR ISC'), true);
  });

  test('WITH binds tighter than AND and OR, and judges the license it extends', () => {
    assert.equal(judge('Apache-2.0 WITH LLVM-exception'), true);
    assert.equal(judge('GPL-2.0-only WITH Classpath-exception-2.0'), false);
    assert.equal(judge('GPL-2.0-only WITH Classpath-exception-2.0 OR MIT'), true);
    assert.equal(judge('MIT AND GPL-2.0-only WITH Classpath-exception-2.0'), false);
  });

  test('"or later" (+) allows the version the policy names', () => {
    assert.equal(judge('Apache-2.0+'), true);
    assert.equal(judge('GPL-2.0+'), false);
  });

  test('operators and identifiers in any letter case, as package.json files write them', () => {
    assert.equal(judge('MIT and ISC'), true);
    assert.equal(judge('MIT and GPL-3.0'), false);
    assert.equal(judge('(mit or gpl-3.0)'), true);
  });

  test('anything that is not a valid expression fails closed', () => {
    for (const expression of [
      '',
      '(MIT',
      'MIT)',
      '()',
      'MIT OR',
      'AND MIT',
      'MIT ISC',
      'MIT WITH',
      'MIT OR OR ISC',
      '(MIT OR ISC) WITH LLVM-exception',
      'SEE LICENSE IN LICENSE.md',
      'Custom: https://example.com/license',
      'MIT*',
    ]) {
      assert.equal(judge(expression), false, expression);
    }
  });
});

describe('checkReleaseAgeExemptions', () => {
  const header = [
    'packages:',
    '  - apps/*',
    '# Comments may name minimumReleaseAgeExclude: [anything] freely.',
    'minimumReleaseAge: 10080',
    'minimumReleaseAgeExcludePrune: true',
  ].join('\n');
  /** @param {string[]} lines */
  const workspaceWith = (...lines) => `${header}\n${lines.join('\n')}\ntrustPolicy: no-downgrade\n`;
  /**
   * @param {string} workspace
   * @param {unknown} applied what pnpm reports it applies
   * @param {string} [today]
   */
  const check = (workspace, applied, today = '2026-10-09') =>
    checkReleaseAgeExemptions({ workspace, applied, today, releaseAgeMinutes: 10080 });
  /**
   * @param {string[]} problems
   * @param {RegExp} pattern
   */
  const assertOneProblem = (problems, pattern) => {
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0] ?? '', pattern);
  };

  test('none at all', () => {
    assert.deepEqual(check(workspaceWith(), null), { exemptions: [], problems: [] });
  });

  test('exact versions, written as a block list, each with its expiry date', () => {
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      '  # Urgent fixes only.',
      "  - 'vite@8.3.3' # expires 2026-10-16: GHSA-aaaa-bbbb-cccc",
      '',
      '  - "@nestjs/core@12.1.3 || 12.1.4" # expires 2026-10-09',
      '  - pg@8.23.2 # expires 2026-10-10',
    );
    const applied = ['vite@8.3.3', '@nestjs/core@12.1.3 || 12.1.4', 'pg@8.23.2'];
    assert.deepEqual(check(workspace, applied), {
      exemptions: [
        { entry: 'vite@8.3.3', expires: '2026-10-16' },
        { entry: '@nestjs/core@12.1.3 || 12.1.4', expires: '2026-10-09' },
        { entry: 'pg@8.23.2', expires: '2026-10-10' },
      ],
      problems: [],
    });
  });

  test('a block list at the key indentation is a block list too', () => {
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      '- vite@8.3.3 # expires 2026-10-12',
    );
    assert.deepEqual(check(workspace, ['vite@8.3.3']).problems, []);
  });

  test('fails once the expiry date has passed', () => {
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      "  - 'vite@8.3.3' # expires 2026-10-09: GHSA-aaaa-bbbb-cccc",
    );
    assert.deepEqual(check(workspace, ['vite@8.3.3'], '2026-10-09').problems, []);
    assertOneProblem(
      check(workspace, ['vite@8.3.3'], '2026-10-10').problems,
      /expired on 2026-10-09/,
    );
  });

  test('fails on an expiry further away than the release delay', () => {
    // Seven days: by then the version is old enough to install without it.
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      "  - 'vite@8.3.3' # expires 2026-10-17",
    );
    assertOneProblem(check(workspace, ['vite@8.3.3']).problems, /more than 7 days ahead/);
    assert.deepEqual(check(workspace, ['vite@8.3.3'], '2026-10-10').problems, []);
  });

  test('fails on an entry without a valid expiry date', () => {
    for (const comment of [
      '',
      ' # GHSA-aaaa-bbbb-cccc',
      ' # expires 2026-02-30',
      ' # expires soon',
    ]) {
      const workspace = workspaceWith('minimumReleaseAgeExclude:', `  - vite@8.3.3${comment}`);
      assertOneProblem(check(workspace, ['vite@8.3.3']).problems, /expires YYYY-MM-DD/);
    }
  });

  test('fails on a bare package name or a range: every version would skip the delay', () => {
    for (const entry of ['vite', '@nestjs/core', 'vite@^8.3.0', 'vite@8.x', 'vite@>=8.3.3']) {
      const workspace = workspaceWith(
        'minimumReleaseAgeExclude:',
        `  - '${entry}' # expires 2026-10-12`,
      );
      assertOneProblem(check(workspace, [entry]).problems, /exact version/);
    }
  });

  test('fails on a wildcard', () => {
    for (const entry of ['*', '@nestjs/*', 'vite@*']) {
      const workspace = workspaceWith(
        'minimumReleaseAgeExclude:',
        `  - '${entry}' # expires 2026-10-12`,
      );
      assertOneProblem(check(workspace, [entry]).problems, /wildcard/);
    }
  });

  test('fails on the setting written in any other form than a block list', () => {
    for (const [line, applied] of /** @type {[string, unknown][]} */ ([
      ["minimumReleaseAgeExclude: ['*']", ['*']],
      ['minimumReleaseAgeExclude: [vite@8.3.3] # expires 2026-10-12', ['vite@8.3.3']],
      ['"minimumReleaseAgeExclude":\n  - vite@8.3.3 # expires 2026-10-12', ['vite@8.3.3']],
      ['minimumReleaseAgeExclude: *exempt', ['*']],
      ['minimumReleaseAgeExclude: vite@8.3.3', ['vite@8.3.3']],
    ])) {
      const { problems } = check(workspaceWith(line), applied);
      assert.ok(
        problems.some((problem) => /block list/.test(problem)),
        `${line}\n${problems.join('\n')}`,
      );
    }
  });

  test('fails on an entry whose double quotes could hide escapes', () => {
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      '  - "vit\\u0065@8.3.3" # expires 2026-10-12',
    );
    const { problems } = check(workspace, ['vite@8.3.3']);
    assert.ok(
      problems.some((problem) => /escape/.test(problem)),
      problems.join('\n'),
    );
  });

  test('fails when pnpm applies an exemption the file does not list as a dated entry', () => {
    // A key spelled with escapes, a global pnpm configuration, an environment
    // variable: what pnpm applies is what counts.
    assertOneProblem(check(workspaceWith(), ['*']).problems, /pnpm applies "\*"/);
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      '  - vite@8.3.3 # expires 2026-10-12',
    );
    assertOneProblem(
      check(workspace, ['vite@8.3.3', 'pg@8.23.2']).problems,
      /pnpm applies "pg@8\.23\.2"/,
    );
  });

  test('fails when pnpm does not apply what the file lists (the file was misread)', () => {
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      '  - vite@8.3.3 # expires 2026-10-12',
    );
    assertOneProblem(check(workspace, null).problems, /pnpm does not apply "vite@8\.3\.3"/);
  });

  test('fails on what pnpm reports when it is not a list', () => {
    assertOneProblem(check(workspaceWith(), '*').problems, /not a list/);
  });

  test('the template list this replaces (bare names, no expiry) fails entry by entry', () => {
    const names = ['@nestjs/core', 'pg', 'vite'];
    const workspace = workspaceWith(
      'minimumReleaseAgeExclude:',
      ...names.map((name) => `  - '${name}'`),
    );
    const { problems } = check(workspace, names);
    assert.equal(problems.length, names.length, problems.join('\n'));
  });
});

describe('checkReleaseSets', () => {
  const sets = {
    prisma: {
      packages: ['prisma', '@prisma/client', '@prisma/adapter-pg'],
      reason: 'The CLI generates the code the client runs.',
    },
  };

  /** @param {string} version as the lockfile resolves it, peer suffix included */
  const locked = (version) => ({ specifier: version.replace(/\(.*$/, ''), version });

  /**
   * The two documents of a pnpm lockfile: pnpm's own installation, then the workspace's.
   * @param {Record<string, import('./check-dependencies.mjs').Importer>} workspace
   */
  const lockfile = (workspace) => [{ '.': {} }, workspace];

  test('a set on one version passes, peer suffixes aside', () => {
    const importers = lockfile({
      'apps/api': {
        dependencies: {
          '@prisma/adapter-pg': locked('7.10.0'),
          '@prisma/client': locked('7.10.0(prisma@7.10.0(typescript@6.0.3))(typescript@6.0.3)'),
          prisma: locked('7.10.0(typescript@6.0.3)'),
        },
      },
    });
    assert.deepEqual(checkReleaseSets(importers, sets), []);
  });

  test('a member moved alone fails, naming each version and where it is', () => {
    const importers = lockfile({
      'apps/api': {
        dependencies: {
          '@prisma/adapter-pg': locked('7.10.1'),
          '@prisma/client': locked('7.10.1(prisma@7.10.0)'),
          prisma: locked('7.10.0'),
        },
      },
    });
    const [problem, ...rest] = checkReleaseSets(importers, sets);
    assert.deepEqual(rest, []);
    assert.match(problem ?? '', /^Release set "prisma": .* must resolve to one version/);
    assert.match(problem ?? '', /7\.10\.0 \(prisma in apps\/api\)/);
    assert.match(
      problem ?? '',
      /7\.10\.1 \(@prisma\/client in apps\/api, @prisma\/adapter-pg in apps\/api\)/,
    );
    assert.match(problem ?? '', /The CLI generates the code the client runs\.$/);
  });

  test('every workspace package and dependency type counts', () => {
    const importers = lockfile({
      'apps/api': { dependencies: { '@prisma/client': locked('7.10.0') } },
      'apps/worker': { devDependencies: { prisma: locked('7.9.1') } },
    });
    assert.match(checkReleaseSets(importers, sets)[0] ?? '', /7\.9\.1 \(prisma in apps\/worker\)/);
  });

  test('a member the workspace does not use is fine', () => {
    const importers = lockfile({
      'apps/api': {
        dependencies: { '@prisma/client': locked('7.10.0') },
        devDependencies: { prisma: locked('7.10.0') },
      },
    });
    assert.deepEqual(checkReleaseSets(importers, sets), []);
  });

  test('a set that matches no direct dependency fails', () => {
    const importers = lockfile({ 'apps/api': { dependencies: { zod: locked('4.6.7') } } });
    assert.deepEqual(checkReleaseSets(importers, sets), [
      'scripts/dependency-policy.json: the release set "prisma" applies to no direct dependency in pnpm-lock.yaml. Remove it.',
    ]);
  });

  test('a set needs two packages or more and its reason', () => {
    const importers = lockfile({ 'apps/api': { dependencies: { prisma: locked('7.10.0') } } });
    const invalid = {
      alone: { packages: ['prisma'], reason: 'One package.' },
      unexplained: { packages: ['prisma', '@prisma/client'], reason: ' ' },
    };
    assert.deepEqual(checkReleaseSets(importers, invalid), [
      'scripts/dependency-policy.json: the release set "alone" needs two packages or more and its reason.',
      'scripts/dependency-policy.json: the release set "unexplained" needs two packages or more and its reason.',
    ]);
  });
});
