// Contract steps in the database migrations (docs/database.md#expand-and-contract).
// A release runs its migrations while the release before it still serves,
// and a rollback runs that previous release on the migrated schema: a
// migration that removes or tightens what the previous release reads or
// writes breaks both. Such a statement (a contract step) is allowed only
// with the reason it is safe now written right above it:
//
//   -- contract: release 1.4.0 stopped reading users.name; it runs everywhere
//   ALTER TABLE "users" DROP COLUMN "name";
//
// Contract steps: dropping a table, column, type or view; renaming a table,
// column or type (or an enum value); changing a column's type; making a column
// required, adding a required column without a default, or removing a
// default; emptying a table. From the migration named TIGHTENING_FROM on,
// also: a unique index or a constraint (CHECK, UNIQUE, PRIMARY KEY, FOREIGN
// KEY, EXCLUDE) added to a table an earlier migration created, unless it only
// covers columns this migration added (the previous release may write what it
// refuses, and existing rows may break it), a dropped unique index, unique
// constraint or primary key, a table moved to another schema, a DELETE without WHERE, and
// an enum value added without IF NOT EXISTS (PostgreSQL cannot drop it, so a
// migration that failed after adding it could not run again:
// docs/database.md#when-a-migration-fails). The migrations before it shipped
// before those rules, and a committed migration is never edited. Expand steps
// (new tables, nullable columns, columns with a default, indexes, looser
// constraints) need nothing. Only plain statements are read: SQL inside a DO
// block or a function body is not.
//
//   node scripts/check-migrations.mjs [<migration.sql>...]
//
// Without arguments it reads every migration of apps/api/prisma/migrations.
// It runs in `pnpm test:scripts` (CI) and on staged migrations at each commit
// (lint-staged.config.js). Exits 1 when a contract step has no reason.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url));

/** The first migration the tightening rules apply to (by directory name). */
export const TIGHTENING_FROM = '20261022000000';

const ENUM_VALUE = 'adds an enum value without IF NOT EXISTS';

/**
 * One SQL statement: its first line number, the comments before it, and its
 * code with comments removed, strings emptied, quoted identifiers replaced by
 * "_", whitespace collapsed and letters in upper case (what the rules read).
 * @typedef {{ line: number; comments: string; code: string; text: string }} Statement
 */

/**
 * Splits a migration into statements. Understands what PostgreSQL does:
 * line and nested block comments, string constants (with '' and E'\''),
 * quoted identifiers and dollar-quoted bodies.
 * @param {string} sql
 * @returns {Statement[]}
 */
export function splitStatements(sql) {
  /** @type {Statement[]} */
  const statements = [];
  let comments = '';
  let code = '';
  let start = -1;
  let first = 0;
  let line = 1;
  let i = 0;

  const finish = (/** @type {number} */ end) => {
    if (start >= 0) {
      statements.push({
        line: first,
        comments,
        code: code.replace(/\s+/g, ' ').trim().toUpperCase(),
        text: sql.slice(start, end).trim(),
      });
    }
    comments = '';
    code = '';
    start = -1;
  };
  /** Advances to `end` (exclusive), counting lines. */
  const skipTo = (/** @type {number} */ end) => {
    for (; i < end; i++) if (sql[i] === '\n') line += 1;
  };

  while (i < sql.length) {
    const c = sql[i] ?? '';
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      if (start < 0) comments += `${sql.slice(i, stop)}\n`;
      skipTo(stop);
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      if (start < 0) comments += `${sql.slice(i, j)}\n`;
      skipTo(j);
      continue;
    }
    if (/\s/.test(c)) {
      code += ' ';
      skipTo(i + 1);
      continue;
    }
    if (c === ';') {
      finish(i + 1);
      skipTo(i + 1);
      continue;
    }
    if (start < 0) {
      start = i;
      first = line;
    }
    if (c === "'") {
      // E'...' strings take backslash escapes; standard ones only ''.
      const escapes = /(^|[^A-Za-z0-9_])E$/i.test(code);
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      code += "''";
      skipTo(j + 1);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      code += '"_"';
      skipTo(j + 1);
      continue;
    }
    const tag = c === '$' ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i)) : null;
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      code += '$$';
      skipTo(end === -1 ? sql.length : end + tag[0].length);
      continue;
    }
    code += c;
    skipTo(i + 1);
  }
  finish(sql.length);
  return statements;
}

