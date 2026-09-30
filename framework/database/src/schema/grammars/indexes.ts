import { sql, type Expression, type Kysely } from "kysely";
import type { Blueprint } from "../blueprint.js";
import type { ColumnDefinition } from "../column-definition.js";
import type { Dialect } from "../dialect.js";
import { createIndexName } from "../index-name.js";
import { quoteBacktick, quoteDoubleQuoted } from "../quote-identifier.js";
import {
  IndexExpression,
  type IndexColumn,
  type IndexCommand,
  type IndexMethod,
} from "../types.js";

/**
 * Index compilation, shared by every grammar.
 *
 * Indexes are the one part of a `Blueprint` that no engine can express
 * inside `CREATE TABLE`: they are always separate `CREATE INDEX`
 * statements issued afterwards, and the steps to get there (resolve the
 * conventional name, fold the per-column `.unique()`/`.index()`
 * modifiers in with the table-level calls, reject what the engine cannot
 * do) are identical whether the table was built by the native-alter
 * grammar or rebuilt by SQLite's.
 *
 * So they live here rather than in each grammar. What differs per engine
 * is data, not code: an `IndexCapabilities` record the grammar declares
 * and `assertSupportedIndexes()` reads.
 */

/**
 * What one engine's indexes can do. Declared by each grammar and read by
 * `assertSupportedIndexes()`.
 *
 * | Feature | sqlite | mysql | postgres |
 * |---|---|---|---|
 * | `fullText` | no | yes | no |
 * | `where` (partial) | yes | no | yes |
 * | `using` | no | btree/hash | yes |
 * | `opclass` | no | no | yes |
 * | `nullsNotDistinct` | no | no | yes |
 */
export interface IndexCapabilities {
  dialect: Dialect;

  /** Whether this engine supports `fullText` indexes (MySQL yes, PG no). */
  supportsFullText: boolean;

  /** Whether `CREATE INDEX ... WHERE ...` exists (MySQL: no). */
  supportsPartialIndexes: boolean;

  /** Whether `USING <method>` exists (SQLite: no). */
  supportsIndexMethods: boolean;

  /** Whether a per-column operator class can be named (Postgres only). */
  supportsOperatorClasses: boolean;

  /** Whether `NULLS NOT DISTINCT` exists (Postgres 15+ only). */
  supportsNullsNotDistinct: boolean;
}

/**
 * The index methods MySQL accepts. Postgres is deliberately not
 * value-checked (`brin`, `spgist` and extension-provided methods are all
 * real); MySQL is, because its list is closed and short, so
 * `using: "gin"` reaching MySQL is a mistake worth naming rather than a
 * syntax error from the server.
 */
const MYSQL_INDEX_METHODS = new Set<IndexMethod>(["btree", "hash"]);

/**
 * An operator class name sits in a position where it is a bare
 * identifier, not a quotable one, so it cannot be escaped, only
 * validated. Anything outside this shape is rejected rather than
 * interpolated.
 */
const OPERATOR_CLASS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The index-name conventions, Laravel's `{table}_{cols}_{type}`.
 *
 * `name` is `string | true` for the ones fed from a column modifier:
 * `.unique()` records `true` (meaning "yes, but you name it") and
 * `.unique("my_name")` records the string. See `ColumnDefinition`.
 */
export function namedUnique(table: string, columns: IndexColumn[], name?: string | true): string {
  return typeof name === "string" ? name : conventionalName(table, "unique", columns);
}

export function namedIndex(table: string, columns: IndexColumn[], name?: string | true): string {
  return typeof name === "string" ? name : conventionalName(table, "index", columns);
}

/**
 * The conventional name, which only exists when every entry is a real
 * column.
 *
 * An expression has no name to contribute: feeding one through
 * `createIndexName()` would yield
 * `metas_to_tsvector('english', title)_index`, an identifier that is
 * mangled, dialect-dependent, and impossible for a `down()` to
 * reproduce. So a functional index must be named explicitly, and asking
 * for one without a name is an error rather than a surprise later.
 */
function conventionalName(table: string, type: string, columns: IndexColumn[]): string {
  const expression = columns.find((column) => column instanceof IndexExpression);

  if (expression instanceof IndexExpression) {
    throw new Error(
      `An index on the expression \`${expression.sql}\` (on "${table}") needs an explicit name: ` +
        `pass { name: "..." }, since the ${type} naming convention has only column names to work from.`,
    );
  }

  return createIndexName(table, type, columns as string[]);
}

export function namedFullText(table: string, columns: IndexColumn[], name?: string): string {
  return name ?? conventionalName(table, "fulltext", columns);
}

