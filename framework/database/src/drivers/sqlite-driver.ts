import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Dialect } from "../schema/dialect.js";
import type { DatabaseDriver } from "./driver.js";
import { errorTranslatingDialect } from "./error-translating-dialect.js";

/**
 * Whether a column's **declared** type means "64-bit" and so must stay a
 * `bigint` in JS.
 *
 * SQLite records the type a column was declared with verbatim, even
 * though it only has storage classes — `bigint`, `int8` and `INTEGER`
 * all take INTEGER affinity and store identically. That declared
 * spelling is the only per-column signal a driver gets, and mahi's
 * schema grammar writes `bigint` for `bigInteger`/`unsignedBigInteger`/
 * `foreignId` precisely so it can be read back here.
 *
 * Plain `INTEGER` is not enough on its own, because an auto-incrementing
 * primary key is also 64-bit but *must* be declared `INTEGER` to be a
 * rowid alias. Those are caught separately by `isRowidKey()`.
 */
function isBigintColumn(declared: string | null): boolean {
  if (declared === null) {
    return false;
  }

  const type = declared.toLowerCase();

  return type === "bigint" || type === "int8" || type === "unsigned big int";
}

/**
 * Whether `column` is the single `INTEGER PRIMARY KEY` of `table` — a
 * rowid alias, which SQLite stores as a 64-bit signed integer.
 *
 * This is what `bigIncrements()`/`id()` compiles to. It cannot be
 * declared `bigint`, because only the exact type `INTEGER PRIMARY KEY`
 * aliases the rowid and SQLite rejects
 * `bigint primary key autoincrement` outright. So the declared type
 * cannot distinguish it from an ordinary 32-bit column, and the table's
 * primary key has to be consulted instead.
 *
 * Without this an auto-increment key would be a `number` here and a
 * `bigint` on MySQL (`BIGINT AUTO_INCREMENT`) and Postgres (`bigserial`),
 * so the same model's `id` would change type with the engine underneath
 * it.
 *
 * Composite primary keys are excluded: `primary key(x, y)` is not a
 * rowid alias, and neither column is implicitly 64-bit.
 */
function isRowidKey(db: BetterSqlite3.Database, table: string, column: string): boolean {
  const info = db.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as {
    name: string;
    type: string;
    pk: number;
  }[];

  const keys = info.filter((entry) => entry.pk > 0);

  return keys.length === 1 && keys[0]!.name === column && keys[0]!.type.toLowerCase() === "integer";
}

/** Double-quote an identifier for interpolation, escaping any quotes in it. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A column as `better-sqlite3` describes it, via `Statement.columns()`. */
interface ColumnMetadata {
  name: string;
  type: string | null;
  table: string | null;
  column: string | null;
}

/**
 * Which result columns are 64-bit, by name.
 *
 * `columns()` reports the originating table and column even through an
 * alias or a join (`select a.id as aid` still says `t`.`id`), which is
 * what makes the rowid lookup possible on anything but a bare select.
 *
 * Everything not backed by a real column — `count(*)`, `id + 1`, a
 * literal — reports `null` for all three, and is left to narrow. Those
 * are computed values rather than 64-bit storage, which is what keeps
 * `count(*)` a `number`.
 */
function wideColumns(db: BetterSqlite3.Database, columns: ColumnMetadata[]): Set<string> {
  const wide = new Set<string>();

  for (const column of columns) {
    if (isBigintColumn(column.type)) {
      wide.add(column.name);

      continue;
    }

    // `INTEGER` is only 64-bit when it is the table's rowid alias, which
    // needs the table's primary key to decide.
    if (
      column.type?.toLowerCase() === "integer" &&
      column.table !== null &&
      column.column !== null &&
      isRowidKey(db, column.table, column.column)
    ) {
      wide.add(column.name);
    }
  }

  return wide;
}

/**
 * Narrow every `bigint` the driver produced back to a `number`, except
 * in the columns that are actually 64-bit.
 *
 * The decision is **by column type, never by value**: a `bigint` column
 * holding `5` still comes back as `5n`. Deciding per value would make a
 * column's JS type depend on its contents — `number` in a test with
 * small fixtures, `bigint` in production with real snowflakes — which is
 * the kind of difference that passes CI and fails live.
 */
function narrowByColumnType(rows: unknown[], wide: Set<string>): void {
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "bigint" && !wide.has(key)) {
        (row as Record<string, unknown>)[key] = Number(value);
      }
    }
  }
}

/**
 * The better-sqlite3 handle with `prepare()` wrapped so that every
 * statement returning rows narrows them by declared column type.
 *
 * Done at the handle rather than by replacing Kysely's `SqliteDialect`:
 * the dialect's connection calls `stmt.all()` and returns `{ rows }`
 * alone, discarding the `stmt.columns()` metadata this needs, so the
 * type information has to be captured where the statement still exists.
 * Wrapping `prepare()` keeps Kysely's driver, transaction and savepoint
 * handling untouched.
 */
