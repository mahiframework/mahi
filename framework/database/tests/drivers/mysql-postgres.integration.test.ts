import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { DatabaseDriver } from "../../src/drivers/driver.js";
import { ENGINES, engineAvailable, withDatabase, dropDatabase } from "../support/drivers.js";
import { SchemaBuilder } from "../../src/schema/schema-builder.js";
import { QueryBuilder } from "../../src/query-builder.js";
import type { Blueprint } from "../../src/schema/blueprint.js";
import {
  ForeignKeyConstraintViolationException,
  NotNullConstraintViolationException,
  UniqueConstraintViolationException,
} from "../../src/exceptions.js";
import { indexExpression } from "../../src/schema/types.js";

/**
 * These tests exercise the MySQL and Postgres drivers against the real
 * engines from the repo-root `docker-compose.yml`. They connect once per
 * suite; if the database isn't reachable (CI without docker), the whole
 * suite is skipped rather than failing, the SQLite suites already cover
 * the dialect-agnostic behaviour.
 *
 * Connection details, availability probing and the per-file scratch
 * database all come from `../support/drivers.ts`, which the cross-dialect
 * suite shares. The scratch database matters here specifically: this file
 * calls `dropAllTables()` repeatedly, and vitest runs test files in
 * parallel, so sharing one database with the cross-dialect suite meant
 * dropping tables out from under it.
 */

const engines = ENGINES.filter((e) => e.external);

