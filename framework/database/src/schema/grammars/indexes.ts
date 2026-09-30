import { sql, type Kysely } from "kysely";
import type { Blueprint } from "../blueprint.js";
import type { ColumnDefinition } from "../column-definition.js";
import type { Dialect } from "../dialect.js";
import { createIndexName } from "../index-name.js";
import { quoteBacktick } from "../quote-identifier.js";
import type { IndexCommand } from "../types.js";

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

/** What one engine's indexes can do. Declared by each grammar. */
export interface IndexCapabilities {
  dialect: Dialect;

  /** Whether this engine supports `fullText` indexes (MySQL yes, PG no). */
  supportsFullText: boolean;
}

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
        name: namedUnique(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: true,
      });
    } else if (idx.kind === "index") {
      out.push({
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

  let create: any = db.schema.createIndex(idx.name).on(table).columns(idx.columns);

  if (idx.unique) {
    create = create.unique();
  }

  await create.execute();
}
