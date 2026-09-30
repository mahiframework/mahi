import { sql, type Expression } from "kysely";
import type { DatePart, GrammarBinding, JsonColumn, QueryGrammar } from "./grammar.js";

/** SQLite's `strftime()` format string per extracted date component. */
const STRFTIME_FORMAT: Record<DatePart, string> = {
  date: "%Y-%m-%d",
  time: "%H:%M:%S",
  day: "%d",
  month: "%m",
  year: "%Y",
};

/** `{ field: "meta", segments: ["a", "b"] }` → `"$.a.b"`, the JSONPath SQLite's `json_*` functions take. */
function jsonPath(column: JsonColumn): string {
  return column.segments.length > 0 ? `$.${column.segments.join(".")}` : "$";
}

/**
 * SQLite query grammar, the framework's default engine.
 *
 * Date components come from `strftime()`, JSON from the `json_each()`/
 * `json_type()`/`json_array_length()` family (the JSON1 extension,
 * compiled into better-sqlite3 by default), and upserts from the same
 * `ON CONFLICT ... DO UPDATE` syntax Postgres uses.
 *
 * `LIKE` needs no help here: it folds ASCII case by default, so both
 * halves of `like()`'s `caseInsensitive` option compile identically.
 * See that method.
 *
 * Row locks are the one thing SQLite genuinely cannot do: the database
 * is a single file with one writer, there is no row-level lock to take,
 * and Kysely's SQLite dialect emits `for update` verbatim into SQL that
 * then fails to parse. `supportsRowLocks: false` makes `lockForUpdate()`
 * a documented no-op here rather than a runtime syntax error, matching
 * Laravel's own `SQLiteGrammar::compileLock()`, which returns an empty
 * string unconditionally.
 */
export const sqliteQueryGrammar: QueryGrammar = {
  dialect: "sqlite",
  supportsRowLocks: false,

  datePart(part: DatePart, column: string): Expression<any> {
    // strftime() already returns text, so the comparison against the
    // caller's string value needs no further cast.
    return sql`strftime(${STRFTIME_FORMAT[part]}, ${sql.ref(column)})`;
  },

  like(
    column: string,
    pattern: GrammarBinding,
    _options: { caseInsensitive: boolean },
  ): Expression<any> {
    // One spelling for both options: SQLite's LIKE folds ASCII case
    // already, and the sensitive form has no per-query equivalent.
    // `PRAGMA case_sensitive_like` is connection-global, and `GLOB` is
    // not a substitution, it takes shell wildcards (`*`, `?`) rather
    // than SQL's (`%`, `_`), so a caller's pattern would change meaning.
    return sql`${sql.ref(column)} like ${pattern}`;
  },

  jsonContains(column: JsonColumn, value: GrammarBinding): Expression<any> {
    // `=` (equality), not `IS`: json_each.value is the JSON element decoded
    // to a native SQLite value, and this must match MySQL's json_contains()
    // and Postgres' `@>` by VALUE. `IS` in SQLite treats its operands as an
    // identity test that never compares as unknown, which mishandles the
    // bound scalar against a decoded JSON element and returns wrong rows.
    return sql`exists (select 1 from json_each(${sql.ref(column.field)}, ${jsonPath(column)}) where json_each.value = ${value})`;
  },

  jsonContainsKey(column: JsonColumn): Expression<any> {
    return sql`json_type(${sql.ref(column.field)}, ${jsonPath(column)}) is not null`;
  },

  jsonLength(column: JsonColumn): Expression<any> {
    return sql`json_array_length(${sql.ref(column.field)}, ${jsonPath(column)})`;
  },

  randomOrder(): Expression<any> {
    return sql`RANDOM()`;
  },

  applyUpsert(insert: any, conflictColumns: string[], updateColumns: string[]): any {
    return insert.onConflict((oc: any) => {
      const target = oc.columns(conflictColumns);

      if (updateColumns.length === 0) {
        return target.doNothing();
      }

      const set: Record<string, any> = {};

      for (const column of updateColumns) {
        set[column] = (eb: any) => eb.ref(`excluded.${column}`);
      }

      return target.doUpdateSet(set);
    });
  },
};
