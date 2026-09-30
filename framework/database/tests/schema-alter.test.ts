import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { SchemaBuilder } from "../src/schema/schema-builder.js";
import type { Blueprint } from "../src/schema/blueprint.js";

function fresh() {
  const driver = new SqliteDriver({ filename: ":memory:" });

  return { driver, db: driver.kysely, schema: new SchemaBuilder(driver.kysely) };
}

async function column(db: any, table: string, name: string) {
  const tables = await db.introspection.getTables();

  return tables
    .find((t: { name: string }) => t.name === table)
    ?.columns.find((c: { name: string }) => c.name === name);
}

describe("Blueprint alter-mode", () => {
  it("adds, drops, and renames columns", async () => {
    const { db, schema } = fresh();

    await schema.create("users", (table: Blueprint) => {
      table.string("id").primary();
      table.string("name");
      table.string("legacy");
    });

    await schema.table("users", (table: Blueprint) => {
      table.string("email").nullable();
      table.dropColumn("legacy");
      table.renameColumn("name", "full_name");
    });

    expect(await schema.hasColumn("users", "email")).toBe(true);
    expect(await schema.hasColumn("users", "legacy")).toBe(false);
    expect(await schema.hasColumn("users", "name")).toBe(false);
    expect(await schema.hasColumn("users", "full_name")).toBe(true);
    expect((await column(db, "users", "email")).isNullable).toBe(true);
  });

  it("dropSoftDeletes and index([...]) work on an existing table", async () => {
    const { db, schema } = fresh();

    await schema.create("users", (table: Blueprint) => {
      table.string("id").primary();
      table.string("email");
      table.softDeletes();
    });

    await schema.table("users", (table: Blueprint) => {
      table.dropSoftDeletes();
      table.index(["email"]);
    });

    expect(await schema.hasColumn("users", "deleted_at")).toBe(false);
    const indexes = await sql<{ name: string }>`PRAGMA index_list("users")`.execute(db);
    expect(indexes.rows.map((r) => r.name)).toContain("users_email_index");
  });

  it("renames a table from inside Blueprint", async () => {
    const { schema } = fresh();
    await schema.create("people", (table: Blueprint) => {
      table.id();
    });
    await schema.table("people", (table: Blueprint) => {
      table.rename("humans");
    });
    expect(await schema.hasTable("people")).toBe(false);
    expect(await schema.hasTable("humans")).toBe(true);
  });

  it("rebuilds the table for .change() and preserves existing rows", async () => {
    const { db, schema } = fresh();

    await schema.create("users", (table: Blueprint) => {
      table.string("id").primary();
      table.string("name");
      table.string("email").unique();
    });

    await db
      .insertInto("users" as any)
      .values({ id: "1", name: "Ada", email: "ada@example.com" })
      .execute();

    await schema.table("users", (table: Blueprint) => {
      table.string("name", 255).nullable().change();
    });

    const nameCol = await column(db, "users", "name");
    expect(nameCol.isNullable).toBe(true);
    expect(nameCol.dataType.toLowerCase()).toBe("text");

    const row = await db
      .selectFrom("users" as any)
      .selectAll()
      .executeTakeFirst();
    expect(row).toMatchObject({ id: "1", name: "Ada", email: "ada@example.com" });

    const indexes = await sql<{ name: string }>`PRAGMA index_list("users")`.execute(db);
    expect(indexes.rows.map((r) => r.name)).toEqual(expect.arrayContaining(["users_email_unique"]));
  });

  /**
   * SQLite cannot attach a constraint to a live table, so this is a rebuild:
   * create, copy, drop, rename. Throwing is not an option: a column added in
   * one phase and pointed at a table that only exists in a later one is an
   * ordinary migration, and telling the author to "define it in create()
   * instead" is advice they cannot take.
   */
  it("adds a foreign key via alter, by rebuilding the table", async () => {
    const { schema, db } = fresh();
    await schema.create("users", (table: Blueprint) => {
      table.id();
    });
    await schema.create("posts", (table: Blueprint) => {
      table.id();
      table.integer("user_id");
    });

    await schema.table("posts", (table: Blueprint) => {
      table.foreign("user_id").references("id").on("users").onDelete("cascade");
    });

    const fks = await sql<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>`PRAGMA foreign_key_list(posts)`.execute(db);

    expect(fks.rows).toHaveLength(1);
    expect(fks.rows[0]?.table).toBe("users");
    expect(fks.rows[0]?.from).toBe("user_id");
    expect(fks.rows[0]?.on_delete).toBe("CASCADE");
  });

  /**
   * The rebuild must not lose the data it is rebuilding around, nor the
   * indexes and constraints that were already there, the failure mode of a
   * copy-and-rename is silent and total.
   */
  it("preserves rows and existing indexes when adding a foreign key", async () => {
    const { schema, db } = fresh();
    await schema.create("users", (table: Blueprint) => {
      table.id();
    });
    await schema.create("posts", (table: Blueprint) => {
      table.id();
      table.integer("user_id");
      table.string("slug").unique();
      table.string("title").index();
    });

    await db.insertInto("users").values({ id: 1 }).execute();
    await db.insertInto("posts").values({ id: 1, user_id: 1, slug: "a", title: "A" }).execute();

    await schema.table("posts", (table: Blueprint) => {
      table.foreign("user_id").references("id").on("users").onDelete("cascade");
    });

    const rows = await db.selectFrom("posts").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("a");

    const indexes = await sql<{ name: string }>`PRAGMA index_list(posts)`.execute(db);
    expect(indexes.rows.length).toBeGreaterThanOrEqual(2);

    // And the constraint is live, not merely declared.
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await db.deleteFrom("users").where("id", "=", 1).execute();

    expect(await db.selectFrom("posts").selectAll().execute()).toHaveLength(0);
  });

  it("throws a clear error for fullText and spatialIndex", async () => {
    const { schema } = fresh();

    await expect(
      schema.create("articles", (table: Blueprint) => {
        table.id();
        table.text("body");
        table.fullText(["body"]);
      }),
    ).rejects.toThrow(/fullText indexes are not supported on sqlite/);

    await expect(
      schema.create("places", (table: Blueprint) => {
        table.id();
        table.spatialIndex(["coords"]);
      }),
    ).rejects.toThrow(/spatialIndex is not supported on sqlite/);
  });
});

