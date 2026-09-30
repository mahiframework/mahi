import { describe, expect, it } from "vitest";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import BetterSqlite3 from "better-sqlite3";
import { queryGrammarFor } from "../src/query/index.js";
import { QueryBuilder } from "../src/query-builder.js";
import { errorTranslatingDialect } from "../src/drivers/error-translating-dialect.js";
import { dialectOf } from "../src/drivers/dialect-registry.js";
import { formatTimestamp, toDriverTimestamp } from "../src/timestamps.js";
import { DateTime } from "@mahiframework/datetime";
import type { Dialect } from "../src/schema/dialect.js";

/**
 * Compilation-only checks for the dialect layer: what SQL each engine's
 * grammar produces, without needing that engine running. The
 * cross-dialect integration suite proves the SQL is *accepted*; these
 * prove it is *shaped right*, and run everywhere.
 *
 * The MySQL/Postgres connections below are never connected, a
 * `Kysely` instance compiles queries without touching its pool, which
 * is exactly what `toSql()` exercises.
 */
function connectionFor(dialect: Dialect): Kysely<any> {
  if (dialect === "sqlite") {
    return new Kysely({
      dialect: errorTranslatingDialect(
        new SqliteDialect({ database: new BetterSqlite3(":memory:") }),
        "sqlite",
      ),
    });
  }

  if (dialect === "mysql") {
    return new Kysely({
      dialect: errorTranslatingDialect(new MysqlDialect({ pool: {} as never }), "mysql"),
    });
  }

  return new Kysely({
    dialect: errorTranslatingDialect(new PostgresDialect({ pool: {} as never }), "postgres"),
  });
}

const DIALECTS: Dialect[] = ["sqlite", "mysql", "postgres"];

describe("dialect registry", () => {
  it("recovers the dialect from a connection built by a driver", () => {
    for (const dialect of DIALECTS) {
      expect(dialectOf(connectionFor(dialect))).toBe(dialect);
    }
  });

  it("survives into a transaction, where every model write happens", async () => {
    const db = connectionFor("sqlite");
    await db.transaction().execute(async (trx) => {
      expect(dialectOf(trx)).toBe("sqlite");
    });
  });

  it("falls back to sqlite for a connection this framework didn't build", () => {
    // No `errorTranslatingDialect` wrapper, so nothing was registered.
    const foreign = new Kysely({
      dialect: new SqliteDialect({ database: new BetterSqlite3(":memory:") }),
    });
    expect(dialectOf(foreign)).toBe("sqlite");
  });
});