export function namedPrimary(table: string, columns: IndexColumn[], name?: string): string {
  // Narrowed first, so an expression here reports the reason it can
  // never work rather than the generic "needs an explicit name" — a name
  // would not help.
  return name ?? createIndexName(table, "primary", primaryKeyColumns(table, columns));
}

/**
 * The column names of a `primary()` command.
 *
 * `Blueprint.primary()` accepts only names, never an `IndexExpression`
 * (a `PRIMARY KEY` is a table constraint, so there is nothing to put an
 * expression on), but it shares `IndexCommand` with the index methods
 * that do. This narrows the list back for the constraint builders, and
 * throws rather than casting so a future caller that widens `primary()`
 * finds out here instead of emitting `[object Object]` into DDL.
 */
export function primaryKeyColumns(table: string, columns: IndexColumn[]): string[] {
  for (const column of columns) {
    if (column instanceof IndexExpression) {
      throw new Error(
        `A primary key on "${table}" cannot be an expression (\`${column.sql}\`); ` +
          `it is a table constraint, not an index.`,
      );
    }
  }

  return columns as string[];
}

export function namedForeign(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "foreign", columns);
}

/** An index's columns, for an error message: expressions as their SQL, in backticks. */
function describeColumns(columns: IndexColumn[]): string {
  return columns
    .map((column) => (column instanceof IndexExpression ? `\`${column.sql}\`` : column))
    .join(", ");
}

/**
 * Rejects, before any DDL runs, every index the engine cannot create.
 *
 * A throw rather than a silent downgrade: an index quietly created as
 * something weaker is a correctness or performance cliff nobody finds,
 * whereas a throw is found on the first migration run. Each message
 * names the dialect so the fix is obvious from the error alone.
 */
export function assertSupportedIndexes(indexes: IndexCommand[], caps: IndexCapabilities): void {
  for (const idx of indexes) {
    if (idx.kind === "fullText" && !caps.supportsFullText) {
      throw new Error(`fullText indexes are not supported on ${caps.dialect}.`);
    }

    if (idx.kind === "spatialIndex") {
      throw new Error(`spatialIndex is not supported on ${caps.dialect}.`);
    }

    const on = `on ${idx.kind}(${describeColumns(idx.columns)})`;

    if (idx.where !== undefined && !caps.supportsPartialIndexes) {
      throw new Error(
        `Partial indexes (the "where" option, ${on}) are not supported on ${caps.dialect}.`,
      );
    }

    if (idx.using !== undefined) {
      if (!caps.supportsIndexMethods) {
        throw new Error(
          `Index methods (the "using" option, ${on}) are not supported on ${caps.dialect}.`,
        );
      }

      // A closed list only on MySQL: see MYSQL_INDEX_METHODS.
      if (caps.dialect === "mysql" && !MYSQL_INDEX_METHODS.has(idx.using)) {
        throw new Error(
          `Index method "${idx.using}" (${on}) is not supported on mysql, which has only btree and hash.`,
        );
      }
    }

    if (idx.opclass !== undefined) {
      if (!caps.supportsOperatorClasses) {
        throw new Error(
          `Operator classes (the "opclass" option, ${on}) are not supported on ${caps.dialect}.`,
        );
      }

      for (const [column, opclass] of Object.entries(idx.opclass)) {
        // A key naming no indexed column would otherwise be dropped in
        // silence, and a typo there costs the index its whole point.
        // Expressions are not addressable this way: an opclass for one
        // belongs inside the expression itself, since there is no name
        // to key it by.
        if (!idx.columns.includes(column)) {
          throw new Error(
            `The "opclass" option ${on} names column "${column}", which is not part of the index.` +
              (idx.columns.some((c) => c instanceof IndexExpression)
                ? ` An expression's operator class goes inside the expression, not in "opclass".`
                : ""),
          );
        }

        if (!OPERATOR_CLASS_PATTERN.test(opclass)) {
          throw new Error(`Operator class "${opclass}" (${on}) is not a valid identifier.`);
        }
      }
    }

    if (idx.nullsNotDistinct) {
      if (!caps.supportsNullsNotDistinct) {
        throw new Error(
          `"nullsNotDistinct" (${on}) is not supported on ${caps.dialect}; it needs Postgres 15 or newer.`,
        );
      }

      // Postgres rejects it on a non-unique index, where it would mean
      // nothing anyway: distinctness is only decided for unique ones.
      if (idx.kind !== "unique") {
        throw new Error(
          `"nullsNotDistinct" (${on}) applies only to unique indexes, not "${idx.kind}".`,
        );
      }
    }
  }
}

