import type { Expression } from "kysely";
import type { Dialect } from "../schema/dialect.js";

/** A bound parameter value. Mirrors `QueryBuilder`'s `SqlBinding`. */
export type GrammarBinding = string | number | boolean | null;

/** Which component `whereDate`/`whereDay`/`whereMonth`/`whereYear`/`whereTime` extracts. */
export type DatePart = "date" | "day" | "month" | "year" | "time";

/**
 * A JSON column reference split into its base column and the `->` path
 * segments that follow it (`"meta->author->name"` → field `"meta"`,
 * segments `["author", "name"]`).
 *
 * Kept as segments rather than a pre-formatted path string because the
 * three engines spell the path completely differently, SQLite and MySQL
 * take a `$.a.b` JSONPath string, Postgres chains `->'a'->'b'` operators,
 * so there is no one string all of them can consume. Each grammar
 * formats the segments itself.
 */
export interface JsonColumn {
  field: string;
  segments: string[];
}

/**
 * The dialect-specific half of **query** compilation, the query-layer
 * twin of `SchemaGrammar`.
 *
 * `QueryBuilder` accumulates a dialect-agnostic tree of where/order
 * nodes and asks one of these to turn the handful of genuinely
 * engine-specific constructs into SQL. Everything else (plain
 * comparisons, `IN`, `BETWEEN`, joins, grouping) is standard SQL that
 * Kysely already spells correctly for every dialect and never reaches
 * here.
 *
 * The members below are exactly the constructs that were hard-coded to
 * SQLite before MySQL/Postgres drivers existed:
 *
 * - **date extraction**. `strftime()` is SQLite-only; MySQL has
 *   `date()`/`year()`/…, Postgres has `::date` casts and `extract()`.
 * - **JSON**, `json_each()`/`json_type()`/`json_array_length()` are
 *   SQLite spellings; MySQL has `json_contains()`/`json_length()`,
 *   Postgres has `@>`/`jsonb_path_exists()`.
 * - **random ordering**, `RANDOM()` everywhere except MySQL's `RAND()`.
 * - **upsert**, `ON CONFLICT ... DO UPDATE` (SQLite/Postgres) vs
 *   `ON DUPLICATE KEY UPDATE` (MySQL).
 * - **row locks**, real on MySQL/Postgres, nonexistent on SQLite.
 * - **case-insensitive `LIKE`**, Postgres `ILIKE`, MySQL a
 *   `lower()`/`lower()` comparison, SQLite plain `LIKE`.
 *
 * A new engine is added by implementing this interface and registering
 * it in `queryGrammarFor()`; `QueryBuilder` itself does not change.
 */
export interface QueryGrammar {
  readonly dialect: Dialect;

  /**
   * Whether `SELECT ... FOR UPDATE`/`FOR SHARE` means anything on this
   * engine. False on SQLite, which has no row-level locking at all (one
   * writer per database file) and treats the clause as a syntax error.
   * `lock()` is a documented no-op there.
   */
  readonly supportsRowLocks: boolean;

  /**
   * The engine's expression for one extracted date component of
   * `column`, SQLite `strftime('%Y', c)`, MySQL `year(c)`, Postgres
   * `extract(year from c)`.
   *
   * Returns just the left-hand side rather than a whole predicate so
   * the caller compares it through Kysely's own `eb(lhs, op, value)`,
   * which owns operator spelling and parameter binding. `value` is
   * always compared as a string (`"2026"`, `"09"`), matching Laravel,
   * so each grammar casts its result to text where the engine would
   * otherwise produce a number.
   */
  datePart(part: DatePart, column: string): Expression<any>;

  /**
   * `WHERE` predicate matching `column` against a `LIKE` pattern, with
   * `caseInsensitive` selecting the engine's case-folding form.
   *
   * Returns a whole predicate rather than a left-hand side (as
   * `datePart()` does) because here the *operator* is what varies:
   * Postgres spells folding as a different operator (`ILIKE`), MySQL as
   * a `lower()`/`lower()` comparison of both sides, so there is no
   * single left-hand side the caller could compare through
   * `eb(lhs, "like", pattern)`.
   *
   * `caseInsensitive: true` is guaranteed on every engine, which is the
   * whole point of the member: without it `where(col, "like", v)` folds
   * on SQLite, folds on MySQL under a `*_ci` collation, and does NOT
   * fold on Postgres, so the same query returns different rows per
   * engine.
   *
   * `caseInsensitive: false` means **the engine's own default**, not a
   * guarantee of case sensitivity: case-sensitive on Postgres,
   * collation-dependent on MySQL, ASCII-folding on SQLite. Neither
   * MySQL nor SQLite can be forced case-sensitive per query without
   * damage, MySQL would need a `COLLATE utf8mb4_bin` that assumes the
   * charset and overrides the collation the schema chose, and SQLite's
   * `PRAGMA case_sensitive_like` is connection-global so it cannot vary
   * per query at all.
   *
   * Folding is not byte-identical across engines for non-ASCII
   * input. SQLite's `LIKE` folds **ASCII only** (`Ä` does not match
   * `ä`), while MySQL's `lower()` and Postgres' `ILIKE` fold per
   * collation and do match it.
   */
  like(
    column: string,
    pattern: GrammarBinding,
    options: { caseInsensitive: boolean },
  ): Expression<any>;

  /** `WHERE` predicate: the JSON array at `column` contains the scalar `value`. */
  jsonContains(column: JsonColumn, value: GrammarBinding): Expression<any>;

  /** `WHERE` predicate: the JSON path `column` exists (Laravel's `whereJsonContainsKey`). */
  jsonContainsKey(column: JsonColumn): Expression<any>;

  /** The engine's expression for the length of the JSON array at `column`, compared by the caller, like `datePart()`. */
  jsonLength(column: JsonColumn): Expression<any>;

  /** The `ORDER BY` expression that shuffles rows, `RANDOM()`, or MySQL's `RAND()`. */
  randomOrder(): Expression<any>;

  /**
   * Applies this engine's "insert, or update the conflicting row"
   * clause to an already-built Kysely insert, given the columns that
   * carry the unique constraint and the columns to overwrite.
   *
   * Takes the insert builder rather than returning a fragment because
   * the two forms attach at different points and read the incoming row
   * differently: Postgres/SQLite name the pending row `excluded` inside
   * an `ON CONFLICT (cols)` clause, while MySQL has no conflict-target
   * list at all and reads the pending row through `VALUES(col)`.
   *
   * `updateColumns` empty means "do nothing on conflict".
   */
  applyUpsert(insert: any, conflictColumns: string[], updateColumns: string[]): any;
}
