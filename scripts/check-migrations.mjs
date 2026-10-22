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
// KEY, EXCLUDE, in the table or in a column's definition) added to a table an
// earlier migration created (the previous release may write what it refuses,
// and existing rows may break it), unless it is a unique index, a UNIQUE or a
// foreign key that gives way to the rows it references (yieldsToReferenced),
// covering only columns this migration added empty (nullable, no default now
// or later, the table not written: recordAddedColumns), never with NULLS NOT
// DISTINCT; a dropped unique index, unique constraint or
// primary key, a table moved to another schema, a DELETE without WHERE, and
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
 * One SQL statement: its first line number, the comments before it, its code
 * with comments removed, strings emptied, quoted identifiers replaced by "_",
 * whitespace collapsed and letters in upper case (what the rules read), its
 * bare form (the same, but identifiers and letters as written: where the
 * rules read names), and its text as written.
 * @typedef {{ line: number; comments: string; code: string; bare: string; text: string }} Statement
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
  let bare = '';
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
        bare: bare.replace(/\s+/g, ' ').trim(),
        text: sql.slice(start, end).trim(),
      });
    }
    comments = '';
    code = '';
    bare = '';
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
      else {
        // Inside a statement a comment separates like whitespace.
        code += ' ';
        bare += ' ';
      }
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
      else {
        code += ' ';
        bare += ' ';
      }
      skipTo(j);
      continue;
    }
    if (/\s/.test(c)) {
      code += ' ';
      bare += ' ';
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
      bare += "''";
      skipTo(j + 1);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      code += '"_"';
      bare += sql.slice(i, j + 1);
      skipTo(j + 1);
      continue;
    }
    const tag = c === '$' ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i)) : null;
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      code += '$$';
      bare += '$$';
      skipTo(end === -1 ? sql.length : end + tag[0].length);
      continue;
    }
    code += c;
    bare += c;
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
 * @param {string} text a Statement's bare form
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
 * `text` split at the commas outside parentheses, quotes and strings. Reads a
 * bare form: no comments, strings emptied (no escapes left to follow).
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
 * existing ones, empty (recordAddedColumns); nothing writes either yet.
 * @param {Statement} statement
 * @param {Set<string>} created
 * @param {Map<string, Set<string>>} added
 * @returns {string[]}
 */
