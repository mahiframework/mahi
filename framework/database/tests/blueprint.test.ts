import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { SchemaBuilder } from "../src/schema/schema-builder.js";
import { createIndexName } from "../src/schema/index-name.js";
import type { Blueprint } from "../src/schema/blueprint.js";

function fresh() {
  const driver = new SqliteDriver({ filename: ":memory:" });

  return { driver, db: driver.kysely, schema: new SchemaBuilder(driver.kysely) };
}

async function tableColumns(db: any, table: string) {
  const tables = await db.introspection.getTables();

  return tables.find((t: { name: string }) => t.name === table)?.columns ?? [];
}

function affinity(dataType: string): string {
  return dataType.toLowerCase();
}

describe("createIndexName", () => {
  it("matches Laravel's table_col_type convention", () => {
    expect(createIndexName("users", "index", ["email"])).toBe("users_email_index");
    expect(createIndexName("users", "unique", ["email"])).toBe("users_email_unique");
    expect(createIndexName("likes", "unique", ["user_id", "post_id"])).toBe(
      "likes_user_id_post_id_unique",
    );
  });

  it("lowercases and replaces - / . with underscores", () => {
    expect(createIndexName("My-Table", "index", ["foo.bar"])).toBe("my_table_foo_bar_index");
  });
});