for (const engine of engines) {
  describe(`${engine.name} driver`, async () => {
    const available = await engineAvailable(engine);
    const maybe = available ? describe : describe.skip;

    maybe(`${engine.name} (live)`, () => {
      let driver: DatabaseDriver;
      let schema: SchemaBuilder;
      let database: string | undefined;

      beforeAll(async () => {
        database = await withDatabase(engine, "mysql_postgres");
        driver = engine.make(database);
        await driver.connect?.();
        schema = new SchemaBuilder(driver.kysely, driver.dialect);
        await schema.dropAllTables();
      });

      afterAll(async () => {
        if (!driver) {
          return;
        }

        await schema.dropAllTables();
        await driver.disconnect?.();
        await dropDatabase(engine, database);
      });

      it("creates a table with an auto-increment PK and CRUD works", async () => {
        await schema.create("widgets", (t: Blueprint) => {
          t.id();
          t.string("name");
          t.integer("qty").default(0);
          t.boolean("active").default(true);
          t.timestamps();
        });

        expect(await schema.hasTable("widgets")).toBe(true);
        expect(await schema.hasColumn("widgets", "name")).toBe(true);

        const table = () => new QueryBuilder(() => driver.kysely, "widgets");

        await table().insert({ name: "Sprocket", qty: 3 } as any);

        const rows = await table().where("name", "Sprocket").get();
        expect(rows).toHaveLength(1);
        expect(String(rows[0]!.name)).toBe("Sprocket");

        await table()
          .where("name", "Sprocket")
          .update({ qty: 10 } as any);
        const updated = await table().where("name", "Sprocket").first();
        expect(Number(updated!.qty)).toBe(10);

        expect(await table().count()).toBe(1);
      });

      it("enforces a unique index and raises UniqueConstraintViolationException", async () => {
        await schema.create("accounts", (t: Blueprint) => {
          t.id();
          t.string("email").unique();
        });

        const table = () => new QueryBuilder(() => driver.kysely, "accounts");
        await table().insert({ email: "a@example.com" } as any);

        await expect(table().insert({ email: "a@example.com" } as any)).rejects.toBeInstanceOf(
          UniqueConstraintViolationException,
        );
      });

      it("raises NotNullConstraintViolationException for a null in a NOT NULL column", async () => {
        await schema.create("profiles", (t: Blueprint) => {
          t.id();
          t.string("handle");
        });

        const table = () => new QueryBuilder(() => driver.kysely, "profiles");
        await expect(table().insert({ handle: null } as any)).rejects.toBeInstanceOf(
          NotNullConstraintViolationException,
        );
      });

      it("enforces foreign keys and raises ForeignKeyConstraintViolationException", async () => {
        await schema.create("authors", (t: Blueprint) => {
          t.id();
          t.string("name");
        });
        await schema.create("books", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("author_id");
          t.foreign("author_id").references("id").on("authors").cascadeOnDelete();
        });

        const books = () => new QueryBuilder(() => driver.kysely, "books");
        await expect(books().insert({ author_id: 99999 } as any)).rejects.toBeInstanceOf(
          ForeignKeyConstraintViolationException,
        );
      });

      it("adds and drops columns via ALTER TABLE in place", async () => {
        await schema.create("posts", (t: Blueprint) => {
          t.id();
          t.string("title");
          t.string("legacy").nullable();
        });

        await schema.table("posts", (t: Blueprint) => {
          t.text("body").nullable();
          t.dropColumn("legacy");
        });

        expect(await schema.hasColumn("posts", "body")).toBe(true);
        expect(await schema.hasColumn("posts", "legacy")).toBe(false);
      });

      it("dropAllTables clears the schema", async () => {
        await schema.create("temp_a", (t: Blueprint) => t.id());
        await schema.create("temp_b", (t: Blueprint) => t.id());
        await schema.dropAllTables();
        expect(await schema.hasTable("temp_a")).toBe(false);
        expect(await schema.hasTable("temp_b")).toBe(false);
      });

      it("round-trips a value through sql template execution", async () => {
        const result = await sql<{ one: number }>`SELECT 1 as one`.execute(driver.kysely);
        expect(Number(result.rows[0]!.one)).toBe(1);
      });

      it("dropAllTables drops FK-linked tables in any order (M10: session variable)", async () => {
        // The parent is created first, so it is dropped first, which
        // only works while FK enforcement is genuinely suspended for
        // the whole sequence, not just the connection the SET landed
        // on.
        await schema.create("m10_parent", (t: Blueprint) => t.id());
        await schema.create("m10_child", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("parent_id");
          t.foreign("parent_id").references("id").on("m10_parent");
        });

        await schema.dropAllTables();
        expect(await schema.hasTable("m10_parent")).toBe(false);
        expect(await schema.hasTable("m10_child")).toBe(false);
      });

      it("dropForeign() removes the constraint (MySQL needs DROP FOREIGN KEY)", async () => {
        await schema.create("fk_parent", (t: Blueprint) => t.id());
        await schema.create("fk_child", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("parent_id");
          t.foreign("parent_id").references("id").on("fk_parent");
        });

        const child = () => new QueryBuilder(() => driver.kysely, "fk_child");
        await expect(child().insert({ parent_id: 99999 } as any)).rejects.toBeInstanceOf(
          ForeignKeyConstraintViolationException,
        );

        await schema.table("fk_child", (t: Blueprint) => {
          t.dropForeign(["parent_id"]);
        });

        // With the constraint gone the orphan row is accepted.
        await child().insert({ parent_id: 99999 } as any);
        expect(await child().count()).toBe(1);
      });

      it("enum columns reject a value outside the declared set", async () => {
        await schema.create("enum_rows", (t: Blueprint) => {
          t.id();
          t.enum("status", ["draft", "live"]);
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "enum_rows");
        await rows().insert({ status: "draft" } as any);
        expect(await rows().count()).toBe(1);

        // MySQL enforces this with its native enum type; Postgres needs
        // the CHECK constraint the grammar adds beside the varchar.
        await expect(rows().insert({ status: "banana" } as any)).rejects.toThrow();
      });

      it("a partial unique index permits many nulls but one non-null", async () => {
        // MySQL has no partial indexes, so the migration below cannot
        // run there at all. That contract has its own case further down,
        // and is asserted without a server in `../schema-indexes.test.ts`;
        // this one is about Postgres enforcing what it created.
        if (engine.name !== "postgres") {
          return;
        }

        await schema.create("partial_downloads", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("torrent_id").nullable();
          t.unique("torrent_id", { where: "torrent_id is not null" });
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "partial_downloads");

        await rows().insert({ torrent_id: null } as any);
        await rows().insert({ torrent_id: null } as any);
        expect(await rows().count()).toBe(2);

        await rows().insert({ torrent_id: 10 } as any);
        await expect(rows().insert({ torrent_id: 10 } as any)).rejects.toBeInstanceOf(
          UniqueConstraintViolationException,
        );
      });

      it("a GIN index on jsonb serves a containment query", async () => {
        if (engine.name !== "postgres") {
          return;
        }

        await schema.create("gin_profiles", (t: Blueprint) => {
          t.id();
          t.jsonb("criteria");
          t.index("criteria", { using: "gin" });
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "gin_profiles");
        await rows().insert({ criteria: JSON.stringify({ tags: ["x", "y"] }) } as any);
        await rows().insert({ criteria: JSON.stringify({ tags: ["z"] }) } as any);

        // Correctness only: that the index exists and the containment
        // query still returns the right rows. Not asserting the planner
        // chose it, which would be testing Postgres rather than this.
        const hasX = await rows().whereJsonContains("criteria->tags", "x").get();
        expect(hasX).toHaveLength(1);
      });

      it("a GIN index can name a trigram operator class", async () => {
        if (engine.name !== "postgres") {
          return;
        }

        // The extension stays the application's own explicit statement:
        // creating one is a privileged, database-wide side effect that a
        // table blueprint should not perform implicitly. The framework
        // only has to let the index *reference* the opclass.
        await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(driver.kysely);

        await schema.create("trgm_metas", (t: Blueprint) => {
          t.id();
          t.string("title");
          t.index("title", { using: "gin", opclass: { title: "gin_trgm_ops" } });
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "trgm_metas");
        await rows().insert({ title: "Inception" } as any);

        const found = await rows().whereLike("title", "%ncep%").get();
        expect(found).toHaveLength(1);
      });

      it("nullsNotDistinct makes nulls collide", async () => {
        if (engine.name !== "postgres") {
          return;
        }

        // The exact inverse of the partial-unique case above: there two
        // nulls were fine, here the second one is the violation.
        await schema.create("strict_downloads", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("torrent_id").nullable();
          t.unique("torrent_id", { nullsNotDistinct: true });
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "strict_downloads");
        await rows().insert({ torrent_id: null } as any);

        await expect(rows().insert({ torrent_id: null } as any)).rejects.toBeInstanceOf(
          UniqueConstraintViolationException,
        );
      });

      it("rejects a partial index on MySQL before any DDL runs", async () => {
        if (engine.name !== "mysql") {
          return;
        }

        await expect(
          schema.create("mysql_partial", (t: Blueprint) => {
            t.id();
            t.unsignedBigInteger("torrent_id").nullable();
            t.unique("torrent_id", { where: "torrent_id is not null" });
          }),
        ).rejects.toThrow(/Partial indexes .* are not supported on mysql/);

        // Nothing was created: the throw happens before the CREATE TABLE.
        expect(await schema.hasTable("mysql_partial")).toBe(false);
      });

      /**
       * Expression indexes work on **both** server engines, unlike every
       * option above, so this one is unguarded. MySQL calls them
       * functional key parts and needs the expression parenthesised,
       * which the caller writes into the expression itself.
       */
      it("enforces uniqueness over an expression", async () => {
        const parens = engine.name === "mysql" ? ["(", ")"] : ["", ""];
        const quote = engine.name === "mysql" ? "`" : `"`;

        await schema.create("expr_users", (t: Blueprint) => {
          t.id();
          t.string("email");
          t.unique([indexExpression(`${parens[0]}lower(${quote}email${quote})${parens[1]}`)], {
            name: "expr_users_email_lower_unique",
          });
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "expr_users");
        await rows().insert({ email: "A@example.com" } as any);

        // Distinct as stored, identical once lowered.
        await expect(rows().insert({ email: "a@EXAMPLE.com" } as any)).rejects.toBeInstanceOf(
          UniqueConstraintViolationException,
        );
      });

      /**
       * Postgres full-text search, end to end.
       *
       * This is the shape Laravel's Postgres `fullText()` uses: a GIN
       * index over `to_tsvector(...)` directly, with **no generated
       * column and no `tsvector` column type**. Expression indexes are
       * the whole prerequisite, which is why `fullText()` itself stays
       * MySQL-only.
       */
      it("serves a full-text query from an expression index", async () => {
        if (engine.name !== "postgres") {
          return;
        }

        const vector = `to_tsvector('english', coalesce("title", '') || ' ' || coalesce("body", ''))`;

        await schema.create("fts_docs", (t: Blueprint) => {
          t.id();
          t.string("title");
          t.text("body");
          t.index([indexExpression(`(${vector})`)], {
            name: "fts_docs_searchable",
            using: "gin",
          });
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "fts_docs");
        await rows().insert({ title: "Inception", body: "a dream within a dream" } as any);
        await rows().insert({ title: "Heat", body: "a crew in Los Angeles" } as any);

        const { rows: found } = await sql<{ title: string }>`
          select title from fts_docs where ${sql.raw(vector)} @@ to_tsquery('english', 'dream')
        `.execute(driver.kysely);

        expect(found.map((r) => r.title)).toEqual(["Inception"]);
      });
    });
  });
}