/**
 * Dropping a column that an index covers, in one `Schema.table()` call.
 *
 * This is what a `down()` written as the mirror of its `up()` looks like:
 * the `up()` added a column and indexed it, so the `down()` drops the
 * index and the column. `compileAlter()` reorders operations regardless of
 * call order, so the ordering it picks has to make that work.
 */
describe("dropping an indexed column", () => {
  it("drops the index before the column it covers", async () => {
    const { db, schema } = fresh();

    await schema.create("jobs", (table: Blueprint) => {
      table.string("id").primary();
      table.string("queue");
      table.integer("available_at");
    });

    await schema.table("jobs", (table: Blueprint) => {
      table.index(["queue", "available_at"]);
    });

    // The mirror-image down(): drop the index, drop the column. Written in
    // the order a person would write it, which compileAlter() does not
    // preserve, so this is really a test of the order it imposes.
    await schema.table("jobs", (table: Blueprint) => {
      table.dropIndex(["queue", "available_at"]);
      table.dropColumn("queue");
    });

    expect(await schema.hasColumn("jobs", "queue")).toBe(false);

    const indexes = await db.introspection.getTables();
    const jobs = indexes.find((t: { name: string }) => t.name === "jobs");
    expect(jobs).toBeDefined();
  });

  it("drops an index and column named in either call order", async () => {
    // Same operations, opposite call order, must behave identically,
    // since compileAlter() sorts them itself.
    const { schema } = fresh();

    await schema.create("posts", (table: Blueprint) => {
      table.string("id").primary();
      table.string("slug");
    });

    await schema.table("posts", (table: Blueprint) => {
      table.index(["slug"]);
    });

    await schema.table("posts", (table: Blueprint) => {
      table.dropColumn("slug");
      table.dropIndex(["slug"]);
    });

    expect(await schema.hasColumn("posts", "slug")).toBe(false);
  });
});