describe("Blueprint create-mode column types", () => {
  it("maps Laravel types onto SQLite affinities, nullability, and pk", async () => {
    const { db, schema } = fresh();

    await schema.create("sample", (table: Blueprint) => {
      table.id();
      table.string("name");
      table.string("title", 100).nullable();
      table.char("code", 4);
      table.text("body");
      table.mediumText("medium");
      table.longText("long");
      table.tinyText("tiny");
      table.integer("count");
      table.tinyInteger("tiny_int");
      table.smallInteger("small_int");
      table.mediumInteger("medium_int");
      table.bigInteger("big_int");
      table.unsignedInteger("u_int");
      table.boolean("flag");
      table.float("ratio");
      table.double("precise");
      table.decimal("price", 10, 2);
      table.date("on_date");
      table.dateTime("at_datetime");
      table.timestamp("at_timestamp");
      table.json("payload");
      table.uuid("uuid");
      table.ulid("ulid");
      table.binary("blob");
      table.enum("status", ["draft", "live"]);
      table.ipAddress("ip");
      table.macAddress("mac");
    });

    const cols = await tableColumns(db, "sample");
    const byName = Object.fromEntries(cols.map((c: any) => [c.name, c]));

    expect(affinity(byName.id.dataType)).toBe("integer");
    expect(byName.id.isAutoIncrementing).toBe(true);

    expect(affinity(byName.name.dataType)).toBe("text");
    expect(byName.name.isNullable).toBe(false);

    expect(byName.title.isNullable).toBe(true);

    expect(affinity(byName.count.dataType)).toBe("integer");
    expect(affinity(byName.flag.dataType)).toBe("integer");
    expect(affinity(byName.ratio.dataType)).toBe("real");
    expect(affinity(byName.precise.dataType)).toBe("real");
    expect(affinity(byName.price.dataType)).toBe("numeric");
    expect(affinity(byName.blob.dataType)).toBe("blob");
    expect(affinity(byName.payload.dataType)).toBe("text");
    expect(affinity(byName.at_timestamp.dataType)).toBe("text");
    expect(affinity(byName.body.dataType)).toBe("text");
    expect(affinity(byName.status.dataType)).toBe("text");
  });

  it("applies nullable, unique, default, primary, and index modifiers", async () => {
    const { db, schema } = fresh();

    await schema.create("widgets", (table: Blueprint) => {
      table.string("id").primary();
      table.string("email").unique();
      table.string("nickname").nullable();
      table.integer("count").default(0);
      table.string("slug").index();
    });

    const cols = await tableColumns(db, "widgets");
    const byName = Object.fromEntries(cols.map((c: any) => [c.name, c]));

    expect(byName.id.isNullable).toBe(false);
    expect(byName.email.isNullable).toBe(false);
    expect(byName.nickname.isNullable).toBe(true);
    expect(byName.count.hasDefaultValue).toBe(true);

    const indexes = await sql<{ name: string }>`PRAGMA index_list("widgets")`.execute(db);
    const names = indexes.rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["widgets_email_unique", "widgets_slug_index"]));

    await db
      .insertInto("widgets" as any)
      .values({ id: "1", email: "a@x.com", slug: "a", count: 1 })
      .execute();
    await expect(
      db
        .insertInto("widgets" as any)
        .values({ id: "2", email: "a@x.com", slug: "b", count: 1 })
        .execute(),
    ).rejects.toThrow();
  });

  it("builds timestamps, softDeletes, morphs, and rememberToken helper groups", async () => {
    const { db, schema } = fresh();

    await schema.create("posts", (table: Blueprint) => {
      table.id();
      table.timestamps();
      table.softDeletes();
      table.morphs("commentable");
      table.rememberToken();
    });

    const cols = await tableColumns(db, "posts");
    const byName = Object.fromEntries(cols.map((c: any) => [c.name, c]));

    expect(byName.created_at.isNullable).toBe(true);
    expect(byName.updated_at.isNullable).toBe(true);
    expect(affinity(byName.created_at.dataType)).toBe("text");
    expect(byName.deleted_at.isNullable).toBe(true);
    expect(affinity(byName.commentable_type.dataType)).toBe("text");
    // `morphs()` builds the id as `unsignedBigInteger`, declared `bigint`
    // so the driver can tell a 64-bit column from a rowid. Same INTEGER
    // affinity either way, so nothing about storage changes.
    expect(affinity(byName.commentable_id.dataType)).toBe("bigint");
    expect(byName.remember_token.isNullable).toBe(true);

    const indexes = await sql<{ name: string }>`PRAGMA index_list("posts")`.execute(db);
    expect(indexes.rows.map((r) => r.name)).toContain(
      "posts_commentable_type_commentable_id_index",
    );
  });

  it("creates a string primary key without autoincrement", async () => {
    const { db, schema } = fresh();

    await schema.create("hashtags", (table: Blueprint) => {
      table.string("id").primary();
      table.string("name").unique();
    });

    const cols = await tableColumns(db, "hashtags");
    const id = cols.find((c: any) => c.name === "id");
    expect(affinity(id.dataType)).toBe("text");
    expect(id.isAutoIncrementing).toBe(false);
  });

  it("creates composite unique and primary constraints with Laravel names", async () => {
    const { db, schema } = fresh();

    await schema.create("likes", (table: Blueprint) => {
      table.string("id").primary();
      table.string("user_id");
      table.string("post_id");
      table.unique(["user_id", "post_id"]);
    });

    await schema.create("post_hashtag", (table: Blueprint) => {
      table.string("post_id");
      table.string("hashtag_id");
      table.primary(["post_id", "hashtag_id"]);
    });

    const likeIndexes = await sql<{ name: string }>`PRAGMA index_list("likes")`.execute(db);
    expect(likeIndexes.rows.map((r) => r.name)).toContain("likes_user_id_post_id_unique");

    const pk = await sql<{ name: string; pk: number }>`PRAGMA table_info("post_hashtag")`.execute(
      db,
    );
    expect(
      pk.rows
        .filter((r) => r.pk > 0)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["hashtag_id", "post_id"]);
  });

  it("creates foreign keys at table-create time", async () => {
    const { db, schema } = fresh();

    await schema.create("users", (table: Blueprint) => {
      table.id();
    });
    await schema.create("posts", (table: Blueprint) => {
      table.id();
      table.foreignId("user_id").constrained().cascadeOnDelete();
    });

    const fks = await sql<{ table: string; from: string; to: string; on_delete: string }>`
      PRAGMA foreign_key_list("posts")
    `.execute(db);

    expect(fks.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "users",
          from: "user_id",
          to: "id",
          on_delete: "CASCADE",
        }),
      ]),
    );
  });
});
