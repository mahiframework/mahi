import { sql, type Expression, type Kysely } from "kysely";
import type { Blueprint } from "../blueprint.js";
import type { ColumnDefinition } from "../column-definition.js";
import type { Dialect } from "../dialect.js";
import { createIndexName } from "../index-name.js";
import { quoteBacktick, quoteDoubleQuoted } from "../quote-identifier.js";
import type { IndexCommand, IndexMethod } from "../types.js";

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
export function namedUnique(table: string, columns: string[], name?: string | true): string {
  return typeof name === "string" ? name : createIndexName(table, "unique", columns);
}

export function namedIndex(table: string, columns: string[], name?: string | true): string {
  return typeof name === "string" ? name : createIndexName(table, "index", columns);
}

export function namedFullText(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "fulltext", columns);
}

export function namedPrimary(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "primary", columns);
}

export function namedForeign(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "foreign", columns);
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

    const on = `on ${idx.kind}(${idx.columns.join(", ")})`;

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
        if (!idx.columns.includes(column)) {
          throw new Error(
            `The "opclass" option ${on} names column "${column}", which is not part of the index.`,
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
  columns: string[];
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
 * The index's columns as Kysely's `columns()` wants them: plain strings
 * normally, and a raw expression for any column carrying an operator
 * class, since `<column> <opclass>` is not a column reference Kysely can
 * build. `columns()` takes expressions alongside strings, so the two mix
 * freely.
 *
 * The column name is quoted; the operator class is validated instead
 * (see `OPERATOR_CLASS_PATTERN`), because in that position it is a bare
 * identifier rather than a quotable one.
 */
function indexColumns(idx: PlainIndex): (string | Expression<any>)[] {
  const opclass = idx.opclass;

  if (!opclass) {
    return idx.columns;
  }

  return idx.columns.map((column) => {
    const operator = opclass[column];

    return operator === undefined ? column : sql.raw(`${quoteDoubleQuoted(column)} ${operator}`);
  });
}

/** Issue the `CREATE INDEX` for one collected index. */
export async function createIndex(db: Kysely<any>, table: string, idx: PlainIndex): Promise<void> {
  if (idx.fullText) {
    // Kysely has no cross-dialect fullText builder; emit raw (MySQL only).
    const cols = idx.columns.map((c) => quoteBacktick(c)).join(", ");
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
