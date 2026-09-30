import { sql, type Expression } from "kysely";
import type { DatePart, GrammarBinding, JsonColumn, QueryGrammar } from "./grammar.js";

/**
 * Builds the `col->'a'->'b'` chain that navigates to a nested JSON
 * value, ending in `jsonb` so the containment/length operators below
 * apply.
 *
 * Postgres has no JSONPath-string form for this the way SQLite and
 * MySQL do. The path is spelled as a chain of `->` operators, so it is
 * built segment by segment here. The final cast to `jsonb` is what
 * makes this work against both `json` and `jsonb` columns: `@>` and
 * `jsonb_array_length()` are `jsonb`-only, and `json` (the textual
 * type) has no containment operator at all.
 */
function jsonbPath(column: JsonColumn): Expression<any> {
  let expr = sql`${sql.ref(column.field)}`;

  for (const segment of column.segments) {
    expr = sql`${expr}->${segment}`;
  }

  return sql`(${expr})::jsonb`;
}

/**
 * PostgreSQL query grammar.
 *
 * Date components use casts (`::date`, `::time`) for the whole-value
 * parts and `extract()` for the numeric ones, cast to text so they
 * compare against Laravel's zero-padded string convention
 * (`whereMonth("09")`). `extract()` returns `numeric`, whose text form
 * is unpadded (`9`), so the numeric components are padded with
 * `lpad(..., 2, '0')` to match, except `year`, which is already four
 * digits.
 *
 * `LIKE` here is the only case-sensitive one of the three engines, so
 * `ILIKE` is what `caseInsensitive: true` compiles to. See `like()`.
 *
 * JSON uses the `jsonb` operator family: `@>` for containment,
 * `jsonb_path_exists()` for key presence, `jsonb_array_length()` for
 * length. See `jsonbPath()` for why everything is cast to `jsonb`
 * first.
 *
 * Upserts use the same `ON CONFLICT (cols) DO UPDATE SET ... =
 * excluded.col` form SQLite does.
 */
export const postgresQueryGrammar: QueryGrammar = {
  dialect: "postgres",
  supportsRowLocks: true,

  datePart(part: DatePart, column: string): Expression<any> {
    const ref = sql.ref(column);
    switch (part) {
      case "date":
        return sql`cast(${ref} as date)`;
      case "time":
        return sql`cast(${ref} as time)`;
      case "day":
        return sql`lpad(cast(extract(day from ${ref}) as text), 2, '0')`;
      case "month":
        return sql`lpad(cast(extract(month from ${ref}) as text), 2, '0')`;
      case "year":
        return sql`cast(extract(year from ${ref}) as text)`;
    }
  },

  like(
    column: string,
    pattern: GrammarBinding,
    options: { caseInsensitive: boolean },
  ): Expression<any> {
    // Postgres is the engine that makes this member necessary: its
    // `LIKE` is the only case-*sensitive* one of the three, and `ILIKE`
    // is the folding form.
    if (options.caseInsensitive) {
      return sql`${sql.ref(column)} ilike ${pattern}`;
    }

    return sql`${sql.ref(column)} like ${pattern}`;
  },

  jsonContains(column: JsonColumn, value: GrammarBinding): Expression<any> {
    // `@>` is containment between two jsonb values, so the scalar is
    // serialised into a jsonb literal on the right-hand side.
    return sql`${jsonbPath(column)} @> ${JSON.stringify(value)}::jsonb`;
  },

  jsonContainsKey(column: JsonColumn): Expression<any> {
    // The path is navigated by jsonbPath() down to the *parent*, so key
    // presence is asked of the value itself: a non-null result at that
    // path means the key exists.
    return sql`${jsonbPath(column)} is not null`;
  },

  jsonLength(column: JsonColumn): Expression<any> {
    return sql`jsonb_array_length(${jsonbPath(column)})`;
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
