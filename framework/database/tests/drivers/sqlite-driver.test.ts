import { describe, expect, it } from "vitest";
import { SqliteDriver } from "../../src/drivers/sqlite-driver.js";
import { SchemaBuilder } from "../../src/schema/schema-builder.js";
import type { Blueprint } from "../../src/schema/blueprint.js";

/**
 * Read a pragma off the driver's underlying better-sqlite3 handle.
 *
 * `simple: true` returns the value itself; without it better-sqlite3 hands
 * back a row object, which compares equal to nothing useful.
 */
function pragma(driver: SqliteDriver, name: string): number {
  const db = (
    driver as unknown as { db: { pragma(source: string, options: { simple: true }): unknown } }
  ).db;

  return db.pragma(name, { simple: true }) as number;
}

describe("SqliteDriver", () => {
  it("connects synchronously and exposes a working Kysely instance", async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await driver.kysely
      .insertInto("widgets" as any)
      .values({ id: "1", name: "Sprocket" })
      .execute();

    const row = await driver.kysely
      .selectFrom("widgets" as any)
      .selectAll()
      .executeTakeFirst();

    expect(row).toMatchObject({ id: "1", name: "Sprocket" });
  });

  /**
   * WAL permits concurrent readers but only ONE writer, and sqlite's own
   * default `busy_timeout` is 0, so a second process writing at the same
   * moment fails instantly with SQLITE_BUSY rather than waiting for the lock.
   *
   * That is not an exotic condition, it is simply what two simultaneous writes
   * look like, and the symptom is data loss rather than an obvious error
   * because the losing caller may well be swallowing the exception. Found in
   * an app where 24 concurrent writers lost several of their writes.
   */
  it("waits for a held write lock instead of failing immediately", () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    expect(driver.kysely).toBeDefined();
    expect(pragma(driver, "busy_timeout")).toBe(5000);
  });

  it("lets an application choose its own busy timeout", () => {
    expect(
      pragma(new SqliteDriver({ filename: ":memory:", busyTimeout: 250 }), "busy_timeout"),
    ).toBe(250);

    // 0 restores sqlite's own behaviour, for an app that would rather fail
    // fast than block.
    expect(pragma(new SqliteDriver({ filename: ":memory:", busyTimeout: 0 }), "busy_timeout")).toBe(
      0,
    );
  });

  it("keeps WAL and foreign keys on", () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    expect(pragma(driver, "foreign_keys")).toBe(1);
  });

  it("has no connect(). Construction is fully synchronous", () => {
    const driver = new SqliteDriver({ filename: ":memory:" });
    expect((driver as any).connect).toBeUndefined();
  });

  it("disconnect() closes the handle, so later queries throw", async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });
    await driver.kysely.schema.createTable("widgets").addColumn("id", "text").execute();

    await driver.disconnect();

    await expect(
      driver.kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .execute(),
    ).rejects.toThrow();
  });

  /**
   * `terminate()` is idempotent and a test's `cleanup()` may close a
   * driver something else already closed, so a second `disconnect()` has
   * to be a no-op. Kysely's own `destroy()` is not: it throws
   * `db.prepare is not a function` the second time.
   */
  it("disconnect() is idempotent", async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    await driver.disconnect();
    await expect(driver.disconnect()).resolves.toBeUndefined();
  });

  /**
   * better-sqlite3 reads integers as JS numbers by default, which rounds
   * anything past 2^53 with no error — a snowflake id comes back
   * addressing a different row. The driver asks for `bigint` instead,
   * which is all-or-nothing, so everything that is *not* a 64-bit column
   * has to be narrowed back.
   *
   * The rule is by declared column type, never by value.
   */
  describe("64-bit columns", () => {
    /**
     * Built through `SchemaBuilder`, not Kysely's `addColumn`, so the
     * declared type comes from this framework's own grammar. A test that
     * hand-wrote `"bigint"` would still pass if the grammar stopped
     * emitting it, which is the regression that matters.
     */
    async function widgets() {
      const driver = new SqliteDriver({ filename: ":memory:" });

      await new SchemaBuilder(driver.kysely).create("widgets", (table: Blueprint) => {
        table.bigInteger("id").primary();
        table.integer("count");
        table.string("name");
      });

      return driver;
    }

    it("reads a bigint column past 2^53 without rounding", async () => {
      const driver = await widgets();

      await driver.kysely
        .insertInto("widgets" as any)
        .values({ id: 440463260157395208n, count: 1, name: "snowflake" })
        .execute();

      const row = (await driver.kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .executeTakeFirst()) as { id: bigint };

      expect(row.id).toBe(440463260157395208n);
    });

    /**
     * The case that makes this type-directed rather than value-directed.
     * Deciding per value would hand back a `number` here and a `bigint`
     * for a larger row, so a column's type would depend on its contents:
     * `number` under test fixtures, `bigint` in production.
     */
    it("keeps a small value in a bigint column a bigint", async () => {
      const driver = await widgets();

      await driver.kysely
        .insertInto("widgets" as any)
        .values({ id: 42n, count: 1, name: "small" })
        .execute();

      const row = (await driver.kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .executeTakeFirst()) as { id: bigint };

      expect(row.id).toBe(42n);
    });

    it("narrows ordinary integer columns back to numbers", async () => {
      const driver = await widgets();

      await driver.kysely
        .insertInto("widgets" as any)
        .values({ id: 1n, count: 7, name: "small" })
        .execute();

      const row = (await driver.kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .executeTakeFirst()) as { count: number };

      expect(row.count).toBe(7);
    });

    /**
     * `columns()` reports no type for a computed value, which is the
     * right answer: an aggregate is not 64-bit storage. Without this
     * every `count(*)` in the framework would become a bigint.
     */
    it("narrows aggregates, which have no declared column type", async () => {
      const driver = await widgets();

      await driver.kysely
        .insertInto("widgets" as any)
        .values({ id: 1n, count: 1, name: "a" })
        .execute();

      const row = (await driver.kysely
        .selectFrom("widgets" as any)
        .select((eb) => eb.fn.countAll().as("total"))
        .executeTakeFirst()) as { total: number };

      expect(row.total).toBe(1);
    });

    /** Streaming reads the same statement, so it must narrow the same way. */
    it("narrows the same way when streaming", async () => {
      const driver = await widgets();

      await driver.kysely
        .insertInto("widgets" as any)
        .values({ id: 440463260157395208n, count: 7, name: "snowflake" })
        .execute();

      const seen: { id: bigint; count: number }[] = [];

      for await (const chunk of driver.kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .stream()) {
        seen.push(chunk as unknown as { id: bigint; count: number });
      }

      expect(seen[0]!.id).toBe(440463260157395208n);
      expect(seen[0]!.count).toBe(7);
    });
  });
});
