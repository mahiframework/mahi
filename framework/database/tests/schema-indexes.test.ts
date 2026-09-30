import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { SchemaBuilder } from "../src/schema/schema-builder.js";
import { UniqueConstraintViolationException } from "../src/exceptions.js";
import { createIndex } from "../src/schema/grammars/indexes.js";
import { indexExpression } from "../src/schema/types.js";
import type { Blueprint } from "../src/schema/blueprint.js";
import type { Dialect } from "../src/schema/dialect.js";

/**
 * `IndexOptions`: partial predicates, index methods, operator classes,
 * `NULLS NOT DISTINCT`, and expression (functional) indexes.
 *
 * Almost all of this runs without a database server, including the
 * "throws on MySQL/Postgres" half. `assertSupportedIndexes()` runs off
 * the *grammar*, which `SchemaBuilder` picks from its `dialect`
 * argument rather than from the live connection, and it runs before any
 * DDL is emitted. So pointing a MySQL grammar at an in-memory SQLite
 * connection is enough to assert the contract, and the suite never
 * skips.
 *
 * The behavioural halves (two nulls insert, duplicate non-null throws)
 * do need a real engine, and use the SQLite one, which has partial
 * indexes with the same `WHERE` syntax Postgres uses. The Postgres-only
 * features are asserted against live Postgres in
 * `drivers/mysql-postgres.integration.test.ts`.
 */

function fresh(dialect: Dialect = "sqlite") {
  const driver = new SqliteDriver({ filename: ":memory:" });

  return { driver, db: driver.kysely, schema: new SchemaBuilder(driver.kysely, dialect) };
}

/** The index names SQLite reports for a table. */
async function indexNames(db: any, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`PRAGMA index_list(${sql.raw(`"${table}"`)})`.execute(db);

  return rows.rows.map((r) => r.name);
}

