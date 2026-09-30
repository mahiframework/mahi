import { sql, type Expression } from "kysely";
import type { DatePart, GrammarBinding, JsonColumn, QueryGrammar } from "./grammar.js";

/** `{ field: "meta", segments: ["a", "b"] }` → `"$.a.b"`, the JSONPath MySQL's `json_*` functions take. */
function jsonPath(column: JsonColumn): string {
  return column.segments.length > 0 ? `$.${column.segments.join(".")}` : "$";
}

/**
 * MySQL (and MariaDB) query grammar.
 *
 * Date components use MySQL's own per-component functions
 * (`date()`/`time()`/`day()`/`month()`/`year()`) rather than SQLite's
 * `strftime()`, which does not exist here.
 *
 * `day()`/`month()` return an unpadded number (`3` for March), while
 * `whereMonth()` compares against the zero-padded string SQLite's
 * `strftime('%m')` produces and Laravel's convention uses (`"03"`), so
 * they are cast to text and left-padded to two digits. `year()` is
 * already four digits and only needs the cast.
 *
 * Case-insensitive `LIKE` goes through `lower()` on both sides rather
 * than a named collation, so it holds under a `*_bin` column too. See
 * `like()`.
 *
 * JSON goes through `json_contains()`/`json_contains_path()`/
 * `json_length()`. `json_contains()` takes its candidate as a **JSON
 * document**, so the scalar is `JSON.stringify`d. An unquoted `x`
 * is not valid JSON and MySQL rejects it.
 *
 * Upserts use `ON DUPLICATE KEY UPDATE`, which, unlike Postgres/SQLite,
 * names no conflict target (any unique index triggers it) and reads
 * the pending row through `VALUES(col)` rather than `excluded.col`.
 */
export const mysqlQueryGrammar: QueryGrammar = {
  dialect: "mysql",
  supportsRowLocks: true,

  datePart(part: DatePart, column: string): Expression<any> {
    const ref = sql.ref(column);
    switch (part) {
      case "date":
        return sql`date(${ref})`;
      case "time":
        return sql`time(${ref})`;
      case "day":
        return sql`lpad(cast(day(${ref}) as char), 2, '0')`;
      case "month":
        return sql`lpad(cast(month(${ref}) as char), 2, '0')`;
      case "year":
        return sql`cast(year(${ref}) as char)`;
    }
  },

  like(
    column: string,
    pattern: GrammarBinding,
    options: { caseInsensitive: boolean },
  ): Expression<any> {
    if (options.caseInsensitive) {
      // Both sides through lower() rather than `COLLATE utf8mb4_ci`:
      // folding this way is collation-independent, so it holds under a
      // `*_bin`/`*_cs` column too, and it assumes nothing about the
      // column's charset the way naming a collation would.
      return sql`lower(${sql.ref(column)}) like lower(${pattern})`;
    }

    // MySQL has no per-query case-*sensitive* form worth using either:
    // forcing it needs `COLLATE utf8mb4_bin`, which overrides whatever
    // collation the schema chose. So this is the column's own collation,
    // insensitive under the `*_ci` default.
    return sql`${sql.ref(column)} like ${pattern}`;
  },

  jsonContains(column: JsonColumn, value: GrammarBinding): Expression<any> {
    // json_contains() compares JSON against JSON: the scalar has to be
    // serialised ("x" not x, 1 not '1') or MySQL raises "Invalid JSON
    // text in argument 2".
    return sql`json_contains(${sql.ref(column.field)}, ${JSON.stringify(value)}, ${jsonPath(column)})`;
  },

  jsonContainsKey(column: JsonColumn): Expression<any> {
    // json_contains_path() returns NULL when the *document* is NULL,
    // which would make `NOT (...)` null rather than true for a missing
    // key. ifnull() collapses that to a plain false so the negated form
    // (`whereJsonDoesntContainKey`) matches rows with a null column.
    return sql`ifnull(json_contains_path(${sql.ref(column.field)}, 'one', ${jsonPath(column)}), 0)`;
  },

  jsonLength(column: JsonColumn): Expression<any> {
    return sql`json_length(${sql.ref(column.field)}, ${jsonPath(column)})`;
  },

  randomOrder(): Expression<any> {
    return sql`RAND()`;
  },

  applyUpsert(insert: any, _conflictColumns: string[], updateColumns: string[]): any {
    if (updateColumns.length === 0) {
      // MySQL has no DO NOTHING. `INSERT IGNORE` is the closest
      // equivalent and is what Laravel's MySqlGrammar emits for an
      // empty update list.
      return insert.ignore();
    }

    const set: Record<string, any> = {};

    for (const column of updateColumns) {
      set[column] = sql`values(${sql.ref(column)})`;
    }

    return insert.onDuplicateKeyUpdate(set);
  },
};