function narrowingHandle(db: BetterSqlite3.Database): BetterSqlite3.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      // `safeIntegers` applies to pragmas too, so `busy_timeout` would
      // read back as `5000n`. A pragma reports engine settings — page
      // counts, flags, timeouts — none of which are 64-bit values, and
      // all of which callers compare against plain numbers.
      if (prop === "pragma") {
        return (source: string, options?: BetterSqlite3.PragmaOptions) => {
          const result = target.pragma(source, options as BetterSqlite3.PragmaOptions);

          return typeof result === "bigint" ? Number(result) : result;
        };
      }

      if (prop !== "prepare") {
        const value = Reflect.get(target, prop, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...args: [string]) => {
        const statement = target.prepare(...args);

        // `columns()` throws on a statement that returns no rows, and
        // there is nothing to narrow there anyway.
        if (!statement.reader) {
          return statement;
        }

        // Resolved once per statement and reused across executions: the
        // shape of a prepared statement's result cannot change, and
        // `isRowidKey()` reads a pragma per candidate column.
        let wide: Set<string> | undefined;

        const wideFor = (stmt: BetterSqlite3.Statement): Set<string> => {
          wide ??= wideColumns(target, stmt.columns() as ColumnMetadata[]);

          return wide;
        };

        return new Proxy(statement, {
          get(stmt, key, self) {
            if (key === "all") {
              return (...params: unknown[]) => {
                const rows = stmt.all(...params) as unknown[];
                narrowByColumnType(rows, wideFor(stmt));

                return rows;
              };
            }

            if (key === "get") {
              return (...params: unknown[]) => {
                const row = stmt.get(...params);

                if (row !== undefined) {
                  narrowByColumnType([row], wideFor(stmt));
                }

                return row;
              };
            }

            if (key === "iterate") {
              return function* (...params: unknown[]) {
                const columns = wideFor(stmt);

                for (const row of stmt.iterate(...params)) {
                  narrowByColumnType([row], columns);

                  yield row;
                }
              };
            }

            const value = Reflect.get(stmt, key, self);

            return typeof value === "function" ? value.bind(stmt) : value;
          },
        });
      };
    },
  });
}

export interface SqliteConnectionConfig {
  /** Path to the sqlite file, or ":memory:" for an in-memory database. */
  filename: string;

  /**
   * How long a blocked writer waits for the lock, in milliseconds.
   *
   * Defaults to 5000. **Sqlite's own default is 0**, which means a second
   * process attempting to write while another holds the lock fails
   * immediately with `SQLITE_BUSY` rather than waiting, and since WAL still
   * permits only one writer at a time, that is not an exotic condition, it is
   * what two concurrent writes look like.
   *
   * The failure is also silent in the shape that matters: the losing process
   * gets an exception it may well be swallowing, so the symptom is missing
   * data rather than an error. Set to 0 to restore sqlite's behaviour.
   */
  busyTimeout?: number;
}

/**
 * better-sqlite3 is a fully synchronous driver (no async API at all), so
 * construction here is synchronous and there is no `connect()`.
 * The handle is open the moment the constructor returns, so there is
 * nothing to warm up and nothing for `DatabaseServiceProvider.boot()` to
 * await.
 *
 * `disconnect()` is a different matter and IS implemented: an open sqlite
 * handle is an OS file descriptor plus a WAL file, and leaving it dangling
 * on shutdown means the WAL is not checkpointed back into the database
 * file and (on Windows) the file stays locked. Called by
 * `DatabaseServiceProvider.shutdown()`.
 */
export class SqliteDriver<DB = any> implements DatabaseDriver<DB> {
  readonly dialect: Dialect = "sqlite";
  readonly kysely: Kysely<DB>;
  private readonly db: BetterSqlite3.Database;

  constructor(config: SqliteConnectionConfig) {
    this.db = narrowingHandle(new BetterSqlite3(config.filename));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // WAL lets readers and a writer coexist, but still only ONE writer, so
    // without a busy timeout a second concurrent write fails instantly.
    this.db.pragma(`busy_timeout = ${config.busyTimeout ?? 5000}`);
    // Read every integer as a `bigint`, then narrow all but the 64-bit
    // columns back to `number` (see `narrowByColumnType`).
    //
    // better-sqlite3 otherwise reads integers as JS `number`s, which
    // **silently rounds anything past 2^53**: a snowflake id stored as
    // `440463260157395208` reads back as `440463260157395200` — a
    // different row, with no error raised anywhere. Asking for `bigint`
    // is the only way to see the true value, and it is all-or-nothing,
    // hence the narrowing pass on the way out.
    this.db.defaultSafeIntegers(true);

    this.kysely = new Kysely<DB>({
      dialect: errorTranslatingDialect(new SqliteDialect({ database: this.db }), "sqlite"),
    });
  }

  /**
   * Close the underlying better-sqlite3 handle (via Kysely's `destroy()`,
   * which the SqliteDialect wires to `database.close()`), checkpointing
   * and releasing the WAL. Every query after this throws
   * "The database connection is closed". Which is the point: a
   * terminated application should be discarded, not reused.
   *
   * Idempotent, because shutdown is best-effort and a second
   * `terminate()` (or a test's `cleanup()` after an explicit close) must
   * not turn into an error. Kysely's own `destroy()` is not: it throws
   * `TypeError: db.prepare is not a function` on the second call.
   */
  async disconnect(): Promise<void> {
    if (!this.db.open) {
      return;
    }

    await this.kysely.destroy();
  }
}