/** The stored `CREATE INDEX` SQL for one index, as SQLite recorded it. */
async function indexSql(db: any, name: string): Promise<string | null> {
  const rows = await sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}
  `.execute(db);

  return rows.rows[0]?.sql ?? null;
}

describe("partial indexes", () => {
  /**
   * The case the whole feature exists for, and the reason it is not
   * merely an optimisation: "at most one non-null, unlimited nulls" has
   * no non-partial spelling.
   */
  it("a partial unique index permits many nulls but one non-null", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
      table.unsignedBigInteger("torrent_id").nullable();
      table.unique("torrent_id", { where: "torrent_id is not null" });
    });

    // The half that distinguishes this from a plain unique(): a plain
    // one would also allow these, but only because Postgres/SQLite treat
    // nulls as distinct — so this alone proves nothing. It is the pair
    // of assertions that pins the behaviour.
    await db.insertInto("downloads").values({ torrent_id: null }).execute();
    await db.insertInto("downloads").values({ torrent_id: null }).execute();
    expect(await db.selectFrom("downloads").selectAll().execute()).toHaveLength(2);

    await db.insertInto("downloads").values({ torrent_id: 10 }).execute();

    await expect(
      db.insertInto("downloads").values({ torrent_id: 10 }).execute(),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  it("emits the predicate into the index, under the conventional name", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
      table.unsignedBigInteger("torrent_id").nullable();
      table.unique("torrent_id", { where: "torrent_id is not null" });
    });

    expect(await indexNames(db, "downloads")).toContain("downloads_torrent_id_unique");

    const ddl = await indexSql(db, "downloads_torrent_id_unique");
    expect(ddl).toMatch(/where/i);
    expect(ddl).toMatch(/torrent_id is not null/i);
  });

  it("works on a non-unique index too", async () => {
    const { db, schema } = fresh();

    await schema.create("jobs", (table: Blueprint) => {
      table.id();
      table.string("state");
      table.index("state", { where: "state = 'pending'" });
    });

    expect(await indexNames(db, "jobs")).toContain("jobs_state_index");
    expect(await indexSql(db, "jobs_state_index")).toMatch(/where/i);
  });

  /**
   * SQLite fakes `ALTER TABLE` with a table rebuild, replaying indexes
   * from `sqlite_master`. A partial index has to survive that, or the
   * predicate silently disappears on the next unrelated column change.
   */
  it("survives the SQLite table rebuild an unrelated change triggers", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
      table.string("label");
      table.unsignedBigInteger("torrent_id").nullable();
      table.unique("torrent_id", { where: "torrent_id is not null" });
    });

    // Changing an unrelated column forces the rebuild.
    await schema.table("downloads", (table: Blueprint) => {
      table.string("label", 100).nullable().change();
    });

    expect(await indexSql(db, "downloads_torrent_id_unique")).toMatch(/torrent_id is not null/i);

    // Still enforced after the rebuild, not merely still present.
    await db.insertInto("downloads").values({ label: "a", torrent_id: 10 }).execute();
    await expect(
      db.insertInto("downloads").values({ label: "b", torrent_id: 10 }).execute(),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  it("throws on MySQL, naming the dialect", async () => {
    const { schema } = fresh("mysql");

    await expect(
      schema.create("downloads", (table: Blueprint) => {
        table.id();
        table.unsignedBigInteger("torrent_id").nullable();
        table.unique("torrent_id", { where: "torrent_id is not null" });
      }),
    ).rejects.toThrow(/Partial indexes .* are not supported on mysql/);
  });
});

describe("index methods (using)", () => {
  it("throws on SQLite rather than silently creating a btree", async () => {
    const { schema } = fresh();

    await expect(
      schema.create("profiles", (table: Blueprint) => {
        table.id();
        table.jsonb("criteria");
        table.index("criteria", { using: "gin" });
      }),
    ).rejects.toThrow(/Index methods .* are not supported on sqlite/);
  });

  /**
   * MySQL has `USING`, but only over btree/hash. Without the value
   * check, `supportsIndexMethods: true` would be a half-truth and
   * `using: "gin"` would reach the server as a syntax error.
   */
  it("rejects a method MySQL does not have", async () => {
    await expect(
      fresh("mysql").schema.create("profiles", (table: Blueprint) => {
        table.id();
        table.json("criteria");
        table.index("criteria", { using: "gin" });
      }),
    ).rejects.toThrow(/Index method "gin" .* is not supported on mysql/);
  });

  /**
   * The two methods MySQL does have must clear validation. Asserted via
   * the error SQLite raises on the `USING` clause itself: the grammar is
   * MySQL's but the connection underneath is SQLite, so reaching a
   * SQLite *syntax* error proves the clause was emitted rather than
   * rejected here. Every column is a type both dialects spell the same
   * way, so nothing earlier in the CREATE can fail first and mask it.
   */
  it("emits the two methods MySQL does have", async () => {
    for (const using of ["btree", "hash"] as const) {
      await expect(
        fresh("mysql").schema.create("profiles", (table: Blueprint) => {
          table.string("criteria");
          table.index("criteria", { using });
        }),
      ).rejects.toThrow(/near "using": syntax error/);
    }
  });

  it("passes an unvalidated method through on Postgres", async () => {
    // `brin` is real but outside Kysely's IndexType union, so this pins
    // that the escape hatch reaches the engine rather than being
    // rejected by our own validation. Same reasoning as above.
    await expect(
      fresh("postgres").schema.create("readings", (table: Blueprint) => {
        table.string("taken_at");
        table.index("taken_at", { using: "brin" });
      }),
    ).rejects.toThrow(/near "using": syntax error/);
  });
});

describe("operator classes (opclass)", () => {
  it("throws on SQLite and MySQL", async () => {
    await expect(
      fresh().schema.create("metas", (table: Blueprint) => {
        table.id();
        table.string("title");
        table.index("title", { opclass: { title: "gin_trgm_ops" } });
      }),
    ).rejects.toThrow(/Operator classes .* are not supported on sqlite/);

    await expect(
      fresh("mysql").schema.create("metas", (table: Blueprint) => {
        table.id();
        table.string("title");
        table.index("title", { opclass: { title: "gin_trgm_ops" } });
      }),
    ).rejects.toThrow(/Operator classes .* are not supported on mysql/);
  });

  it("rejects a key that names no indexed column", async () => {
    // Otherwise the typo is dropped in silence and the index loses the
    // very thing it was created for.
    await expect(
      fresh("postgres").schema.create("metas", (table: Blueprint) => {
        table.id();
        table.string("title");
        table.index("title", { using: "gin", opclass: { titel: "gin_trgm_ops" } });
      }),
    ).rejects.toThrow(/names column "titel", which is not part of the index/);
  });

  it("rejects an operator class that is not a bare identifier", async () => {
    // It occupies a position where it cannot be quoted, so validation is
    // the only thing standing between it and the emitted SQL.
    await expect(
      fresh("postgres").schema.create("metas", (table: Blueprint) => {
        table.id();
        table.string("title");
        table.index("title", { using: "gin", opclass: { title: "gin_trgm_ops)" } });
      }),
    ).rejects.toThrow(/Operator class "gin_trgm_ops\)" .* is not a valid identifier/);
  });
});

describe("nullsNotDistinct", () => {
  it("throws on SQLite and MySQL, pointing at the Postgres version", async () => {
    await expect(
      fresh().schema.create("downloads", (table: Blueprint) => {
        table.id();
        table.unsignedBigInteger("torrent_id").nullable();
        table.unique("torrent_id", { nullsNotDistinct: true });
      }),
    ).rejects.toThrow(/"nullsNotDistinct" .* not supported on sqlite; it needs Postgres 15/);

    await expect(
      fresh("mysql").schema.create("downloads", (table: Blueprint) => {
        table.id();
        table.unsignedBigInteger("torrent_id").nullable();
        table.unique("torrent_id", { nullsNotDistinct: true });
      }),
    ).rejects.toThrow(/"nullsNotDistinct" .* not supported on mysql/);
  });

  it("throws on a non-unique index, which Postgres rejects anyway", async () => {
    await expect(
      fresh("postgres").schema.create("downloads", (table: Blueprint) => {
        table.id();
        table.unsignedBigInteger("torrent_id").nullable();
        table.index("torrent_id", { nullsNotDistinct: true });
      }),
    ).rejects.toThrow(/applies only to unique indexes, not "index"/);
  });
});

/**
 * The Postgres SQL these options compile to, captured without a server.
 *
 * `DummyDriver` plus the real Postgres compiler means the statement is
 * built and spelled exactly as it would be against a live database, but
 * never executed — the only way to assert the `gin`/`opclass` emission,
 * which no SQLite connection can accept. The live-engine tests in
 * `drivers/mysql-postgres.integration.test.ts` then prove Postgres
 * agrees these are valid.
 */
describe("emitted Postgres SQL", () => {
  /**
   * Runs `createIndex()` against a `DummyDriver`-backed Kysely and
   * returns the SQL it emitted. `DummyDriver` resolves every query
   * without a database, so the statement is fully compiled by the real
   * Postgres compiler and simply never sent.
   */
  async function emit(idx: Parameters<typeof createIndex>[2]): Promise<string> {
    const compiled: string[] = [];
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (inner) => new PostgresIntrospector(inner),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log: (event) => {
        compiled.push(event.query.sql);
      },
    });

    await createIndex(db, "metas", idx);

    return compiled[0] ?? "";
  }

  it("spells a GIN index with a per-column operator class", async () => {
    // The index that makes a substring search fast, and the exact shape
    // the trigram case needs.
    expect(
      await emit({
        name: "metas_title_trgm",
        columns: ["title"],
        unique: false,
        using: "gin",
        opclass: { title: "gin_trgm_ops" },
      }),
    ).toBe(`create index "metas_title_trgm" on "metas" using gin ("title" gin_trgm_ops)`);
  });

  it("leaves columns without an operator class as plain references", async () => {
    expect(
      await emit({
        name: "metas_mixed",
        columns: ["title", "body"],
        unique: false,
        using: "gin",
        opclass: { title: "gin_trgm_ops" },
      }),
    ).toBe(`create index "metas_mixed" on "metas" using gin ("title" gin_trgm_ops, "body")`);
  });

  it("spells a plain GIN index on a jsonb column", async () => {
    expect(
      await emit({
        name: "profiles_criteria_gin",
        columns: ["criteria"],
        unique: false,
        using: "gin",
      }),
    ).toBe(`create index "profiles_criteria_gin" on "metas" using gin ("criteria")`);
  });

  it("spells a partial unique index", async () => {
    expect(
      await emit({
        name: "downloads_torrent_id_unique",
        columns: ["torrent_id"],
        unique: true,
        where: "torrent_id is not null",
      }),
    ).toBe(
      `create unique index "downloads_torrent_id_unique" on "metas" ("torrent_id") where torrent_id is not null`,
    );
  });

  it("spells nulls not distinct", async () => {
    expect(
      await emit({
        name: "downloads_torrent_id_unique",
        columns: ["torrent_id"],
        unique: true,
        nullsNotDistinct: true,
      }),
    ).toBe(
      `create unique index "downloads_torrent_id_unique" on "metas" ("torrent_id") nulls not distinct`,
    );
  });
});

describe("index option plumbing", () => {
  /**
   * `namedIndex()`/`namedUnique()` must stay the single source of the
   * generated name, so a `down()` written as the mirror of its `up()`
   * drops what `up()` created without either side hard-coding the
   * string. An index with options is no different.
   */
  it("round-trips a generated name through drop", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
      table.unsignedBigInteger("torrent_id").nullable();
      table.unique("torrent_id", { where: "torrent_id is not null" });
    });

    expect(await indexNames(db, "downloads")).toContain("downloads_torrent_id_unique");

    // Neither side named the index; both resolve it the same way.
    await schema.table("downloads", (table: Blueprint) => {
      table.dropUnique(["torrent_id"]);
    });

    expect(await indexNames(db, "downloads")).not.toContain("downloads_torrent_id_unique");
  });

  it("still accepts the positional name, and honours name inside options", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
      table.string("hash");
      table.unsignedBigInteger("torrent_id").nullable();
      // The original two-argument signature.
      table.unique("hash", "downloads_hash_key");
      // The same thing via options, alongside another option.
      table.index("torrent_id", {
        name: "downloads_torrent_idx",
        where: "torrent_id is not null",
      });
    });

    const names = await indexNames(db, "downloads");
    expect(names).toContain("downloads_hash_key");
    expect(names).toContain("downloads_torrent_idx");
  });

  it("applies options to an index added by Schema.table()", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
    });

    await schema.table("downloads", (table: Blueprint) => {
      table.unsignedBigInteger("torrent_id").nullable();
      table.unique("torrent_id", { where: "torrent_id is not null" });
    });

    expect(await indexSql(db, "downloads_torrent_id_unique")).toMatch(/torrent_id is not null/i);
  });

  it("leaves an ordinary index untouched", async () => {
    // The no-options path must emit exactly what it did before.
    const { db, schema } = fresh();

    await schema.create("posts", (table: Blueprint) => {
      table.id();
      table.string("slug");
      table.string("author");
      table.unique("slug");
      table.index(["author", "slug"]);
    });

    const names = await indexNames(db, "posts");
    expect(names).toContain("posts_slug_unique");
    expect(names).toContain("posts_author_slug_index");
    expect(await indexSql(db, "posts_slug_unique")).not.toMatch(/where/i);
  });
});

/**
 * Expression (functional) indexes: an index over a computed value rather
 * than a stored column.
 *
 * Every engine here supports them, so unlike the Postgres-only options
 * above there is no capability flag — what there is instead is a naming
 * problem, since the `{table}_{cols}_{type}` convention has nothing to
 * work from.
 */
describe("expression indexes", () => {
  it("indexes a computed value, and enforces uniqueness over it", async () => {
    const { db, schema } = fresh();

    await schema.create("users", (table: Blueprint) => {
      table.id();
      table.string("email");
      table.unique([indexExpression(`lower("email")`)], { name: "users_email_lower_unique" });
    });

    expect(await indexNames(db, "users")).toContain("users_email_lower_unique");

    await db.insertInto("users").values({ email: "A@example.com" }).execute();

    // Differs only by case, so the stored values are distinct but the
    // indexed expression is not. A plain unique("email") would allow it.
    await expect(
      db.insertInto("users").values({ email: "a@EXAMPLE.com" }).execute(),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  it("mixes expressions with plain columns in one index", async () => {
    const { db, schema } = fresh();

    await schema.create("posts", (table: Blueprint) => {
      table.id();
      table.string("tenant");
      table.string("slug");
      table.unique(["tenant", indexExpression(`lower("slug")`)], {
        name: "posts_tenant_slug_lower_unique",
      });
    });

    await db.insertInto("posts").values({ tenant: "a", slug: "Hello" }).execute();
    // Same tenant, slug differing only by case: collides.
    await expect(
      db.insertInto("posts").values({ tenant: "a", slug: "HELLO" }).execute(),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);

    // Different tenant: fine, so the plain column half still discriminates.
    await db.insertInto("posts").values({ tenant: "b", slug: "hello" }).execute();
    expect(await db.selectFrom("posts").selectAll().execute()).toHaveLength(2);
  });

  it("combines with the other options", async () => {
    const { db, schema } = fresh();

    await schema.create("downloads", (table: Blueprint) => {
      table.id();
      table.string("path").nullable();
      table.unique([indexExpression(`lower("path")`)], {
        name: "downloads_path_lower_unique",
        where: "path is not null",
      });
    });

    const ddl = await indexSql(db, "downloads_path_lower_unique");
    expect(ddl).toMatch(/lower/i);
    expect(ddl).toMatch(/where/i);

    // Partial, so two nulls are fine...
    await db.insertInto("downloads").values({ path: null }).execute();
    await db.insertInto("downloads").values({ path: null }).execute();
    // ...and functional, so case-insensitive duplicates are not.
    await db.insertInto("downloads").values({ path: "/A" }).execute();
    await expect(
      db.insertInto("downloads").values({ path: "/a" }).execute(),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  /**
   * The naming convention cannot serve an expression: it would produce
   * `metas_to_tsvector('english', title)_index`, which is mangled and
   * impossible for a `down()` to reproduce. So the name is required, and
   * omitting it is an error rather than a broken identifier.
   */
  it("requires an explicit name", async () => {
    await expect(
      fresh().schema.create("metas", (table: Blueprint) => {
        table.string("title");
        table.index([indexExpression(`lower("title")`)]);
      }),
    ).rejects.toThrow(/needs an explicit name/);
  });

  it("names the offending expression when it throws", async () => {
    await expect(
      fresh().schema.create("metas", (table: Blueprint) => {
        table.string("title");
        table.index([indexExpression(`lower("title")`)]);
      }),
    ).rejects.toThrow(/lower\("title"\)/);
  });

  /**
   * A plain string must never be reinterpreted as SQL: that would turn
   * every column name into an injection surface. Kysely parses each
   * string as an ordered column name, so SQL passed as one fails to
   * compile rather than executing.
   */
  it("does not treat a bare string as an expression", async () => {
    await expect(
      fresh().schema.create("metas", (table: Blueprint) => {
        table.string("title");
        table.index(["lower(title)"], { name: "metas_bad" });
      }),
    ).rejects.toThrow();
  });

  it("rejects an expression in a primary key", async () => {
    // A PRIMARY KEY is a table constraint, so there is nothing to put an
    // expression on. `primary()` is typed to refuse one; this pins the
    // runtime guard behind that type.
    const { schema } = fresh();

    await expect(
      schema.create("metas", (table: Blueprint) => {
        table.string("title");
        (table as any).primary([indexExpression(`lower("title")`)]);
      }),
    ).rejects.toThrow(/cannot be an expression/);
  });

  it("survives the SQLite table rebuild", async () => {
    const { db, schema } = fresh();

    await schema.create("users", (table: Blueprint) => {
      table.id();
      table.string("label");
      table.string("email");
      table.unique([indexExpression(`lower("email")`)], { name: "users_email_lower_unique" });
    });

    await schema.table("users", (table: Blueprint) => {
      table.string("label", 100).nullable().change();
    });

    expect(await indexSql(db, "users_email_lower_unique")).toMatch(/lower/i);

    await db.insertInto("users").values({ label: "a", email: "A@x.com" }).execute();
    await expect(
      db.insertInto("users").values({ label: "b", email: "a@X.com" }).execute(),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });
});