describe("query grammar", () => {
  const query = (dialect: Dialect) => new QueryBuilder<any>(() => connectionFor(dialect), "posts");

  it("extracts date parts with each engine's own function", () => {
    expect(query("sqlite").whereMonth("created_at", "09").toSql()).toContain("strftime");
    expect(query("mysql").whereMonth("created_at", "09").toSql()).toContain("month(");
    expect(query("postgres").whereMonth("created_at", "09").toSql()).toContain(
      "extract(month from",
    );
  });

  it("pads day/month so every engine compares against the same zero-padded string", () => {
    // SQLite's strftime('%m') yields "09"; the other two return 9 and
    // need padding to match.
    expect(query("mysql").whereDay("created_at", "05").toSql()).toContain("lpad");
    expect(query("postgres").whereDay("created_at", "05").toSql()).toContain("lpad");
  });

  it("folds case with whatever construct each engine actually has", () => {
    // Postgres is the reason this exists: plain `like` there is
    // case-sensitive, so `where("title", "like", ...)` silently returns
    // different rows than it does on SQLite.
    expect(query("postgres").whereLike("title", "%inception%").toSql()).toContain("ilike");
    // lower() on both sides rather than a named collation, so it holds
    // under a `*_bin` column too.
    expect(query("mysql").whereLike("title", "%inception%").toSql()).toMatch(
      /lower\(.+\) like lower\(/,
    );
    // SQLite's `like` folds ASCII already, so there is nothing to add.
    const sqlite = query("sqlite").whereLike("title", "%inception%").toSql();
    expect(sqlite).toContain("like");
    expect(sqlite).not.toContain("lower(");
  });

  it("defaults to folding, so the portable behaviour is the one you get by omission", () => {
    expect(query("postgres").whereLike("title", "%x%").toSql()).toContain("ilike");
  });

  it("drops to the engine's own LIKE when case-insensitivity is declined", () => {
    const postgres = query("postgres")
      .whereLike("title", "%x%", { caseInsensitive: false })
      .toSql();
    expect(postgres).toContain("like");
    expect(postgres).not.toContain("ilike");

    const mysql = query("mysql").whereLike("title", "%x%", { caseInsensitive: false }).toSql();
    expect(mysql).toContain("like");
    expect(mysql).not.toContain("lower(");
  });

  it("negates through NOT rather than a second operator spelling", () => {
    // `not ... ilike` keeps the grammar member as the single source of
    // the operator, so every engine negates the same way.
    expect(query("postgres").whereNotLike("title", "%x%").toSql()).toMatch(/not.+ilike/);
  });

  it("binds the pattern rather than interpolating it", () => {
    const builder = query("postgres").whereLike("title", "%inception%");
    expect(builder.getBindings()).toContain("%inception%");
    expect(builder.toSql()).not.toContain("inception");
  });

  it("routes the column through qualify(), so an aliased builder rewrites it", () => {
    // The same rewrite every other grammar-backed node gets: without it
    // a `whereLike` inside a correlated subquery would name the real
    // table rather than the alias the subquery selects from.
    const sql = query("postgres").alias("posts__sub").whereLike("posts.title", "%x%").toSql();
    expect(sql).toContain('"posts__sub"."title"');
  });

  it("uses each engine's JSON containment construct", () => {
    expect(query("sqlite").whereJsonContains("meta->tags", "x").toSql()).toContain("json_each");
    expect(query("mysql").whereJsonContains("meta->tags", "x").toSql()).toContain("json_contains");
    expect(query("postgres").whereJsonContains("meta->tags", "x").toSql()).toContain("@>");
  });

  it("uses RAND() on MySQL and RANDOM() elsewhere", () => {
    expect(query("sqlite").inRandomOrder().toSql()).toContain("RANDOM()");
    expect(query("postgres").inRandomOrder().toSql()).toContain("RANDOM()");
    const mysql = query("mysql").inRandomOrder().toSql();
    expect(mysql).toContain("RAND()");
    expect(mysql).not.toContain("RANDOM()");
  });

  it("emits row locks only where the engine has them", () => {
    // SQLite has no row-level locking and rejects the clause outright,
    // so the intent is recorded but never compiled. See `lock()`.
    expect(query("sqlite").lockForUpdate().toSql()).not.toContain("for update");
    expect(query("mysql").lockForUpdate().toSql()).toContain("for update");
    expect(query("postgres").lockForUpdate().toSql()).toContain("for update");
    expect(query("postgres").sharedLock().toSql()).toContain("for share");
  });

  it("passes a string lock through verbatim for engine-specific modifiers", () => {
    expect(query("postgres").lock("for update skip locked").toSql()).toContain(
      "for update skip locked",
    );
  });

  it("compiles whereIn([]) to a false constant rather than the invalid `in ()`", () => {
    // `in ()` is a syntax error on MySQL and Postgres; SQLite tolerates
    // it, which is why this went unnoticed.
    for (const dialect of DIALECTS) {
      const sql = query(dialect).whereIn("id", []).toSql();
      expect(sql).not.toMatch(/in\s*\(\s*\)/);
      expect(sql).toContain("0 = 1");
    }
  });

  it("compiles whereNotIn([]) to a true constant", () => {
    for (const dialect of DIALECTS) {
      expect(query(dialect).whereNotIn("id", []).toSql()).toContain("1 = 1");
    }
  });

  it("quotes identifiers the way each engine expects", () => {
    // MySQL reads "x" as a string literal, so a correlation predicate
    // built with double quotes silently compared two constants there.
    expect(query("mysql").where("title", "x").toSql()).toContain("`posts`");
    expect(query("postgres").where("title", "x").toSql()).toContain('"posts"');
  });

  it("has a grammar registered for every dialect", () => {
    for (const dialect of DIALECTS) {
      expect(queryGrammarFor(dialect).dialect).toBe(dialect);
    }

    expect(() => queryGrammarFor("oracle" as Dialect)).toThrow(/no query grammar/i);
  });
});

describe("timestamp formatting", () => {
  const at = DateTime.fromISO("2026-09-02T07:31:37.499Z", "UTC");

  it("writes ISO-8601 for SQLite and Postgres", () => {
    expect(formatTimestamp("sqlite", at)).toBe("2026-09-02T07:31:37.499Z");
    expect(formatTimestamp("postgres", at)).toBe("2026-09-02T07:31:37.499Z");
  });

  it("writes MySQL's space-separated form, which is the only one it accepts", () => {
    // Strict mode rejects the trailing `Z` outright. This is what made
    // `migrate` unable to record a migration on MySQL.
    expect(formatTimestamp("mysql", at)).toBe("2026-09-02 07:31:37.499");
  });

  it("keeps sub-second precision, so a millisecond column isn't coarsened", () => {
    expect(formatTimestamp("mysql", at)).toContain(".499");
    expect(formatTimestamp("sqlite", at)).toContain(".499");
  });

  it("normalises a non-UTC instant rather than writing its local wall time", () => {
    const shanghai = at.setTimezone("Asia/Shanghai");
    expect(formatTimestamp("mysql", shanghai)).toBe("2026-09-02 07:31:37.499");
  });

  describe("toDriverTimestamp", () => {
    it("rewrites zone-carrying ISO values for MySQL only", () => {
      expect(toDriverTimestamp("mysql", "2026-09-02T07:31:37.499Z")).toBe(
        "2026-09-02 07:31:37.499",
      );
      expect(toDriverTimestamp("sqlite", "2026-09-02T07:31:37.499Z")).toBe(
        "2026-09-02T07:31:37.499Z",
      );
      expect(toDriverTimestamp("postgres", "2026-09-02T07:31:37.499Z")).toBe(
        "2026-09-02T07:31:37.499Z",
      );
    });

    it("accepts DateTime and Date as well as strings", () => {
      expect(toDriverTimestamp("mysql", at)).toBe("2026-09-02 07:31:37.499");
      expect(toDriverTimestamp("mysql", new Date("2026-09-02T07:31:37.499Z"))).toBe(
        "2026-09-02 07:31:37.499",
      );
    });

    it("leaves anything that isn't an unambiguous instant alone", () => {
      // A bare date, a time, and ordinary text must pass through. This
      // runs over declared datetime columns, but rewriting a value that
      // merely looks date-ish would corrupt it.
      expect(toDriverTimestamp("mysql", "2026-09-02")).toBe("2026-09-02");
      expect(toDriverTimestamp("mysql", "07:31:37")).toBe("07:31:37");
      expect(toDriverTimestamp("mysql", "not a date")).toBe("not a date");
      expect(toDriverTimestamp("mysql", null)).toBeNull();
      expect(toDriverTimestamp("mysql", undefined)).toBeUndefined();
      expect(toDriverTimestamp("mysql", 42)).toBe(42);
    });
  });
});