function tighteningKinds({ code, bare }, created, added) {
  if (/^CREATE UNIQUE INDEX\b/.test(code)) {
    const index = new RegExp(
      String.raw`^\s*CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s+)?ON\s+(?:ONLY\s+)?(${QUALIFIED})\s*(?:USING\s+\w+\s*)?([\s\S]*)$`,
      'i',
    ).exec(bare);
    const table = index === null ? undefined : lastPart(index[1] ?? '');
    // NULLS NOT DISTINCT: the NULLs of new columns collide.
    const columns =
      index === null || /\bNULLS\s+NOT\s+DISTINCT\b/i.test(index[2] ?? '')
        ? undefined
        : columnsOf(index[2] ?? '');
    return onlyNew(table, columns, created, added)
      ? []
      : ['adds a unique index to an existing table'];
  }
  // Prisma names a unique index <table>_<columns>_key: the previous release may
  // rely on it (an upsert's conflict target). Other indexes only cost speed.
  if (/^DROP INDEX\b/.test(code)) {
    const names = bare
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
  const altered = alterTableOf(bare);
  if (altered === undefined) return [];
  const drop = new RegExp(String.raw`^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, 'i');
  const add = new RegExp(
    String.raw`^ADD\s+(?:CONSTRAINT\s+${IDENT}\s+)?(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b([\s\S]*)$`,
    'i',
  );
  return altered.actions.flatMap((action) => {
    if (/^SET\s+SCHEMA\b/i.test(action)) return ['moves a table to another schema'];
    // A constraint written in the column's definition: safe only on a column
    // that holds nothing yet (recordAddedColumns: no default, never written),
    // as a UNIQUE whose NULLs stay distinct or a foreign key that gives way to
    // the referenced table (yieldsToReferenced). A CHECK may read other
    // columns; a primary key makes the column required.
    const column = ADD_COLUMN.exec(action);
    if (column !== null && !CONSTRAINT_WORD.test(column[1] ?? '')) {
      const named = quotedNamesOut(column[2] ?? '');
      const definition = withoutNames(column[2] ?? '');
      const inline = [...definition.matchAll(/\b(UNIQUE|PRIMARY\s+KEY|REFERENCES|CHECK)\b/gi)];
      if (inline.length === 0 || created.has(altered.table)) return [];
      const empty = added.get(altered.table)?.has(identifier(column[1] ?? '')) === true;
      const safe =
        empty &&
        !/\bNULLS\s+NOT\s+DISTINCT\b/i.test(definition) &&
        inline.every(
          ([, word = '']) =>
            /^UNIQUE$/i.test(word) || (/^REFERENCES$/i.test(word) && yieldsToReferenced(named)),
        );
      return safe ? [] : ['adds a constraint to an existing table'];
    }
    const dropped = drop.exec(action);
    if (dropped !== null) {
      const name = identifier(dropped[1] ?? '');
      if (name.endsWith('_pkey')) return ['drops a primary key'];
      return name.endsWith('_key') ? ['drops a unique constraint'] : [];
    }
    const constraint = add.exec(action);
    if (constraint === null) return [];
    // A CHECK or an EXCLUDE reads an expression: what it covers is not told.
    // A primary key makes its columns required: new ones too, which hold NULL.
    // A foreign key that does not give way blocks the previous release's
    // deletes of the rows it references. columnsOf reads a column list only:
    // UNIQUE NULLS NOT DISTINCT (whose NULLs collide) is never exempt.
    const kind = (constraint[1] ?? '').toUpperCase();
    const rest = (constraint[2] ?? '').replace(/^\s*NULLS\s+DISTINCT\b/i, '');
    const columns =
      /^UNIQUE/.test(kind) || (/^FOREIGN/.test(kind) && yieldsToReferenced(quotedNamesOut(rest)))
        ? columnsOf(rest)
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

// An ADD COLUMN action: the column's name and the rest of its definition.
const ADD_COLUMN = new RegExp(
  String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})(?:\s+([\s\S]*))?$`,
  'i',
);
// What starts a table constraint rather than a column, after ADD.
const CONSTRAINT_WORD = /^(?:CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN|EXCLUDE)$/i;
// A definition that puts a value in every existing row: a default (other
// than NULL), a generated or identity value, a serial type; and NOT NULL,
// which no existing row could satisfy otherwise. Read without its quoted
// names (withoutNames).
const FILLED =
  /\b(?:NOT\s+NULL|DEFAULT(?!\s+\(*\s*NULL\b)|GENERATED|IDENTITY|(?:SMALL|BIG)?SERIAL[248]?)\b/i;

/**
 * A definition with its quoted names (REFERENCES "identity", COLLATE
 * "default") out of the way of keywords.
 * @param {string} definition
 */
function quotedNamesOut(definition) {
  return definition.replace(/"(?:[^"]|"")*"/g, '"_"');
}

/**
 * A column definition without what only looks like a keyword: quoted names
 * and a foreign key's ON DELETE or ON UPDATE SET DEFAULT.
 * @param {string} definition
 */
function withoutNames(definition) {
  return quotedNamesOut(definition).replace(/\bON\s+(?:DELETE|UPDATE)\s+SET\s+DEFAULT\b/gi, '');
}

// A referential action that gives way to the referenced row.
const GIVES_WAY = String.raw`(?:SET\s+NULL|SET\s+DEFAULT|CASCADE)\b`;

/**
 * Whether a foreign key gives way to the referenced table on both a delete
 * and an update (ON DELETE and ON UPDATE SET NULL, SET DEFAULT or CASCADE):
 * otherwise (RESTRICT, NO ACTION, the default) it refuses the previous
 * release's deletes of rows the new release references.
 * @param {string} text the key's definition, quoted names out
 */
function yieldsToReferenced(text) {
  return (
    new RegExp(String.raw`\bON\s+DELETE\s+${GIVES_WAY}`, 'i').test(text) &&
    new RegExp(String.raw`\bON\s+UPDATE\s+${GIVES_WAY}`, 'i').test(text)
  );
}

/**
 * Records the columns an ALTER TABLE adds that hold nothing yet (nullable,
 * nothing fills them), by table, unless the migration writes that table
 * (`written`: an UPDATE or an INSERT fills them too, before or after) or gives
 * the column a default later (`defaulted`, table.column: the previous
 * release's rows then get it), or types it with a domain that has a default
 * (`domains`). ADD COLUMN IF NOT EXISTS may find the column there already.
 * @param {string} bare a Statement's bare form
 * @param {Map<string, Set<string>>} added
 * @param {Set<string>} written
 * @param {Set<string>} defaulted
 * @param {Set<string>} domains
 */
function recordAddedColumns(bare, added, written, defaulted, domains) {
  const altered = alterTableOf(bare);
  if (altered === undefined || written.has(altered.table)) return;
  for (const action of altered.actions) {
    // IF NOT EXISTS: the column may be there already, with its data.
    if (/^ADD\s+(?:COLUMN\s+)?IF\s+NOT\s+EXISTS\b/i.test(action)) continue;
    const column = ADD_COLUMN.exec(action);
    const name = column?.[1];
    if (name === undefined || CONSTRAINT_WORD.test(name)) continue;
    const id = identifier(name);
    const definition = column?.[2] ?? '';
    const type = new RegExp(String.raw`^\s*(${QUALIFIED})`).exec(definition)?.[1];
    if (
      FILLED.test(withoutNames(definition)) ||
      defaulted.has(`${altered.table}.${id}`) ||
      (type !== undefined && domains.has(lastPart(type)))
    ) {
      continue;
    }
    const columns = added.get(altered.table) ?? new Set();
    columns.add(id);
    added.set(altered.table, columns);
  }
}

/**
 * The tables a statement writes rows of: the one it starts with (UPDATE,
 * INSERT, MERGE, COPY FROM), or, led by WITH, EXPLAIN, PREPARE or a rule, any
 * it holds. A write inside a function, a procedure (CALL) or a trigger is not
 * seen (docs/database.md).
 * @param {string} bare a Statement's bare form
 * @returns {string[]}
 */
function writtenTables(bare) {
  const write = String.raw`(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|MERGE\s+INTO\s+(?:ONLY\s+)?)(${QUALIFIED})`;
  // Led by WITH, EXPLAIN (ANALYZE runs it), PREPARE (and its EXECUTE) or a
  // rule: any write it holds.
  if (/^\s*(?:WITH|EXPLAIN|PREPARE|CREATE\s+(?:OR\s+REPLACE\s+)?RULE)\b/i.test(bare)) {
    return [...bare.matchAll(new RegExp(String.raw`\b${write}`, 'gi'))].map(([, table = '']) =>
      lastPart(table),
    );
  }
  const match = new RegExp(String.raw`^\s*${write}`, 'i').exec(bare);
  if (match !== null) return [lastPart(match[1] ?? '')];
  const copied = new RegExp(String.raw`^\s*COPY\s+(${QUALIFIED})[\s\S]*\bFROM\b`, 'i').exec(bare);
  return copied === null ? [] : [lastPart(copied[1] ?? '')];
}

/**
 * The columns an ALTER TABLE gives a default (other than NULL), as
 * table.column.
 * @param {string} bare a Statement's bare form
 * @returns {string[]}
 */
function defaultedColumns(bare) {
  const altered = alterTableOf(bare);
  if (altered === undefined) return [];
  const set = new RegExp(
    String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+SET\s+DEFAULT\b(?!\s+\(*\s*NULL\b)`,
    'i',
  );
  return altered.actions.flatMap((action) => {
    const name = set.exec(action)?.[1];
    return name === undefined ? [] : [`${altered.table}.${identifier(name)}`];
  });
}

/**
 * The contract steps of a migration, each with the reason written right
 * above its statement (`-- contract: <why>`), if any.
 * @param {string} sql
 * @param {{ tightening?: boolean; domains?: Set<string> }} [options] whether the
 *   tightening rules apply (TIGHTENING_FROM): from the migration's directory
 *   name; the domains with a default the migrations before it created
 * @returns {{ kind: string; line: number; text: string; reason: string | undefined }[]}
 */
export function contractSteps(sql, { tightening = true, domains = new Set() } = {}) {
  /** Tables this migration creates: new, so nothing writes them yet. */
  const created = new Set();
  /** Columns this migration adds to existing tables, empty, by table: new too. */
  const added = new Map();
  const statements = splitStatements(sql);
  /** Tables whose rows this migration writes: their new columns are filled. */
  const written = new Set(statements.flatMap(({ bare }) => writtenTables(bare)));
  /** Columns this migration gives a default: filled from then on. */
  const defaulted = new Set(statements.flatMap(({ bare }) => defaultedColumns(bare)));
  /** Domains with a default: earlier migrations' (`domains`) and this one's. */
  const filling = domainDefaults(sql, new Set(domains));
  return statements.flatMap((statement) => {
    const reason = /^\s*--\s*contract:[ \t]*(\S.*?)\s*$/im.exec(statement.comments)?.[1];
    const text = statement.text.split('\n')[0] ?? '';
    if (/^CREATE (?:UNLOGGED )?TABLE\b/.test(statement.code)) {
      const table = tableIn(
        statement.bare,
        /^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
      );
      if (table !== undefined) created.add(table);
    }
    recordAddedColumns(statement.bare, added, written, defaulted, filling);
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
 * The domains with a default once a migration ran, from those before it
 * (`domains`, updated in place): a column typed with one is filled.
 * @param {string} sql
 * @param {Set<string>} [domains]
 * @returns {Set<string>}
 */
export function domainDefaults(sql, domains = new Set()) {
  const create = new RegExp(String.raw`^\s*CREATE\s+DOMAIN\s+(${QUALIFIED})\b([\s\S]*)$`, 'i');
  const alter = new RegExp(
    String.raw`^\s*ALTER\s+DOMAIN\s+(${QUALIFIED})\s+(SET\s+DEFAULT\b(?!\s+\(*\s*NULL\b)|DROP\s+DEFAULT\b)`,
    'i',
  );
  for (const { bare } of splitStatements(sql)) {
    const created = create.exec(bare);
    if (created !== null) {
      if (/\bDEFAULT\b(?!\s+\(*\s*NULL\b)/i.test(created[2] ?? '')) {
        domains.add(lastPart(created[1] ?? ''));
      }
      continue;
    }
    const altered = alter.exec(bare);
    if (altered === null) continue;
    if (/^SET/i.test(altered[2] ?? '')) domains.add(lastPart(altered[1] ?? ''));
    else domains.delete(lastPart(altered[1] ?? ''));
  }
  return domains;
}

/**
 * Checks migration files, in order: contract steps without a reason are
 * problems; the acknowledged ones are listed for the reviewer. `domains`: the
 * domains with a default the migrations before the first file created
 * (updated as the files are read).
 * @param {{ path: string; label: string }[]} files
 * @param {Set<string>} [domains]
 */
function checkFiles(files, domains = new Set()) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const acknowledged = [];
  for (const { path, label } of files) {
    const migration = basename(dirname(path));
    const tightening = !/^\d{14}_/.test(migration) || migration >= TIGHTENING_FROM;
    const sql = readFileSync(path, 'utf8');
    const steps = contractSteps(sql, { tightening, domains });
    domainDefaults(sql, domains);
    for (const step of steps) {
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
  const staged = args.map((path) => ({ path, label: relative(process.cwd(), path) }));
  // Staged migrations only (the commit hook): the committed ones before them
  // tell which domains have a default.
  const first = staged.map(({ path }) => basename(dirname(path))).sort()[0] ?? '';
  const domains = new Set();
  if (args.length > 0 && existsSync(MIGRATIONS)) {
    for (const name of readdirSync(MIGRATIONS).sort()) {
      const path = join(MIGRATIONS, name, 'migration.sql');
      if (name < first && existsSync(path)) domainDefaults(readFileSync(path, 'utf8'), domains);
    }
  }
  const { problems, acknowledged } =
    args.length === 0 ? checkMigrations(MIGRATIONS) : checkFiles(staged, domains);
  for (const line of acknowledged) console.log(`Contract step: ${line}`);
  for (const line of problems) console.error(line);
  if (problems.length > 0) {
    console.error(`${String(problems.length)} contract step(s) without a reason.`);
    process.exit(1);
  }
}