/**
 * One index, resolved: the conventional name applied and the kind
 * flattened to flags. The shape `createIndex()` consumes.
 */
export interface PlainIndex {
  name: string;
  columns: IndexColumn[];
  unique: boolean;
  fullText?: boolean;
  where?: string;
  using?: IndexMethod;
  opclass?: Record<string, string>;
  nullsNotDistinct?: boolean;
}

/** The `IndexOptions` fields that survive from an `IndexCommand` to a `PlainIndex` unchanged. */
function indexOptionsOf(idx: IndexCommand): Omit<PlainIndex, "name" | "columns" | "unique"> {
  return {
    where: idx.where,
    using: idx.using,
    opclass: idx.opclass,
    nullsNotDistinct: idx.nullsNotDistinct,
  };
}

/**
 * Every index a blueprint asks for, from both sources: the per-column
 * `.unique()`/`.index()` modifiers on `columns`, then the table-level
 * `unique()`/`index()`/`fullText()` calls.
 *
 * `columns` is passed separately rather than read off the blueprint
 * because `compileAlter()` must only index the columns it is *adding*,
 * not the ones it is dropping in the same call.
 */
export function collectIndexes(blueprint: Blueprint, columns: ColumnDefinition[]): PlainIndex[] {
  const table = blueprint.table;
  const out: PlainIndex[] = [];

  for (const col of columns) {
    if (col.uniqueIndex) {
      out.push({
        name: namedUnique(table, [col.name], col.uniqueIndex),
        columns: [col.name],
        unique: true,
      });
    }

    if (col.nonUniqueIndex) {
      out.push({
        name: namedIndex(table, [col.name], col.nonUniqueIndex),
        columns: [col.name],
        unique: false,
      });
    }
  }

  for (const idx of blueprint.indexes) {
    if (idx.kind === "unique") {
      out.push({
        ...indexOptionsOf(idx),
        name: namedUnique(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: true,
      });
    } else if (idx.kind === "index") {
      out.push({
        ...indexOptionsOf(idx),
        name: namedIndex(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: false,
      });
    } else if (idx.kind === "fullText") {
      out.push({
        name: namedFullText(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: false,
        fullText: true,
      });
    }
  }

  return out;
}

/**
 * The index's columns as Kysely's `columns()` wants them.
 *
 * A plain name passes through as a string, which is what lets Kysely
 * quote it per dialect. The two cases that cannot are handed over as raw
 * expressions instead, because neither is a column reference Kysely can
 * build:
 *
 * - an `IndexExpression`, emitted verbatim;
 * - a column carrying an operator class, since `<column> <opclass>` is
 *   two tokens.
 *
 * `columns()` accepts expressions alongside strings, so the three mix
 * freely in one index.
 *
 * Note that a string is *never* reinterpreted as SQL here: Kysely parses
 * each one as an ordered column name (`"age desc"`), so an expression
 * smuggled in as a string fails to compile rather than being executed.
 * That is why `IndexExpression` is a distinct type and not a convention.
 */
function indexColumns(idx: PlainIndex): (string | Expression<any>)[] {
  const opclass = idx.opclass;

  return idx.columns.map((column) => {
    if (column instanceof IndexExpression) {
      return sql.raw(column.sql);
    }

    const operator = opclass?.[column];

    return operator === undefined ? column : sql.raw(`${quoteDoubleQuoted(column)} ${operator}`);
  });
}

/** Issue the `CREATE INDEX` for one collected index. */
export async function createIndex(db: Kysely<any>, table: string, idx: PlainIndex): Promise<void> {
  if (idx.fullText) {
    // Kysely has no cross-dialect fullText builder; emit raw (MySQL only).
    // `fullText()` takes no expressions, so every entry is a name.
    const cols = idx.columns.map((c) => quoteBacktick(c as string)).join(", ");
    await sql
      .raw(`CREATE FULLTEXT INDEX ${quoteBacktick(idx.name)} ON ${quoteBacktick(table)} (${cols})`)
      .execute(db);

    return;
  }

  let create: any = db.schema.createIndex(idx.name).on(table).columns(indexColumns(idx));

  if (idx.unique) {
    create = create.unique();
  }

  if (idx.using !== undefined) {
    create = create.using(idx.using);
  }

  if (idx.nullsNotDistinct) {
    create = create.nullsNotDistinct();
  }

  if (idx.where !== undefined) {
    // Raw, and necessarily so: an index predicate cannot be
    // parameterised on any of these engines, which is why
    // `IndexOptions.where` documents that it must never carry request
    // input.
    create = create.where(sql.raw(idx.where));
  }

  await create.execute();
}
