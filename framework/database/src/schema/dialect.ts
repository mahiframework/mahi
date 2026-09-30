import type { Kysely } from "kysely";
import type { Blueprint } from "./blueprint.js";

/**
 * The database engines the schema layer knows how to compile Blueprints
 * for. Each maps to a `SchemaGrammar` (see `grammars/`) that owns the
 * dialect-specific SQL, column type spelling, whether an `ALTER TABLE`
 * can happen in place or needs a table rebuild (SQLite), how tables are
 * introspected, and how `dropAllTables()` finds and drops them.
 */
export type Dialect = "sqlite" | "mysql" | "postgres";

/**
 * The dialect-specific half of schema compilation. `SchemaBuilder` and
 * `Blueprint` are dialect-agnostic; they collect the Laravel-shaped
 * definition and hand it to one of these to emit the actual DDL.
 *
 * A new engine is added by implementing this interface and registering it
 * in `grammarFor()`, nothing in `Blueprint`/`SchemaBuilder` changes.
 */
export interface SchemaGrammar {
  readonly dialect: Dialect;

  /** Compile a `Schema.create()` Blueprint into `CREATE TABLE` (+ indexes). */
  compileCreate(db: Kysely<any>, blueprint: Blueprint): Promise<void>;

  /** Compile a `Schema.table()` Blueprint into `ALTER TABLE` statements. */
  compileAlter(db: Kysely<any>, blueprint: Blueprint): Promise<void>;

  /** Drop every user table (used by `migrate:fresh`). */
  dropAllTables(db: Kysely<any>): Promise<void>;

  /**
   * Delete every row from every user table, leaving the schema in place
   * and restarting auto-increment counters at 1. The between-tests reset
   * behind `@mahiframework/testing`'s `clearDatabase()`.
   *
   * Skips the framework's own migration ledger (see `FRAMEWORK_TABLES`),
   * which must survive a row wipe or the schema and the ledger disagree.
   *
   * Identity is restarted on every dialect rather than left to each
   * engine's default (Postgres `TRUNCATE` continues, MySQL `DELETE`
   * continues but `TRUNCATE` resets, SQLite keeps `sqlite_sequence`), so
   * a test asserting on a generated id behaves the same everywhere.
   */
  truncateAllTables(db: Kysely<any>): Promise<void>;
}
