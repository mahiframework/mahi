import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { ENGINES, EngineHarness, engineAvailable, type TestEngine } from "../support/drivers.js";
import { Model } from "../../src/model.js";
import { MigrationRunner } from "../../src/migrator.js";
import { QueryBuilder } from "../../src/query-builder.js";
import { Cast } from "../../src/casts.js";
import { belongsTo, belongsToMany, hasMany, morphMany } from "../../src/relations.js";
import type { BelongsTo, BelongsToMany, HasMany, MorphMany } from "../../src/markers.js";
import { transaction } from "../../src/transaction.js";
import { getActiveTransaction } from "../../src/transaction-context.js";
import type { Blueprint } from "../../src/schema/blueprint.js";

/**
 * The model/query layer run against **every** driver.
 *
 * The SQLite suites elsewhere in this directory cover behaviour; this
 * one exists to catch the things that are only wrong on a *different*
 * engine, SQL this framework spells for one dialect and no other.
 * Every case here was a real failure against live MySQL 8 / Postgres
 * 16 before the dialect work landed: MySQL rejecting ISO-`Z`
 * timestamps, Postgres returning no `insertId`, `"quoted"` correlation
 * predicates parsing as string literals on MySQL, `strftime()`/
 * `json_each()`/`RANDOM()`/`ON CONFLICT` not existing there, `FOR
 * UPDATE` never being emitted at all.
 *
 * SQLite is in the matrix deliberately rather than assumed-covered: the
 * point is that one set of assertions passes on all three, so a
 * dialect branch cannot fix one engine by breaking another.
 */
