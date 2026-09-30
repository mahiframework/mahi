import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ENGINES, EngineHarness, engineAvailable } from "../support/drivers.js";
import type { Blueprint } from "../../src/schema/blueprint.js";

/**
 * `truncateAllTables()` across every engine, the between-tests reset
 * behind `@mahiframework/testing`'s `clearDatabase()`.
 *
 * Cross-engine because every part of it is spelled differently and no
 * part of it is shared: SQLite has no `TRUNCATE` and needs
 * `sqlite_sequence` cleared by hand, MySQL needs a pinned connection for
 * `FOREIGN_KEY_CHECKS` and resets identity only via `TRUNCATE`, Postgres
 * needs one multi-table statement with `RESTART IDENTITY CASCADE` and a
 * `current_schema()` filter. One set of assertions passing on all three
 * is the only way to know a dialect branch hasn't fixed one engine by
 * breaking another.
 */
for (const engine of ENGINES) {
  const available = await engineAvailable(engine);
  const suite = available ? describe : describe.skip;

  suite(`truncateAllTables (${engine.name})`, () => {
    let h: EngineHarness;

    beforeAll(async () => {
      h = await EngineHarness.start(engine, "truncate-all-tables");
    });

    beforeEach(async () => {
      // Fresh schema per test: several of these assert on the state of
      // the tables themselves, not just their rows.
      await h.schema.dropAllTables();

      await h.create("authors", (t: Blueprint) => {
        t.increments("id");
        t.string("name");
      });

      // A child with a real foreign key, so a wipe that ignored
      // dependency order would fail on one of the two orderings.
      await h.create("books", (t: Blueprint) => {
        t.increments("id");
        // Plain `integer`, matching `increments()` on `authors`. MySQL
        // refuses a foreign key between signed and unsigned columns.
        t.integer("author_id");
        t.string("title");
        t.foreign("author_id").references("id").on("authors");
      });
    });

    afterAll(async () => {
      await h?.stop();
    });

    async function seed(): Promise<void> {
      await h.driver.kysely.insertInto("authors").values({ name: "Ursula" }).execute();
      const author: any = await h.driver.kysely
        .selectFrom("authors")
        .select("id")
        .executeTakeFirstOrThrow();
      await h.driver.kysely
        .insertInto("books")
        .values({ author_id: author.id, title: "A Wizard of Earthsea" })
        .execute();
    }

    async function count(table: string): Promise<number> {
      const row: any = await h.driver.kysely
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as("count"))
        .executeTakeFirst();

      return Number(row?.count ?? 0);
    }

    it("deletes every row while leaving the tables in place", async () => {
      await seed();
      expect(await count("authors")).toBe(1);

      await h.schema.truncateAllTables();

      expect(await count("authors")).toBe(0);
      expect(await count("books")).toBe(0);
      // The schema survives: this is the difference from dropAllTables().
      expect(await h.schema.hasTable("authors")).toBe(true);
      expect(await h.schema.hasColumn("books", "title")).toBe(true);
    });

    it("clears a parent and its foreign-key child regardless of order", async () => {
      await seed();

      // The parent is created first, so a naive forward-order wipe would
      // delete `authors` while `books` still references it. Nothing here
      // tracks creation order, so this is the assertion that the FK
      // suppression (or Postgres's single CASCADE statement) is real.
      await h.schema.truncateAllTables();

      expect(await count("books")).toBe(0);
      expect(await count("authors")).toBe(0);

      // And the constraint is still enforced afterwards, so whatever was
      // disabled got re-enabled.
      await expect(
        h.driver.kysely.insertInto("books").values({ author_id: 999, title: "Orphan" }).execute(),
      ).rejects.toThrow();
    });

    it("restarts auto-increment at 1", async () => {
      await seed();
      await h.schema.truncateAllTables();

      await h.driver.kysely.insertInto("authors").values({ name: "Le Guin" }).execute();
      const row: any = await h.driver.kysely
        .selectFrom("authors")
        .select("id")
        .executeTakeFirstOrThrow();

      // Identity is reset on every engine deliberately. Left to their
      // defaults the id would be 2 on Postgres and SQLite and 1 on
      // MySQL, so a test asserting on a generated id would pass on one
      // engine and fail on another.
      expect(Number(row.id)).toBe(1);
    });

    it("preserves the migrations ledger", async () => {
      // The schema survives a truncate, so the record of how it was
      // built has to survive with it. Wiping it would leave the runner
      // believing nothing had run, and the next migrate would replay
      // every migration against tables that already exist.
      await h.create("migrations", (t: Blueprint) => {
        t.increments("id");
        t.string("name");
        t.integer("batch");
      });
      await h.driver.kysely
        .insertInto("migrations")
        .values({ name: "0001_create_authors", batch: 1 })
        .execute();

      await h.schema.truncateAllTables();

      expect(await count("migrations")).toBe(1);
    });

    it("is a no-op on an empty schema", async () => {
      await h.schema.dropAllTables();

      // Postgres builds one `TRUNCATE a, b, c` statement, and `TRUNCATE`
      // with no tables is a syntax error rather than a no-op.
      await expect(h.schema.truncateAllTables()).resolves.toBeUndefined();
    });
  });
}

/**
 * Postgres only: the wipe must not reach outside the connection's own
 * schema. `getTables()` reports every schema in the database, and
 * `CASCADE` reaches further still, so an unfiltered truncate could empty
 * a neighbouring application sharing the database.
 */
const postgres = ENGINES.find((engine) => engine.name === "postgres")!;
const postgresSuite = (await engineAvailable(postgres)) ? describe : describe.skip;

postgresSuite("truncateAllTables (postgres, schema scoping)", () => {
  let h: EngineHarness;

  beforeAll(async () => {
    h = await EngineHarness.start(postgres, "truncate-schema-scope");
  });

  afterAll(async () => {
    await sql`drop schema if exists neighbour cascade`.execute(h.driver.kysely).catch(() => {});
    await h?.stop();
  });

  it("leaves tables in another schema untouched", async () => {
    await sql`drop schema if exists neighbour cascade`.execute(h.driver.kysely);
    await sql`create schema neighbour`.execute(h.driver.kysely);
    await sql`create table neighbour.widgets (id serial primary key, name text)`.execute(
      h.driver.kysely,
    );
    await sql`insert into neighbour.widgets (name) values ('keep me')`.execute(h.driver.kysely);

    await h.create("gadgets", (t: Blueprint) => {
      t.increments("id");
      t.string("name");
    });
    await h.driver.kysely.insertInto("gadgets").values({ name: "wipe me" }).execute();

    await h.schema.truncateAllTables();

    const gadgets: any = await h.driver.kysely
      .selectFrom("gadgets")
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirst();
    expect(Number(gadgets.count)).toBe(0);

    const neighbour = await sql<{
      count: string;
    }>`select count(*) as count from neighbour.widgets`.execute(h.driver.kysely);
    expect(Number(neighbour.rows[0]!.count)).toBe(1);
  });
});