// A name, maybe schema-qualified, as splitStatements leaves it.
const NAME = String.raw`(?:"_"|[A-Z_][A-Z0-9_$]*)(?:\.(?:"_"|[A-Z_][A-Z0-9_$]*))*`;

/**
 * The actions of an ALTER TABLE, split at the commas outside parentheses.
 * @param {string} code
 */
function alterTableActions(code) {
  const rest = code.replace(new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${NAME} ?`), '');
  /** @type {string[]} */
  const actions = [];
  let depth = 0;
  let current = '';
  for (const c of rest) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      actions.push(current.trim());
      current = '';
    } else current += c;
  }
  actions.push(current.trim());
  return actions;
}

/** @type {[RegExp, string][]} */
const ALTER_TABLE_RULES = [
  [/^DROP (?!CONSTRAINT\b)/, 'drops a column'],
  [new RegExp(`^RENAME (?:COLUMN )?${NAME} TO\\b|^RENAME TO\\b`), 'renames a column or a table'],
  [new RegExp(`^ALTER (?:COLUMN )?${NAME} (?:SET DATA )?TYPE\\b`), "changes a column's type"],
  [new RegExp(`^ALTER (?:COLUMN )?${NAME} SET NOT NULL\\b`), 'makes a column required'],
  [new RegExp(`^ALTER (?:COLUMN )?${NAME} DROP DEFAULT\\b`), "removes a column's default"],
];

/**
 * What a statement does that the previous release may not survive, if
 * anything.
 * @param {string} code a Statement's code
 * @returns {string[]}
 */
function contractKinds(code) {
  const drop =
    /^DROP (TABLE|VIEW|MATERIALIZED VIEW|TYPE|DOMAIN|SEQUENCE|SCHEMA|FUNCTION|PROCEDURE)\b/.exec(
      code,
    );
  if (drop) return [`drops a ${(drop[1] ?? '').toLowerCase()}`];
  if (/^TRUNCATE\b/.test(code)) return ['empties a table'];
  if (/^ALTER TYPE\b.*\bRENAME\b/.test(code)) return ['renames a type or one of its values'];
  if (!/^ALTER TABLE\b/.test(code)) return [];
  return alterTableActions(code).flatMap((action) => {
    for (const [pattern, kind] of ALTER_TABLE_RULES) if (pattern.test(action)) return [kind];
    const required =
      /^ADD (?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)/.test(action) &&
      /\bNOT NULL\b/.test(action) &&
      !/\b(?:DEFAULT|GENERATED)\b/.test(action);
    return required ? ['adds a required column without a default'] : [];
  });
}

// An identifier, quoted or not, and a name made of them (schema.table), in a
// statement as written.
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

/**
 * The table a statement names right after `prefix`, as PostgreSQL resolves
 * it: unquoted names folded to lower case, quoted ones as written, the schema
 * left out ("users", public.users and USERS are users).
 * @param {string} text the statement as written
 * @param {RegExp} prefix what comes before the name
 */
function tableIn(text, prefix) {
  const match = new RegExp(`^${QUALIFIED}`).exec(text.replace(prefix, ''));
  return match === null ? undefined : lastPart(match[0]);
}

/**
 * An identifier as PostgreSQL resolves it: unquoted folded to lower case.
 * @param {string} raw
 */
function identifier(raw) {
  const name = raw.trim();
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

/**
 * The last part of a qualified name (public.users is users).
 * @param {string} qualified
 */
function lastPart(qualified) {
  return identifier(qualified.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).at(-1) ?? '');
}

/**
 * `text` split at the commas outside parentheses, quotes and strings.
 * @param {string} text
 */
function splitTopLevel(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const c of text) {
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current.trim().replace(/;$/, '').trim());
  return parts.filter((part) => part !== '');
}

/**
 * The plain column names of the parenthesized list `text` starts with;
 * undefined when an item is an expression (it cannot be told what it reads).
 * @param {string} text
 */
function columnsOf(text) {
  const list = /^\s*\(([\s\S]*?)\)/.exec(text)?.[1];
  if (list === undefined) return undefined;
  const item = new RegExp(`^(${IDENT})(?:\\s+(?:ASC|DESC|NULLS\\s+(?:FIRST|LAST)))*$`, 'i');
  const names = [];
  for (const part of splitTopLevel(list)) {
    const match = item.exec(part);
    if (match === null) return undefined;
    names.push(identifier(match[1] ?? ''));
  }
  return names;
}

/**
 * The tightening steps of a statement (TIGHTENING_FROM): `created` holds the
 * tables this migration created before it, `added` the columns it added to
 * existing ones; nothing writes either yet.
 * @param {Statement} statement
 * @param {Set<string>} created
 * @param {Map<string, Set<string>>} added
 * @returns {string[]}
 */
function tighteningKinds({ code, text }, created, added) {
  if (/^CREATE UNIQUE INDEX\b/.test(code)) {
    const index = new RegExp(
      String.raw`^\s*CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s+)?ON\s+(?:ONLY\s+)?(${QUALIFIED})\s*(?:USING\s+\w+\s*)?([\s\S]*)$`,
      'i',
    ).exec(text);
    const table = index === null ? undefined : lastPart(index[1] ?? '');
    const columns = index === null ? undefined : columnsOf(index[2] ?? '');
    return onlyNew(table, columns, created, added)
      ? []
      : ['adds a unique index to an existing table'];
  }
  // Prisma names a unique index <table>_<columns>_key: the previous release may
  // rely on it (an upsert's conflict target). Other indexes only cost speed.
  if (/^DROP INDEX\b/.test(code)) {
    const names = text
      .replace(/^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?/i, '')
      .replace(/\s*(?:CASCADE|RESTRICT)?\s*;?\s*$/i, '');
    return splitTopLevel(names).some((name) => lastPart(name).endsWith('_key'))
      ? ['drops a unique index']
      : [];
  }
  if (/^DELETE FROM\b/.test(code) && !/\bWHERE\b/.test(code)) return ['empties a table'];
  if (/^ALTER TYPE\b.*\bADD VALUE\b/.test(code) && !/\bADD VALUE IF NOT EXISTS\b/.test(code)) {
    return [ENUM_VALUE];
  }
  const altered = alterTableOf(text);
  if (altered === undefined) return [];
  const drop = new RegExp(String.raw`^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, 'i');
  const add = new RegExp(
    String.raw`^ADD\s+(?:CONSTRAINT\s+${IDENT}\s+)?(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b([\s\S]*)$`,
    'i',
  );
  return altered.actions.flatMap((action) => {
    if (/^SET\s+SCHEMA\b/i.test(action)) return ['moves a table to another schema'];
    const dropped = drop.exec(action);
    if (dropped !== null) {
      const name = identifier(dropped[1] ?? '');
      if (name.endsWith('_pkey')) return ['drops a primary key'];
      return name.endsWith('_key') ? ['drops a unique constraint'] : [];
    }
    const constraint = add.exec(action);
    if (constraint === null) return [];
    // A CHECK or an EXCLUDE reads an expression: what it covers is not told.
    const kind = (constraint[1] ?? '').toUpperCase();
    const columns = /^(?:UNIQUE|PRIMARY|FOREIGN)/.test(kind)
      ? columnsOf(constraint[2] ?? '')
      : undefined;
    return onlyNew(altered.table, columns, created, added)
      ? []
      : ['adds a constraint to an existing table'];
  });
}