for (const engine of ENGINES) {
  const available = await engineAvailable(engine);
  const suite = available ? describe : describe.skip;

  suite(`cross-dialect (${engine.name})`, () => {
    let h: EngineHarness;

    interface AuthorAttributes {
      id: number;
      name: string;
      posts: HasMany<Post>;
      tags: BelongsToMany<Tag>;
      pivotTags: BelongsToMany<Tag, { weight: number }>;
      stampedTags: BelongsToMany<Tag>;
    }

    interface TagAttributes {
      id: number;
      label: string;
    }

    interface CommentAttributes {
      id: number;
      commentable_type: string;
      commentable_id: number;
      body: string;
    }

    interface PostAttributes {
      id: number;
      author_id: number | null;
      title: string;
      views: number;
      meta: string | null;
      published_at: string | null;
      created_at?: string | null;
      updated_at?: string | null;
      author: BelongsTo<Author>;
      comments: MorphMany<Comment>;
    }

    interface NoteAttributes {
      id: number;
      body: string;
      deleted_at: string | null;
    }

    /**
     * A model whose every interesting column is cast, the fixture for
     * the builder-binding cases (C11 below). Deliberately separate from
     * `Post`, whose `created_at`/`updated_at` are cast to `string` so the
     * timestamp cases can assert on the raw spelling.
     */
    interface WidgetAttributes {
      id: number;
      name: string;
      active: boolean;
      meta: Record<string, unknown> | null;
      published_at: DateTime | null;
    }

    class Widget extends Model<WidgetAttributes>()({
      table: "xd_widgets",
      primaryKey: "id",
      timestamps: false,
      casts: {
        active: Cast.boolean(),
        meta: Cast.json<Record<string, unknown>>(),
        published_at: Cast.datetime() as never,
      },
    }) {}

    class Author extends Model<AuthorAttributes>()({
      table: "xd_authors",
      primaryKey: "id",
      timestamps: false,
    }) {
      static override relationships = {
        posts: hasMany(() => Post, { foreignKey: "author_id" }),
        tags: belongsToMany(() => Tag, {
          pivotTable: "xd_author_tag",
          foreignPivotKey: "author_id",
          relatedPivotKey: "tag_id",
        }),
        pivotTags: belongsToMany(() => Tag, {
          pivotTable: "xd_author_tag",
          foreignPivotKey: "author_id",
          relatedPivotKey: "tag_id",
          withPivot: ["weight"],
        }),
        stampedTags: belongsToMany(() => Tag, {
          pivotTable: "xd_author_tag",
          foreignPivotKey: "author_id",
          relatedPivotKey: "tag_id",
          withTimestamps: true,
        }),
      };
    }

    class Tag extends Model<TagAttributes>()({
      table: "xd_tags",
      primaryKey: "id",
      timestamps: false,
    }) {}

    class Comment extends Model<CommentAttributes>()({
      table: "xd_comments",
      primaryKey: "id",
      timestamps: false,
    }) {}

    class Post extends Model<PostAttributes>()({
      table: "xd_posts",
      primaryKey: "id",
      casts: {
        published_at: Cast.datetime() as never,
        created_at: Cast.string(),
        updated_at: Cast.string(),
      },
    }) {
      static override relationships = {
        author: belongsTo(() => Author, { foreignKey: "author_id" }),
        comments: morphMany(() => Comment, {
          morphType: "commentable_type",
          morphId: "commentable_id",
          type: "xd_post",
        }),
      };
    }

    class Note extends Model<NoteAttributes>()({
      table: "xd_notes",
      primaryKey: "id",
      timestamps: false,
      softDeletes: true,
    }) {}

    beforeAll(async () => {
      h = await EngineHarness.start(engine, "cross_dialect");

      await h.create("xd_authors", (t: Blueprint) => {
        t.id();
        t.string("name");
      });
      await h.create("xd_posts", (t: Blueprint) => {
        t.id();
        t.unsignedBigInteger("author_id").nullable();
        t.string("title");
        t.integer("views").default(0);
        t.json("meta").nullable();
        t.timestamp("published_at").nullable();
        t.timestamps();
        t.foreign("author_id").references("id").on("xd_authors").nullOnDelete();
      });
      await h.create("xd_notes", (t: Blueprint) => {
        t.id();
        t.string("body");
        t.softDeletes();
      });
      await h.create("xd_tags", (t: Blueprint) => {
        t.id();
        t.string("label");
      });
      await h.create("xd_author_tag", (t: Blueprint) => {
        t.id();
        t.unsignedBigInteger("author_id");
        t.unsignedBigInteger("tag_id");
        // Pivot payload + timestamp columns, for the relationship-write
        // cases below (attach with attributes / withTimestamps).
        t.integer("weight").nullable();
        t.timestamps();
      });
      await h.create("xd_comments", (t: Blueprint) => {
        t.id();
        t.string("commentable_type");
        t.unsignedBigInteger("commentable_id");
        t.string("body");
      });
      await h.create("xd_kv", (t: Blueprint) => {
        t.id();
        t.string("k").unique();
        t.string("v");
      });
      await h.create("xd_widgets", (t: Blueprint) => {
        t.id();
        // Unique so `upsert()` has a conflict target to name.
        t.string("name").unique();
        t.boolean("active").default(false);
        t.json("meta").nullable();
        t.timestamp("published_at").nullable();
      });
    });

    afterEach(async () => {
      await h.truncate();
    });

    afterAll(async () => {
      await h?.stop();
    });

    // Mirrors `DatabaseManager.table()`: the connection is resolved at
    // execution time and prefers the active transaction. Reaching for
    // `driver.kysely` directly instead would deadlock on SQLite, whose
    // Kysely dialect serialises its single connection behind a mutex an
    // open transaction already holds.
    const table = (name: string) =>
      new QueryBuilder<any>(() => getActiveTransaction(h.driver.kysely) ?? h.driver.kysely, name);

    it("migrate records a migration (C1: MySQL rejects ISO-Z timestamps)", async () => {
      const runner = new MigrationRunner(h.driver.kysely, h.driver.dialect);
      const ran = await runner.up([
        { name: "0001_noop", migration: { up: async () => {}, down: async () => {} } },
      ]);
      expect(ran).toEqual(["0001_noop"]);

      const status = await runner.status([
        { name: "0001_noop", migration: { up: async () => {}, down: async () => {} } },
      ]);
      expect(status).toEqual([{ name: "0001_noop", ran: true, batch: 1 }]);

      await h.driver.kysely.schema.dropTable("migrations").ifExists().execute();
    });

    it("create() stamps created_at/updated_at the engine accepts, and they read back", async () => {
      const post = await Post.create({ title: "Hello", views: 0 });

      expect(post.created_at).toBeTruthy();
      expect(post.updated_at).toBe(post.created_at);

      const reloaded = await Post.find(post.id);
      // Round-trips to the same instant regardless of the engine's own
      // text spelling (MySQL stores "YYYY-MM-DD HH:MM:SS", the others ISO).
      expect(DateTime.fromISO(String(reloaded!.created_at), "UTC").toISOString()).toBe(
        DateTime.fromISO(String(post.created_at), "UTC").toISOString(),
      );
    });

    it("save() on an existing row stamps updated_at without corrupting created_at", async () => {
      const post = await Post.create({ title: "Hello", views: 0 });
      const createdAt = post.created_at;

      post.title = "Changed";
      await post.save();

      const reloaded = await Post.find(post.id);
      expect(reloaded!.title).toBe("Changed");
      expect(reloaded!.created_at).toBe(createdAt);
    });

    it("soft delete stamps deleted_at and the global scope hides the row", async () => {
      const note = await Note.create({ body: "gone", deleted_at: null });

      await Note.delete(note.id);

      expect(await Note.find(note.id)).toBeUndefined();
      const trashed = await Note.withTrashed().where("id", note.id).first();
      expect(trashed!.deleted_at).toBeTruthy();

      await Note.withTrashed().where("id", note.id).restore();
      expect(await Note.find(note.id)).toBeTruthy();
    });

    it("create() returns the DB-generated primary key (H2: PG has no insertId)", async () => {
      const post = await Post.create({ title: "Keyed", views: 0 });

      expect(post.id).toBeDefined();
      expect(post.id).not.toBeNull();
      // Same representation on every engine. An auto-increment key is
      // 64-bit everywhere (`bigserial` on PG, `BIGINT AUTO_INCREMENT` on
      // MySQL, a rowid on SQLite), so it reads back as a `bigint` rather
      // than PG's raw string "1" or a lossily-rounded number.
      expect(typeof post.id).toBe("bigint");

      // The key is real: a follow-up save() targets this row, not NULL.
      post.title = "Updated";
      await post.save();
      expect((await Post.find(post.id))!.title).toBe("Updated");
    });

    it("create() honours a caller-supplied primary key", async () => {
      const post = await Post.create({ id: 4242, title: "Explicit", views: 0 });
      expect(post.id).toBe(4242);
      expect(await Post.find(4242)).toMatchObject({ title: "Explicit" });
    });

    it('whereHas()/doesntHave() correlate correctly (H4: MySQL reads "x" as a literal)', async () => {
      const ada = await Author.create({ name: "Ada" });
      await Author.create({ name: "Grace" });
      await Post.create({ author_id: ada.id, title: "A", views: 1 });

      const withPosts = await Author.query()
        .whereHas("posts" as never)
        .get();
      expect(withPosts.toArray().map((a: any) => a.name)).toEqual(["Ada"]);

      const withoutPosts = await Author.query()
        .doesntHave("posts" as never)
        .get();
      expect(withoutPosts.toArray().map((a: any) => a.name)).toEqual(["Grace"]);
    });

    it("whereHas() with a constraint filters the correlated subquery", async () => {
      const ada = await Author.create({ name: "Ada" });
      await Post.create({ author_id: ada.id, title: "A", views: 1 });

      const many = await Author.query()
        .whereHas("posts" as never, (q: any) => q.where("views", ">", 100))
        .get();
      expect(many.length).toBe(0);

      const few = await Author.query()
        .whereHas("posts" as never, (q: any) => q.where("views", ">", 0))
        .get();
      expect(few.length).toBe(1);
    });

    it("belongsTo whereHas() correlates from the child side", async () => {
      const ada = await Author.create({ name: "Ada" });
      await Post.create({ author_id: ada.id, title: "A", views: 1 });
      await Post.create({ author_id: null, title: "Orphan", views: 1 });

      const withAuthor = await Post.query()
        .whereHas("author" as never)
        .get();
      expect(withAuthor.toArray().map((p: any) => p.title)).toEqual(["A"]);
    });

    it("withCount() projects a count column (H5: PG $1 placeholders broke the raw round-trip)", async () => {
      const ada = await Author.create({ name: "Ada" });
      await Author.create({ name: "Grace" });
      await Post.create({ author_id: ada.id, title: "A", views: 1 });
      await Post.create({ author_id: ada.id, title: "B", views: 5 });

      const rows = await Author.query()
        .withCount("posts" as never)
        .orderBy("id")
        .get();
      const counts = rows.toArray().map((a: any) => [a.name, Number(a.posts_count)]);
      // A zero count must still project the column, not omit the row.
      expect(counts).toEqual([
        ["Ada", 2],
        ["Grace", 0],
      ]);
    });

    it("withCount() with a bound constraint works (H5: the binding is what broke PG)", async () => {
      const ada = await Author.create({ name: "Ada" });
      await Post.create({ author_id: ada.id, title: "A", views: 1 });
      await Post.create({ author_id: ada.id, title: "B", views: 5 });

      const rows = await Author.query()
        .withCount({ posts: (q: any) => q.where("views", ">", 3) } as never)
        .get();
      expect(Number((rows.first() as any).posts_count)).toBe(1);
    });

    it("belongsToMany whereHas()/withCount() correlate through the pivot (H4)", async () => {
      const ada = await Author.create({ name: "Ada" });
      await Author.create({ name: "Grace" });
      const tag = await Tag.create({ label: "featured" });
      await table("xd_author_tag").insert({ author_id: ada.id, tag_id: tag.id });

      const tagged = await Author.query()
        .whereHas("tags" as never)
        .get();
      expect(tagged.toArray().map((a: any) => a.name)).toEqual(["Ada"]);

      const untagged = await Author.query()
        .doesntHave("tags" as never)
        .get();
      expect(untagged.toArray().map((a: any) => a.name)).toEqual(["Grace"]);

      const counted = await Author.query()
        .withCount("tags" as never)
        .orderBy("id")
        .get();
      expect(counted.toArray().map((a: any) => Number(a.tags_count))).toEqual([1, 0]);
    });

    it("morphMany whereHas()/withCount() correlate on the discriminant (H4)", async () => {
      const post = await Post.create({ title: "Commented", views: 0 });
      await Post.create({ title: "Silent", views: 0 });
      await table("xd_comments").insert({
        commentable_type: "xd_post",
        commentable_id: post.id,
        body: "hi",
      });

      const withComments = await Post.query()
        .whereHas("comments" as never)
        .get();
      expect(withComments.toArray().map((p: any) => p.title)).toEqual(["Commented"]);

      const counted = await Post.query()
        .withCount("comments" as never)
        .orderBy("id")
        .get();
      expect(counted.toArray().map((p: any) => Number(p.comments_count))).toEqual([1, 0]);
    });

    it("eager loading batches relations", async () => {
      const ada = await Author.create({ name: "Ada" });
      await Post.create({ author_id: ada.id, title: "A", views: 1 });
      await Post.create({ author_id: ada.id, title: "B", views: 2 });

      const authors = await Author.query()
        .with("posts" as never)
        .get();
      expect((authors.first() as any).posts.length).toBe(2);

      const posts = await Post.query()
        .with("author" as never)
        .orderBy("id")
        .get();
      expect((posts.first() as any).author.name).toBe("Ada");
    });

    it("whereDate()/whereMonth()/whereYear()/whereDay()/whereTime() (H6: strftime is SQLite-only)", async () => {
      await Post.create({ title: "Dated", views: 0, published_at: "2024-03-15T12:30:45.000Z" });

      expect((await table("xd_posts").whereDate("published_at", "2024-03-15").get()).length).toBe(
        1,
      );
      expect((await table("xd_posts").whereYear("published_at", "2024").get()).length).toBe(1);
      expect((await table("xd_posts").whereMonth("published_at", "03").get()).length).toBe(1);
      expect((await table("xd_posts").whereDay("published_at", "15").get()).length).toBe(1);
      expect(
        (await table("xd_posts").whereTime("published_at", ">", "00:00:00").get()).length,
      ).toBe(1);

      // ...and they genuinely filter, rather than matching everything.
      expect((await table("xd_posts").whereYear("published_at", "1999").get()).length).toBe(0);
      expect((await table("xd_posts").whereMonth("published_at", "04").get()).length).toBe(0);
    });

    it("whereJsonContains()/whereJsonContainsKey()/whereJsonLength() (H6)", async () => {
      await Post.create({ title: "Tagged", views: 0, meta: JSON.stringify({ tags: ["x", "y"] }) });
      await Post.create({ title: "Other", views: 0, meta: JSON.stringify({ tags: ["z"] }) });

      const hasX = await table("xd_posts").whereJsonContains("meta->tags", "x").get();
      expect(hasX.map((r: any) => r.title)).toEqual(["Tagged"]);

      const hasKey = await table("xd_posts").whereJsonContainsKey("meta->tags").get();
      expect(hasKey.length).toBe(2);

      const twoTags = await table("xd_posts").whereJsonLength("meta->tags", 2).get();
      expect(twoTags.map((r: any) => r.title)).toEqual(["Tagged"]);
    });

    it("inRandomOrder() runs (H6: MySQL needs RAND(), not RANDOM())", async () => {
      await Post.create({ title: "A", views: 1 });
      await Post.create({ title: "B", views: 2 });

      const rows = await table("xd_posts").inRandomOrder().get();
      expect(rows).toHaveLength(2);
    });

    it("upsert() inserts then updates on conflict (H6: MySQL has no ON CONFLICT)", async () => {
      await table("xd_kv").upsert([{ k: "a", v: "1" }], "k");
      expect((await table("xd_kv").get()).map((r: any) => r.v)).toEqual(["1"]);

      await table("xd_kv").upsert([{ k: "a", v: "2" }], "k");
      const rows = await table("xd_kv").get();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.v).toBe("2");

      await table("xd_kv").delete();
    });

    it("lockForUpdate()/sharedLock() emit a lock clause where the engine has one (H7)", async () => {
      const forUpdate = table("xd_posts").lockForUpdate().toSql().toLowerCase();
      const shared = table("xd_posts").sharedLock().toSql().toLowerCase();

      if (engine.name === "sqlite") {
        // Documented no-op: SQLite has no row locks and rejects the clause.
        expect(forUpdate).not.toContain("for update");
        expect(shared).not.toContain("for share");
      } else {
        expect(forUpdate).toContain("for update");
        expect(shared).toContain(engine.name === "mysql" ? "for share" : "for share");
      }
    });

    it("a locked read inside a transaction returns rows", async () => {
      await Post.create({ title: "Locked", views: 1 });

      const rows = await transaction(h.driver.kysely, async () =>
        table("xd_posts").where("title", "Locked").lockForUpdate().get(),
      );
      expect(rows).toHaveLength(1);
    });

    it("a datetime cast round-trips to the same instant (H8: local-time Date shift)", async () => {
      const written = DateTime.fromISO("2026-09-02T07:31:37.000Z", "UTC");
      const post = await Post.create({ title: "Cast", views: 0, published_at: written as never });

      const reloaded = await Post.find(post.id);
      const read = reloaded!.published_at as unknown as DateTime;

      expect(read).toBeInstanceOf(DateTime);
      expect(read.toISOString()).toBe("2026-09-02T07:31:37.000Z");
    });

    it("timestamp columns come back as strings, not Dates (H8)", async () => {
      await Post.create({ title: "Typed", views: 0 });
      const row: any = await table("xd_posts").first();
      expect(typeof row.created_at).toBe("string");
    });

    it("a timestamp written as UTC reads back unshifted (H8: driver used process TZ)", async () => {
      // The bug this pins down only ever appeared under a non-UTC
      // process timezone: both drivers parsed a zone-less column into a
      // JS `Date` in LOCAL time, so a value stored as 07:31:37 UTC came
      // back 8 hours out under Asia/Shanghai, and saving it wrote the
      // shifted value back, drifting the row on every update.
      //
      // The suite is normally run under the machine's own zone, so the
      // process TZ is forced here rather than relying on the runner's.
      const original = process.env.TZ;
      process.env.TZ = "Asia/Shanghai";
      try {
        await Post.create({
          title: "Shifted",
          views: 0,
          published_at: "2026-09-02T07:31:37.000Z" as never,
        });

        const row: any = await table("xd_posts").where("title", "Shifted").first();
        expect(DateTime.fromISO(String(row.published_at), "UTC").toISOString()).toBe(
          "2026-09-02T07:31:37.000Z",
        );
      } finally {
        if (original === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = original;
        }
      }
    });

    it("a DateTime round-trips through the cast under a non-UTC process TZ (H8)", async () => {
      // The test above writes a pre-formatted string, so it never
      // exercises the cast's own `toDatabaseType`. H8's actual repro was
      // `TZ=Asia/Shanghai` with a real `DateTime` going through the
      // cast in both directions, write, read back, and compare the
      // instant. A driver that formats in local time drifts by 8 hours
      // here while the UTC-only assertion above stays green.
      const original = process.env.TZ;
      process.env.TZ = "Asia/Shanghai";
      try {
        const instant = DateTime.fromISO("2026-09-02T07:31:37.000Z", "UTC");
        // `Widget`, not `Post`: its `published_at` is declared
        // `DateTime | null` with a `Cast.datetime()`, so the value goes
        // through the cast in both directions. `Post` declares the
        // column as a raw `string`, which is what let the existing
        // UTC-only test above miss this.
        const created = await Widget.create({
          name: "TzRoundTrip",
          active: true,
          meta: null,
          published_at: instant,
        });

        // Through the model (cast out).
        expect(created.published_at!.toISOString()).toBe("2026-09-02T07:31:37.000Z");

        const reread = await Widget.query().where("name", "TzRoundTrip").firstOrFail();
        expect(reread.published_at!.toISOString()).toBe("2026-09-02T07:31:37.000Z");

        // And the value actually stored is the UTC one, not a shifted
        // local rendering of it.
        const raw: any = await table("xd_widgets").where("name", "TzRoundTrip").first();
        expect(DateTime.fromISO(String(raw.published_at), "UTC").toISOString()).toBe(
          "2026-09-02T07:31:37.000Z",
        );

        // Re-saving must not drift it, the bug re-shifted on every update.
        reread.active = false;
        await reread.save();
        const afterSave = await Widget.query().where("name", "TzRoundTrip").firstOrFail();
        expect(afterSave.published_at!.toISOString()).toBe("2026-09-02T07:31:37.000Z");
      } finally {
        if (original === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = original;
        }
      }
    });

    it("transactions commit and roll back", async () => {
      await transaction(h.driver.kysely, async () => {
        await Post.create({ title: "Committed", views: 0 });
      });
      expect((await Post.query().where("title", "Committed").get()).length).toBe(1);

      await expect(
        transaction(h.driver.kysely, async () => {
          await Post.create({ title: "RolledBack", views: 0 });
          throw new Error("nope");
        }),
      ).rejects.toThrow("nope");
      expect((await Post.query().where("title", "RolledBack").get()).length).toBe(0);
    });

    it("whereIn() with an empty list matches nothing", async () => {
      await Post.create({ title: "A", views: 1 });
      expect((await table("xd_posts").whereIn("id", []).get()).length).toBe(0);
    });

    it("whereNotIn() with an empty list matches everything", async () => {
      // The mirror of the case above, and the easier one to get wrong:
      // "not in the empty set" is true for every row, so the clause must
      // compile to a tautology rather than to `NOT IN ()`, a syntax
      // error on MySQL and Postgres alike.
      await Post.create({ title: "A", views: 1 });
      await Post.create({ title: "B", views: 2 });
      expect((await table("xd_posts").whereNotIn("id", []).get()).length).toBe(2);
    });

    // Nested transactions / savepoints (C2)
    //
    // Savepoint semantics are the most engine-divergent thing in the
    // plans, and were verified on SQLite alone. MySQL is the one that
    // matters most: DDL there causes an implicit commit, which silently
    // destroys an enclosing transaction, and its savepoint behaviour on
    // rollback is the least like the others.

    it("an inner rollback leaves the outer transaction intact (C2)", async () => {
      await transaction(h.driver.kysely, async () => {
        await Post.create({ title: "Outer", views: 0 });

        // The inner failure must roll back to its savepoint only.
        await expect(
          transaction(h.driver.kysely, async () => {
            await Post.create({ title: "Inner", views: 0 });
            throw new Error("inner fails");
          }),
        ).rejects.toThrow("inner fails");

        // Still inside the outer transaction, which is still usable.
        await Post.create({ title: "AfterInner", views: 0 });
      });

      const titles = (await Post.query().orderBy("title").get()).map((p) => p.title).all();
      expect(titles).toEqual(["AfterInner", "Outer"]);
    });

    it("an outer rollback discards a committed inner savepoint (C2)", async () => {
      // A released savepoint is not durable on its own. The outer
      // rollback must still take the inner work with it.
      await expect(
        transaction(h.driver.kysely, async () => {
          await transaction(h.driver.kysely, async () => {
            await Post.create({ title: "InnerCommitted", views: 0 });
          });
          throw new Error("outer fails");
        }),
      ).rejects.toThrow("outer fails");

      expect((await Post.query().get()).length).toBe(0);
    });

    it("sequential nested transactions each roll back independently (C2)", async () => {
      // Two nested blocks at the same depth, one committing and one
      // failing, inside a single outer transaction. The engine must
      // keep the first's work and discard only the second's.
      await transaction(h.driver.kysely, async () => {
        await transaction(h.driver.kysely, async () => {
          await Post.create({ title: "SiblingA", views: 0 });
        });

        await expect(
          transaction(h.driver.kysely, async () => {
            await Post.create({ title: "SiblingB", views: 0 });
            throw new Error("second sibling fails");
          }),
        ).rejects.toThrow("second sibling fails");
      });

      const titles = (await Post.query().get()).map((p) => p.title).all();
      expect(titles).toEqual(["SiblingA"]);
    });

    it("savepoints nest three deep and unwind correctly (C2)", async () => {
      await transaction(h.driver.kysely, async () => {
        await Post.create({ title: "L1", views: 0 });
        await transaction(h.driver.kysely, async () => {
          await Post.create({ title: "L2", views: 0 });
          await expect(
            transaction(h.driver.kysely, async () => {
              await Post.create({ title: "L3", views: 0 });
              throw new Error("deepest fails");
            }),
          ).rejects.toThrow("deepest fails");
        });
      });

      const titles = (await Post.query().orderBy("title").get()).map((p) => p.title).all();
      expect(titles).toEqual(["L1", "L2"]);
    });

    it("aggregates and pagination counts agree", async () => {
      await Post.create({ title: "A", views: 1 });
      await Post.create({ title: "B", views: 5 });
      await Post.create({ title: "C", views: 9 });

      expect(await table("xd_posts").count()).toBe(3);
      expect(await table("xd_posts").sum("views")).toBe(15);
      expect(await table("xd_posts").max("views")).toBe(9);
      expect(await table("xd_posts").min("views")).toBe(1);
      expect(await table("xd_posts").avg("views")).toBe(5);

      const page = await Post.paginate(1, 2);
      expect(page.total).toBe(3);
      expect(page.data.length).toBe(2);
      expect(page.totalPages).toBe(2);
    });

    it("increment()/decrement() update in place", async () => {
      const post = await Post.create({ title: "Counter", views: 5 });

      await table("xd_posts").where("id", post.id).increment("views", 3);
      expect(Number((await Post.find(post.id))!.views)).toBe(8);

      await table("xd_posts").where("id", post.id).decrement("views", 2);
      expect(Number((await Post.find(post.id))!.views)).toBe(6);
    });

    it("orderBy/limit/offset page deterministically", async () => {
      for (const title of ["A", "B", "C"]) {
        await Post.create({ title, views: 0 });
      }

      const second = await table("xd_posts").orderBy("title").limit(1).offset(1).get();
      expect(second.map((r: any) => r.title)).toEqual(["B"]);
    });

    // The engine-sensitive parts: the multi-row pivot INSERT, pivot
    // timestamps (MySQL rejects the ISO-Z spelling), and the sync()
    // diff comparing caller-supplied ids against driver-returned ones
    // whose JS type differs per engine (MySQL hands back BIGINT as a
    // string, SQLite as a number).

    it("attach()/detach() write and remove pivot rows on every engine", async () => {
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });

      await (ada as any).relations.tags().attach([a.id, b.id]);
      expect(await (ada as any).relations.tags().count()).toBe(2);

      expect(await (ada as any).relations.tags().detach([a.id])).toBe(1);
      const remaining = await (ada as any).relations.tags().get();
      expect(remaining.pluck("label").toArray()).toEqual(["b"]);
    });

    it("attach() writes pivot attributes that read back through withPivot", async () => {
      const ada = await Author.create({ name: "Ada" });
      const tag = await Tag.create({ label: "a" });

      await (ada as any).relations.pivotTags().attach({ [String(tag.id)]: { weight: 7 } });

      const found = await (ada as any).relations.pivotTags().first();
      expect(Number(found.pivot.weight)).toBe(7);
    });

    it("attach() stamps pivot timestamps in a form the engine accepts (C1)", async () => {
      const ada = await Author.create({ name: "Ada" });
      const tag = await Tag.create({ label: "a" });

      await (ada as any).relations.stampedTags().attach(tag.id);

      const [row] = await table("xd_author_tag").get();
      expect(row.created_at).toBeTruthy();
      // Round-trips to a real instant whatever the engine's spelling.
      expect(DateTime.fromISO(String(row.created_at), "UTC").toISOString()).toBeTruthy();
    });

    it("toggle() flips membership both ways (X8)", async () => {
      // Both halves in one call, an attach and a detach in the same
      // statement pair, against the same pivot. The diff is computed
      // from driver-returned keys, so this is the same per-engine key
      // type hazard `sync()` has.
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });

      await (ada as any).relations.tags().attach([a.id]);

      const result = await (ada as any).relations.tags().toggle([a.id, b.id]);
      expect(result.attached.map(String)).toEqual([String(b.id)]);
      expect(result.detached.map(String)).toEqual([String(a.id)]);

      const labels = await (ada as any).relations.tags().get();
      expect(labels.pluck("label").toArray()).toEqual(["b"]);
    });

    it("toggle()/sync() diff string ids against numeric DB keys (X8)", async () => {
      // Ids arriving from an HTTP request or JSON body are strings,
      // while every engine here hands auto-increment keys back as
      // numbers. The pivot diff compares the two, so a strict `===`
      // would see no overlap and attach a duplicate instead of
      // detaching, on every engine, silently.
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });

      await (ada as any).relations.tags().attach([a.id]);

      const toggled = await (ada as any).relations.tags().toggle([String(a.id), String(b.id)]);
      expect(toggled.detached.map(String)).toEqual([String(a.id)]);
      expect(toggled.attached.map(String)).toEqual([String(b.id)]);
      expect((await (ada as any).relations.tags().get()).pluck("label").toArray()).toEqual(["b"]);

      // Same for sync(): syncing to the id already present must be a
      // no-op, not a detach-and-reattach.
      const synced = await (ada as any).relations.tags().sync([String(b.id)]);
      expect(synced.attached).toEqual([]);
      expect(synced.detached).toEqual([]);
      expect(await (ada as any).relations.tags().count()).toBe(1);
    });

    it("updateExistingPivot() writes pivot columns in place (X8)", async () => {
      const ada = await Author.create({ name: "Ada" });
      const tag = await Tag.create({ label: "a" });

      await (ada as any).relations.pivotTags().attach({ [String(tag.id)]: { weight: 1 } });
      const updated = await (ada as any).relations
        .pivotTags()
        .updateExistingPivot(tag.id, { weight: 9 });
      expect(updated).toBe(1);

      const found = await (ada as any).relations.pivotTags().first();
      expect(Number(found.pivot.weight)).toBe(9);
    });

    it("syncWithPivotValues() applies the same pivot values to every row (X8)", async () => {
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });

      await (ada as any).relations.pivotTags().syncWithPivotValues([a.id, b.id], { weight: 4 });

      const rows = await table("xd_author_tag").orderBy("tag_id").get();
      expect(rows.length).toBe(2);
      expect(rows.every((r: any) => Number(r.weight) === 4)).toBe(true);
    });

    it("detach() with no argument clears every pivot row (X8)", async () => {
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });
      await (ada as any).relations.tags().attach([a.id, b.id]);

      expect(await (ada as any).relations.tags().detach()).toBe(2);
      expect(await (ada as any).relations.tags().count()).toBe(0);
    });

    it("sync() diffs correctly despite per-engine key types", async () => {
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });
      const c = await Tag.create({ label: "c" });

      await (ada as any).relations.tags().attach([a.id, b.id]);
      const result = await (ada as any).relations.tags().sync([b.id, c.id]);

      expect(result.attached.map(String)).toEqual([String(c.id)]);
      expect(result.detached.map(String)).toEqual([String(a.id)]);

      const labels = await (ada as any).relations.tags().get();
      expect(labels.pluck("label").sort().toArray()).toEqual(["b", "c"]);
    });

    it("sync() inside a rolled-back transaction leaves the pivot untouched", async () => {
      const ada = await Author.create({ name: "Ada" });
      const a = await Tag.create({ label: "a" });
      const b = await Tag.create({ label: "b" });
      await (ada as any).relations.tags().attach([a.id]);

      await expect(
        transaction(h.driver.kysely, async () => {
          await (ada as any).relations.tags().sync([b.id]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const kept = await (ada as any).relations.tags().get();
      expect(kept.pluck("label").toArray()).toEqual(["a"]);
    });

    it("associate()/save() and create()-through-a-relation persist on every engine", async () => {
      const ada = await Author.create({ name: "Ada" });

      // hasMany create(): the FK is set by the relation.
      const post = await (ada as any).relations.posts().create({ title: "Made", views: 0 });
      expect(Number(post.author_id)).toBe(Number(ada.id));

      // belongsTo associate(): sets the FK on the parent, caller saves.
      const grace = await Author.create({ name: "Grace" });
      (post as any).relations.author().associate(grace);
      await post.save();

      const reloaded = await Post.find(post.id);
      expect(Number(reloaded!.author_id)).toBe(Number(grace.id));
    });

    // C11. The query builder applies the model's casts to its bindings
    //
    // `EloquentBuilder` used to pass values straight through to
    // `QueryBuilder`, which is model-unaware. A `DateTime` or a JSON
    // object therefore bound as itself: SQLite and MySQL reject both
    // outright, while Postgres's `pg` serialises them silently, so the
    // same code threw on two engines and "worked" on the third.
    //
    // Booleans are why this hid for so long: the SQLite driver coerces
    // them at its own boundary, so a SQLite-only suite saw nothing.
    // These run on all three deliberately.

    it("where() binds a cast column's DB value (C11)", async () => {
      await Widget.create({ name: "on", active: true, meta: null, published_at: null });
      await Widget.create({ name: "off", active: false, meta: null, published_at: null });

      const on = await Widget.query().where("active", true).get();
      expect(on.pluck("name").toArray()).toEqual(["on"]);

      const off = await Widget.query().where("active", false).get();
      expect(off.pluck("name").toArray()).toEqual(["off"]);
    });

    it("where() binds a DateTime comparand as the engine's spelling (C11)", async () => {
      const when = DateTime.fromISO("2026-01-02T03:04:05.000Z", "UTC");
      await Widget.create({ name: "dated", active: false, meta: null, published_at: when });

      const found = await Widget.query()
        .where("published_at", when as never)
        .get();
      expect(found.pluck("name").toArray()).toEqual(["dated"]);
    });

    it("whereIn() casts every value in the list (C11)", async () => {
      await Widget.create({ name: "on", active: true, meta: null, published_at: null });
      await Widget.create({ name: "off", active: false, meta: null, published_at: null });

      const found = await Widget.query().whereIn("active", [true]).get();
      expect(found.pluck("name").toArray()).toEqual(["on"]);
    });

    it("whereBetween() casts both bounds (C11)", async () => {
      const when = DateTime.fromISO("2026-06-15T00:00:00.000Z", "UTC");
      await Widget.create({ name: "mid", active: false, meta: null, published_at: when });

      const found = await Widget.query()
        .whereBetween(
          "published_at",
          DateTime.fromISO("2026-01-01T00:00:00.000Z", "UTC") as never,
          DateTime.fromISO("2026-12-31T00:00:00.000Z", "UTC") as never,
        )
        .get();
      expect(found.pluck("name").toArray()).toEqual(["mid"]);
    });

    it("update() writes cast DB values for boolean/json/datetime (C11)", async () => {
      await Widget.create({ name: "w", active: false, meta: null, published_at: null });

      const when = DateTime.fromISO("2026-03-04T05:06:07.000Z", "UTC");
      await Widget.query()
        .where("name", "w")
        .update({ active: true, meta: { a: 1 }, published_at: when } as never);

      const row = await Widget.query().where("name", "w").firstOrFail();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ a: 1 });
      expect(row.published_at?.toISOString()).toBe(when.toISOString());
    });

    it("insert() writes cast DB values (C11)", async () => {
      const when = DateTime.fromISO("2026-07-08T09:10:11.000Z", "UTC");
      await Widget.query().insert({
        name: "inserted",
        active: true,
        meta: { b: 2 },
        published_at: when,
      } as never);

      const row = await Widget.query().where("name", "inserted").firstOrFail();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ b: 2 });
      expect(row.published_at?.toISOString()).toBe(when.toISOString());
    });

    it("upsert() casts every row it writes (C11)", async () => {
      await Widget.query().upsert([{ name: "u", active: true, meta: { c: 3 } } as never], "name", [
        "active",
        "meta",
      ]);

      const row = await Widget.query().where("name", "u").firstOrFail();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ c: 3 });
    });

    it("static Model.update() still writes correctly (no double-cast) (C11)", async () => {
      // The static path casts before handing off to the builder, which
      // now casts too. Casts accept their own DB shape by contract
      // (`toDatabaseType(ModelType | DbType)`), so this must be a no-op
      // the second time rather than, say, JSON-encoding a JSON string.
      const created = await Widget.create({
        name: "s",
        active: false,
        meta: null,
        published_at: null,
      });
      await Widget.update(created.id, { active: true, meta: { d: 4 } } as never);

      const row = await Widget.query().where("name", "s").firstOrFail();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ d: 4 });
    });

    it("normalises a ZONED DateTime to UTC on every engine (write + match)", async () => {
      // The value is 09:10:11 UTC, expressed in +08:00 as 17:10:11.
      // Unconverted, `toISOString()` yields "...17:10:11.000+08:00":
      // MySQL rejects it outright, and SQLite/`timestamp` would store
      // 17:10 as though it were UTC. Both the write and the lookup have
      // to agree on the instant.
      const utc = DateTime.fromISO("2026-07-08T09:10:11.000Z", "UTC");
      const perth = utc.setTimezone("Australia/Perth");
      expect(perth.toISOString()).toBe("2026-07-08T17:10:11.000+08:00");

      await Widget.query().insert({ name: "zoned", published_at: perth } as never);

      const row = await Widget.query().where("name", "zoned").firstOrFail();
      expect(row.published_at?.toISOString()).toBe(utc.toISOString());

      // Findable by the zoned value that wrote it, and by its UTC twin.
      const byZoned = await Widget.query()
        .where("published_at", perth as never)
        .first();
      expect(byZoned?.name).toBe("zoned");

      const byUtc = await Widget.query()
        .where("published_at", utc as never)
        .first();
      expect(byUtc?.name).toBe("zoned");
    });

    it("binds a DateTime on an UNCAST column, which casts cannot reach", async () => {
      // `xd_posts` declares no datetime cast, so this exercises the
      // normalisation layer alone, the `PersonalAccessToken` shape.
      // The bound comparand is relative to `created_at`'s own stamping,
      // so it has to be anchored to now rather than a fixed date.
      await Post.create({ title: "dated", views: 1 });

      const soon = DateTime.now("UTC").addDays(1);
      const included = await table("xd_posts")
        .where("created_at", "<=", soon as never)
        .get();
      expect(included.some((r: any) => r.title === "dated")).toBe(true);

      // And the comparison genuinely discriminates rather than matching
      // everything: a cutoff in the past excludes the row.
      const past = DateTime.now("UTC").subDays(1);
      const excluded = await table("xd_posts")
        .where("created_at", "<=", past as never)
        .get();
      expect(excluded.some((r: any) => r.title === "dated")).toBe(false);
    });

    it("grouped where clauses nest correctly", async () => {
      await Post.create({ title: "A", views: 1 });
      await Post.create({ title: "B", views: 9 });

      const rows = await table("xd_posts")
        .where((q: any) => q.where("title", "A").orWhere("views", ">", 5))
        .orderBy("title")
        .get();
      expect(rows.map((r: any) => r.title)).toEqual(["A", "B"]);
    });
  });
}

/** Reports which engines the matrix actually ran, so a silent skip is visible. */
describe("cross-dialect matrix", () => {
  it("covers sqlite plus whichever servers are reachable", async () => {
    const reachable: string[] = [];

    for (const engine of ENGINES as TestEngine[]) {
      if (await engineAvailable(engine)) {
        reachable.push(engine.name);
      }
    }

    expect(reachable).toContain("sqlite");
  });
});