/**
 * The table and the actions (as written) of an ALTER TABLE; undefined for
 * any other statement.
 * @param {string} text
 */
function alterTableOf(text) {
  const match = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s*([\s\S]*)$`,
    'i',
  ).exec(text);
  if (match === null) return undefined;
  return { table: lastPart(match[1] ?? ''), actions: splitTopLevel(match[2] ?? '') };
}

/**
 * Whether a unique index or a constraint only covers what nothing wrote
 * before this migration: a table it created, or columns it added (a new
 * nullable relation's index and foreign key, for instance).
 * @param {string | undefined} table
 * @param {string[] | undefined} columns
 * @param {Set<string>} created
 * @param {Map<string, Set<string>>} added
 */
function onlyNew(table, columns, created, added) {
  if (table === undefined) return false;
  if (created.has(table)) return true;
  const fresh = added.get(table);
  return (
    columns !== undefined &&
    columns.length > 0 &&
    fresh !== undefined &&
    columns.every((column) => fresh.has(column))
  );
}

/**
 * Records the columns an ALTER TABLE adds, by table.
 * @param {string} text
 * @param {Map<string, Set<string>>} added
 */
function recordAddedColumns(text, added) {
  const altered = alterTableOf(text);
  if (altered === undefined) return;
  const column = new RegExp(
    String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
    'i',
  );
  for (const action of altered.actions) {
    const name = column.exec(action)?.[1];
    if (name === undefined || /^(?:CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN|EXCLUDE)$/i.test(name)) {
      continue;
    }
    const columns = added.get(altered.table) ?? new Set();
    columns.add(identifier(name));
    added.set(altered.table, columns);
  }
}

/**
 * The contract steps of a migration, each with the reason written right
 * above its statement (`-- contract: <why>`), if any.
 * @param {string} sql
 * @param {{ tightening?: boolean }} [options] whether the tightening rules
 *   apply (TIGHTENING_FROM): from the migration's directory name
 * @returns {{ kind: string; line: number; text: string; reason: string | undefined }[]}
 */
export function contractSteps(sql, { tightening = true } = {}) {
  /** Tables this migration creates: new, so nothing writes them yet. */
  const created = new Set();
  /** Columns this migration adds to existing tables, by table: new too. */
  const added = new Map();
  return splitStatements(sql).flatMap((statement) => {
    const reason = /^\s*--\s*contract:[ \t]*(\S.*?)\s*$/im.exec(statement.comments)?.[1];
    const text = statement.text.split('\n')[0] ?? '';
    if (/^CREATE (?:UNLOGGED )?TABLE\b/.test(statement.code)) {
      const table = tableIn(
        statement.text,
        /^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
      );
      if (table !== undefined) created.add(table);
    }
    recordAddedColumns(statement.text, added);
    const kinds = [
      ...contractKinds(statement.code),
      ...(tightening ? tighteningKinds(statement, created, added) : []),
    ];
    return kinds.map((kind) => ({
      kind,
      line: statement.line,
      text,
      reason,
    }));
  });
}

/**
 * Checks migration files: contract steps without a reason are problems; the
 * acknowledged ones are listed for the reviewer.
 * @param {{ path: string; label: string }[]} files
 */
function checkFiles(files) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const acknowledged = [];
  for (const { path, label } of files) {
    const migration = basename(dirname(path));
    const tightening = !/^\d{14}_/.test(migration) || migration >= TIGHTENING_FROM;
    for (const step of contractSteps(readFileSync(path, 'utf8'), { tightening })) {
      if (step.reason === undefined && step.kind === ENUM_VALUE) {
        problems.push(
          `${label}:${String(step.line)}: ${step.kind}: ${step.text} PostgreSQL cannot drop an enum ` +
            'value, and runs no Prisma migration in a transaction: if a later statement fails, the ' +
            'migration cannot run again (docs/database.md#when-a-migration-fails). Write ADD VALUE ' +
            'IF NOT EXISTS: create the migration with `pnpm db:migrate --name <name> --create-only`, ' +
            'edit it, then `pnpm db:migrate` (edited after it was applied to your development ' +
            'database, `migrate dev` offers to reset that database).',
        );
      } else if (step.reason === undefined) {
        problems.push(
          `${label}:${String(step.line)}: ${step.kind}: ${step.text} The release before this one may ` +
            'still use what it removes or tightens, and a rollback runs it on this schema ' +
            '(docs/database.md#expand-and-contract). Ship it one release after the code stopped ' +
            'needing it, with the reason right above the statement: -- contract: <why it is safe now>',
        );
      } else {
        acknowledged.push(`${label}:${String(step.line)}: ${step.kind} (contract: ${step.reason})`);
      }
    }
  }
  return { problems, acknowledged };
}

/**
 * Every migration of a Prisma migrations directory.
 * @param {string} dir
 */
export function checkMigrations(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ path: join(dir, name, 'migration.sql'), label: `${name}/migration.sql` }));
  return checkFiles(files);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const { problems, acknowledged } =
    args.length === 0
      ? checkMigrations(MIGRATIONS)
      : checkFiles(args.map((path) => ({ path, label: relative(process.cwd(), path) })));
  for (const line of acknowledged) console.log(`Contract step: ${line}`);
  for (const line of problems) console.error(line);
  if (problems.length > 0) {
    console.error(`${String(problems.length)} contract step(s) without a reason.`);
    process.exit(1);
  }
}
