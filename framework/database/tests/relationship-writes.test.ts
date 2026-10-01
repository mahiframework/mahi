import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Relation } from "../src/morph-map.js";
import { transaction } from "../src/transaction.js";
import { UniqueConstraintViolationException } from "../src/exceptions.js";
import type { SyncResult } from "../src/relationship-writes.js";
import {
  belongsTo,
  belongsToMany,
  hasMany,
  morphedByMany,
  morphMany,
  morphTo,
  morphToMany,
} from "../src/relations.js";
import type {
  BelongsTo,
  BelongsToMany,
  HasMany,
  MorphedByMany,
  MorphMany,
  MorphTo,
  MorphToMany,
} from "../src/markers.js";

/**
 * Relationship writes, `attach`/`detach`/`sync`/`toggle` on pivots,
 * `associate`/`dissociate` on the inverse, and `save`/`create` through a
 * has-many. See `src/relationship-writes.ts`.
 */

interface UserAttributes {
  id: string;
  name: string;
  posts: HasMany<Post>;
}

interface PostAttributes {
  id: string;
  title: string;
  user_id: string | null;
  deleted_at: string | null;

  author: BelongsTo<User>;
  tags: BelongsToMany<Tag>;
  tagsWithPivot: BelongsToMany<Tag, { weight: number; note: string | null }>;
  stampedTags: BelongsToMany<Tag>;
  comments: MorphMany<Comment>;
}

interface TagAttributes {
  id: string;
  name: string;
  posts: BelongsToMany<Post>;
  videos: MorphedByMany<Video>;
}

interface VideoAttributes {
  id: string;
  url: string;
  tags: MorphToMany<Tag>;
}

interface CommentAttributes {
  id: string;
  body: string;
  commentable_type: string | null;
  commentable_id: string | null;
  commentable: MorphTo<Post | Video>;
}

class Tag extends Model<TagAttributes>()({
  table: "tags",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {
  static override relationships = {
    /** The inverse of `Post.tags`, same pivot, read the other way. */
    posts: belongsToMany(() => Post, {
      pivotTable: "post_tag",
      foreignPivotKey: "tag_id",
      relatedPivotKey: "post_id",
    }),
    /** morphedByMany over the shared `taggables` pivot. */
    videos: morphedByMany(() => Video, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      foreignPivotKey: "tag_id",
      type: "video",
    }),
  };
}

class Video extends Model<VideoAttributes>()({
  table: "videos",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {
  static override relationships = {
    tags: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
      type: "video",
    }),
  };
}

class Comment extends Model<CommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {
  static override relationships = {
    commentable: morphTo<Post | Video>({
      morphType: "commentable_type",
      morphId: "commentable_id",
      types: { post: () => Post, video: () => Video },
    }),
  };
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
  softDeletes: true,
  morphName: "post",
}) {
  static override relationships = {
    author: belongsTo(() => User, { foreignKey: "user_id" }),
    tags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
    }),
    /** Same pivot, but projecting/writing its extra columns. */
    tagsWithPivot: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
      withPivot: ["weight", "note"],
    }),
    /** Same pivot with `withTimestamps`, so attach stamps created_at/updated_at. */
    stampedTags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
      withTimestamps: true,
    }),
    comments: morphMany(() => Comment, {
      morphType: "commentable_type",
      morphId: "commentable_id",
      type: "post",
    }),
  };
}

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {
  static override relationships = {
    posts: hasMany(() => Post, { foreignKey: "user_id" }),
  };
}

/** Reads the raw pivot rows for a post, bypassing every model/scope. */
async function pivotRows(app: Application, postId: string): Promise<Record<string, any>[]> {
  const { kysely } = app.make<DatabaseManager>(DATABASE_TOKEN).driver();

  return kysely
    .selectFrom("post_tag" as never)
    .selectAll()
    .where("post_id" as never, "=", postId as never)
    .orderBy("tag_id" as never)
    .execute() as unknown as Promise<Record<string, any>[]>;
}

/** The tag ids currently linked to a post, sorted, the assertion most tests make. */
async function attachedTagIds(app: Application, postId: string): Promise<string[]> {
  const rows = await pivotRows(app, postId);

  return rows.map((row) => String(row.tag_id)).sort();
}

describe("Relationship writes", () => {
  let app: Application;
  /** The kind of every statement executed since the last `statementsFor()`. */
  let statementLog: string[] = [];

  /**
   * Runs `fn` and returns the kind of each statement it executed
   * (`"SelectQueryNode"`, `"UpdateQueryNode"`, ...), the `countQueries()`
   * pattern from `morph-to-many.test.ts` widened past SELECTs because
   * what matters here is writes.
   *
   * Recorded with a `KyselyPlugin` rather than by wrapping the driver's
   * executor: Kysely gives a transaction its own executor, so an
   * executor patch would see nothing a `sync()` does. Plugins are copied
   * onto the transaction's executor and so see everything.
   *
   * Kinds rather than a bare count because "4 statements" is only the
   * right answer if they are the four intended ones, and savepoint
   * commands have no node kind to report, which usefully leaves the
   * transaction's own overhead out of the assertion.
   */
  const statementsFor = async (fn: () => Promise<unknown>): Promise<string[]> => {
    statementLog = [];
    await fn();

    // A copy, so a result held across a later call (comparing two sizes)
    // isn't still pointing at the live log.
    return [...statementLog];
  };

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => {
      const driver = new SqliteDriver({ filename: ":memory:" });
      (driver as { kysely: typeof driver.kysely }).kysely = driver.kysely.withPlugin({
        transformQuery(args) {
          statementLog.push(args.node.kind);

          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });

      return driver;
    });
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    Relation.morphMap({ post: () => Post, video: () => Video });

    const { kysely } = manager.driver();

    await kysely.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("user_id", "text")
      .addColumn("deleted_at", "text")
      .execute();

    await kysely.schema
      .createTable("tags")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("videos")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("url", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("comments")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("commentable_type", "text")
      .addColumn("commentable_id", "text")
      .execute();

    // A composite primary key, so a duplicate attach() is a real unique
    // violation rather than a silently doubled link.
    await kysely.schema
      .createTable("post_tag")
      .addColumn("post_id", "text", (col) => col.notNull())
      .addColumn("tag_id", "text", (col) => col.notNull())
      .addColumn("weight", "integer")
      // A second payload column, so a sync() whose ids supply different
      // columns has something to leave alone.
      .addColumn("note", "text")
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text")
      .addPrimaryKeyConstraint("post_tag_pk", ["post_id", "tag_id"])
      .execute();

    await kysely.schema
      .createTable("taggables")
      .addColumn("tag_id", "text", (col) => col.notNull())
      .addColumn("taggable_type", "text", (col) => col.notNull())
      .addColumn("taggable_id", "text", (col) => col.notNull())
      .execute();

    await User.create({ id: "u1", name: "Ada" });
    await User.create({ id: "u2", name: "Grace" });
    await Post.create({ id: "p1", title: "First", user_id: "u1" });

    for (const id of ["t1", "t2", "t3", "t4"]) {
      await Tag.create({ id, name: id.toUpperCase() });
    }

    await Video.create({ id: "v1", url: "https://example.test/v1" });
  });

  afterEach(() => {
    Relation.resetMorphMap();
    clearCurrentApp();
  });

  describe("attach()", () => {
    it("attaches a single key", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach("t1");

      expect(await attachedTagIds(app, "p1")).toEqual(["t1"]);
    });

    it("attaches a list of keys in one insert", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t2", "t3"]);

      expect(await attachedTagIds(app, "p1")).toEqual(["t1", "t2", "t3"]);
    });

    it("accepts model instances as well as keys", async () => {
      const post = (await Post.find("p1"))!;
      const tag = (await Tag.find("t2"))!;
      await post.relations.tags().attach(tag);

      expect(await attachedTagIds(app, "p1")).toEqual(["t2"]);
    });

    it("writes per-id pivot attributes from the map form", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach({ t1: { weight: 9 }, t2: { weight: 3 } });

      const rows = await pivotRows(app, "p1");
      expect(rows.map((row) => [row.tag_id, row.weight])).toEqual([
        ["t1", 9],
        ["t2", 3],
      ]);
    });

    it("applies a shared pivot payload to every attached id", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach(["t1", "t2"], { weight: 5 });

      const rows = await pivotRows(app, "p1");
      expect(rows.map((row) => row.weight)).toEqual([5, 5]);
    });

    it("lets a per-id attribute override the shared payload", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach({ t1: { weight: 1 }, t2: {} }, { weight: 5 });

      const rows = await pivotRows(app, "p1");
      expect(rows.map((row) => [row.tag_id, row.weight])).toEqual([
        ["t1", 1],
        ["t2", 5],
      ]);
    });

    it("stamps created_at/updated_at when the relation declares withTimestamps", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.stampedTags().attach("t1");

      const [row] = await pivotRows(app, "p1");
      // Exactly one pivot row is expected here; the `!` is the assertion.
      const pivot = row!;
      expect(pivot.created_at).toEqual(expect.any(String));
      expect(pivot.updated_at).toEqual(pivot.created_at);
    });

    it("does not stamp timestamps when the relation does not declare them", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach("t1");

      const [row] = await pivotRows(app, "p1");
      // Exactly one pivot row is expected here; the `!` is the assertion.
      const pivot = row!;
      expect(pivot.created_at).toBeNull();
    });

    it("writes nothing for an empty list", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach([]);

      expect(await pivotRows(app, "p1")).toHaveLength(0);
    });

    it("surfaces a duplicate attach as UniqueConstraintViolationException", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach("t1");

      await expect(post.relations.tags().attach("t1")).rejects.toThrow(
        UniqueConstraintViolationException,
      );
    });
  });

  describe("detach()", () => {
    beforeEach(async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t2", "t3"]);
    });

    it("detaches every related row when called with no argument", async () => {
      const post = (await Post.find("p1"))!;
      expect(await post.relations.tags().detach()).toBe(3);
      expect(await pivotRows(app, "p1")).toHaveLength(0);
    });

    it("detaches only the named ids and returns the count", async () => {
      const post = (await Post.find("p1"))!;
      expect(await post.relations.tags().detach(["t1", "t3"])).toBe(2);
      expect(await attachedTagIds(app, "p1")).toEqual(["t2"]);
    });

    it("treats detach([]) as a no-op, NOT as detach-all", async () => {
      const post = (await Post.find("p1"))!;
      expect(await post.relations.tags().detach([])).toBe(0);
      expect(await attachedTagIds(app, "p1")).toEqual(["t1", "t2", "t3"]);
    });

    it("accepts a model instance", async () => {
      const post = (await Post.find("p1"))!;
      const tag = (await Tag.find("t2"))!;
      expect(await post.relations.tags().detach(tag)).toBe(1);
      expect(await attachedTagIds(app, "p1")).toEqual(["t1", "t3"]);
    });

    it("leaves another parent's pivot rows alone", async () => {
      await Post.create({ id: "p2", title: "Second", user_id: "u1" });
      const other = (await Post.find("p2"))!;
      await other.relations.tags().attach(["t1", "t4"]);

      const post = (await Post.find("p1"))!;
      await post.relations.tags().detach();

      expect(await attachedTagIds(app, "p2")).toEqual(["t1", "t4"]);
    });
  });

  describe("sync()", () => {
    it("reports Laravel's three buckets and applies the diff", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t2", "t3", "t4"]);

      const result = await post.relations.tags().sync(["t1", "t2", "t3"]);

      expect(result).toEqual({ attached: ["t1"], detached: ["t4"], updated: [] });
      expect(await attachedTagIds(app, "p1")).toEqual(["t1", "t2", "t3"]);
    });

    it("reports ids whose supplied pivot attributes were written as updated", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach({ t2: { weight: 1 } });

      const result = await post.relations.tagsWithPivot().sync({ t2: { weight: 9 } });

      expect(result).toEqual({ attached: [], detached: [], updated: ["t2"] });
      const [row] = await pivotRows(app, "p1");
      // Exactly one pivot row is expected here; the `!` is the assertion.
      const pivot = row!;
      expect(pivot.weight).toBe(9);
    });

    it("does not report an update when no attributes were supplied", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1"]);

      expect(await post.relations.tags().sync(["t1"])).toEqual({
        attached: [],
        detached: [],
        updated: [],
      });
    });

    it("detaches everything when synced to an empty list", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t2"]);

      const result = await post.relations.tags().sync([]);

      expect(result.detached.sort()).toEqual(["t1", "t2"]);
      expect(await pivotRows(app, "p1")).toHaveLength(0);
    });

    it("stamps timestamps on the rows it inserts", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.stampedTags().sync(["t1"]);

      const [row] = await pivotRows(app, "p1");
      // Exactly one pivot row is expected here; the `!` is the assertion.
      const pivot = row!;
      expect(pivot.created_at).toEqual(expect.any(String));
    });

    it("refreshes updated_at on an updated row without touching created_at", async () => {
      // A refresh that rewrote `created_at` would lose when the link was
      // made, which no amount of re-syncing should be able to do.
      const post = (await Post.find("p1"))!;
      await post.relations.stampedTags().attach({ t1: { weight: 1 }, t2: { weight: 2 } });

      const before = await pivotRows(app, "p1");
      // Both rows were stamped by one `attach()`, so one value covers them.
      const createdAt = before[0]!.created_at as string;
      await post.relations.stampedTags().sync({ t1: { weight: 9 }, t3: { weight: 3 } }, false);

      const after = await pivotRows(app, "p1");
      const byId = new Map(after.map((row) => [row.tag_id, row]));

      // Updated: same created_at, a fresh updated_at.
      expect(byId.get("t1")!.created_at).toBe(createdAt);
      expect(byId.get("t1")!.updated_at).toEqual(expect.any(String));
      expect(byId.get("t1")!.weight).toBe(9);
      // Not in the synced set at all, so outside the UPDATE's WHERE and
      // untouched down to its stamp.
      expect(byId.get("t2")!.created_at).toBe(createdAt);
      expect(byId.get("t2")!.updated_at).toBe(createdAt);
      expect(byId.get("t2")!.weight).toBe(2);
      // Inserted: both stamps, equal to each other.
      expect(byId.get("t3")!.created_at).toEqual(expect.any(String));
      expect(byId.get("t3")!.updated_at).toBe(byId.get("t3")!.created_at);
    });

    it("lets one id's explicit updated_at win while the others take the stamp", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.stampedTags().attach(["t1", "t2"]);

      await post.relations
        .stampedTags()
        .sync({ t1: { updated_at: "2001-01-01 00:00:00" }, t2: { weight: 5 } });

      const rows = await pivotRows(app, "p1");
      const byId = new Map(rows.map((row) => [row.tag_id, row]));

      expect(byId.get("t1")!.updated_at).toBe("2001-01-01 00:00:00");
      expect(byId.get("t2")!.updated_at).not.toBe("2001-01-01 00:00:00");
      expect(byId.get("t2")!.updated_at).toEqual(expect.any(String));
    });

    it("syncWithoutDetaching() adds but never removes", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t2", "t3"]);

      const result = await post.relations.tags().syncWithoutDetaching(["t1"]);

      expect(result).toEqual({ attached: ["t1"], detached: [], updated: [] });
      expect(await attachedTagIds(app, "p1")).toEqual(["t1", "t2", "t3"]);
    });

    it("syncWithPivotValues() applies one payload to every id", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().syncWithPivotValues(["t1", "t2"], { weight: 7 });

      const rows = await pivotRows(app, "p1");
      expect(rows.map((row) => row.weight)).toEqual([7, 7]);
    });

    it("syncWithPivotValues() rewrites an already-attached id's payload", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach({ t1: { weight: 1 } });

      const result = await post.relations
        .tagsWithPivot()
        .syncWithPivotValues(["t1"], { weight: 7 });

      expect(result.updated).toEqual(["t1"]);
      const [row] = await pivotRows(app, "p1");
      // Exactly one pivot row is expected here; the `!` is the assertion.
      const pivot = row!;
      expect(pivot.weight).toBe(7);
    });

    it("leaves the pivot untouched when a caller's transaction rolls back", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1"]);

      const { kysely } = app.make<DatabaseManager>(DATABASE_TOKEN).driver();

      await expect(
        transaction(kysely, async () => {
          await post.relations.tags().sync(["t2", "t3"]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(await attachedTagIds(app, "p1")).toEqual(["t1"]);
    });

    it("does not re-attach a soft-deleted related row's pivot link", async () => {
      // The diff must read the PIVOT table, not the related model's
      // scoped builder, otherwise the link to a trashed tag looks
      // absent and sync() re-inserts it, hitting the unique constraint.
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t2"]);

      // Trash the *post* side's counterpart: a soft-deleted Post read
      // back through Tag.posts must still show its pivot rows.
      const tag = (await Tag.find("t1"))!;
      const result = await tag.relations.posts().sync(["p1"]);

      expect(result).toEqual({ attached: [], detached: [], updated: [] });
    });
  });

  describe("sync() statement count", () => {
    /** `prefix`-numbered tags, linked to p1 with an empty pivot payload. */
    async function seedLinked(prefix: string, count: number): Promise<string[]> {
      const ids = Array.from({ length: count }, (_, i) => `${prefix}${i}`);

      for (const id of ids) {
        await Tag.create({ id, name: id });
      }

      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach(Object.fromEntries(ids.map((id) => [id, {}])));

      return ids;
    }

    /** `{ id: { weight } }` for `ids`, the refresh shape: attributes for every id. */
    function withWeights(ids: string[]): Record<string, { weight: number }> {
      return Object.fromEntries(ids.map((id, i) => [id, { weight: i }]));
    }

    it("is constant in the number of ids when every id is already linked", async () => {
      // The refresh case: re-syncing a record's links from upstream
      // supplies attributes for every id and almost all are present
      // already. One UPDATE each made this O(n) sequential round trips,
      // every one of them awaited inside the transaction.
      const post = (await Post.find("p1"))!;

      const few = await seedLinked("a", 5);
      const forFew = await statementsFor(() =>
        post.relations.tagsWithPivot().sync(withWeights(few), false),
      );

      const many = await seedLinked("b", 50);
      const forMany = await statementsFor(() =>
        post.relations.tagsWithPivot().sync(withWeights([...few, ...many]), false),
      );

      expect(forFew).toEqual(["SelectQueryNode", "UpdateQueryNode"]);
      expect(forMany).toEqual(forFew);
    });

    it("is four statements for a mix of new, present and removed ids", async () => {
      const present = await seedLinked("a", 20);
      await Tag.create({ id: "n1", name: "n1" });
      await Tag.create({ id: "n2", name: "n2" });

      const post = (await Post.find("p1"))!;
      // Keeps all but the last two, rewrites their payloads, adds two.
      const kept = present.slice(0, -2);
      const dropped = present.slice(-2);

      let result!: SyncResult;
      const statements = await statementsFor(async () => {
        result = await post.relations
          .tagsWithPivot()
          .sync({ ...withWeights(kept), n1: { weight: 1 }, n2: { weight: 2 } });
      });

      expect(statements).toEqual([
        "SelectQueryNode",
        "UpdateQueryNode",
        "InsertQueryNode",
        "DeleteQueryNode",
      ]);
      expect(result.attached).toEqual(["n1", "n2"]);
      expect(result.updated).toEqual(kept);
      expect(result.detached.sort()).toEqual([...dropped].sort());
    });

    it("skips the UPDATE entirely when no id was given attributes", async () => {
      // A plain `sync([...])` says nothing about payloads, so it must not
      // issue a write that rewrites them, batched or otherwise.
      const ids = await seedLinked("a", 5);
      const post = (await Post.find("p1"))!;

      expect(await statementsFor(() => post.relations.tags().sync(ids, false))).toEqual([
        "SelectQueryNode",
      ]);
    });

    it("writes only the columns each id supplied, leaving the rest alone", async () => {
      // A multi-row upsert cannot express this: its VALUES rows must
      // share a column list, so t1's `note` would be padded away.
      const post = (await Post.find("p1"))!;
      await post.relations
        .tagsWithPivot()
        .attach({ t1: { weight: 1, note: "keep" }, t2: { weight: 2, note: "also" } });

      await post.relations.tagsWithPivot().sync({ t1: { weight: 9 }, t2: { note: "rewritten" } });

      const rows = await pivotRows(app, "p1");
      expect(rows.map((row) => [row.tag_id, row.weight, row.note])).toEqual([
        ["t1", 9, "keep"],
        ["t2", 2, "rewritten"],
      ]);
    });
  });

  describe("toggle()", () => {
    it("attaches the missing and detaches the present", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t2"]);

      const result = await post.relations.tags().toggle(["t2", "t3"]);

      expect(result).toEqual({ attached: ["t3"], detached: ["t2"] });
      expect(await attachedTagIds(app, "p1")).toEqual(["t1", "t3"]);
    });

    it("is its own inverse", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().toggle(["t1", "t2"]);
      await post.relations.tags().toggle(["t1", "t2"]);

      expect(await pivotRows(app, "p1")).toHaveLength(0);
    });
  });

  describe("updateExistingPivot()", () => {
    it("updates one link's pivot attributes and returns the row count", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach({ t1: { weight: 1 }, t2: { weight: 2 } });

      expect(await post.relations.tagsWithPivot().updateExistingPivot("t1", { weight: 9 })).toBe(1);

      const rows = await pivotRows(app, "p1");
      expect(rows.map((row) => [row.tag_id, row.weight])).toEqual([
        ["t1", 9],
        ["t2", 2],
      ]);
    });

    it("returns 0 when the link does not exist", async () => {
      const post = (await Post.find("p1"))!;
      expect(await post.relations.tagsWithPivot().updateExistingPivot("t4", { weight: 9 })).toBe(0);
    });

    it("stamps updated_at when the relation declares withTimestamps", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.stampedTags().attach("t1");

      await post.relations.stampedTags().updateExistingPivot("t1", { weight: 4 });

      const [row] = await pivotRows(app, "p1");
      // Exactly one pivot row is expected here; the `!` is the assertion.
      const pivot = row!;
      expect(pivot.updated_at).toEqual(expect.any(String));
      expect(pivot.weight).toBe(4);
    });
  });

  describe("morphToMany / morphedByMany", () => {
    /** Raw `taggables` rows, ordered for stable assertions. */
    const taggables = async (): Promise<Record<string, any>[]> => {
      const { kysely } = app.make<DatabaseManager>(DATABASE_TOKEN).driver();

      return kysely
        .selectFrom("taggables" as never)
        .selectAll()
        .orderBy("tag_id" as never)
        .execute() as unknown as Promise<Record<string, any>[]>;
    };

    it("attach() writes the type discriminant from the morphed side", async () => {
      const video = (await Video.find("v1"))!;
      await video.relations.tags().attach(["t1", "t2"]);

      expect(await taggables()).toEqual([
        { tag_id: "t1", taggable_type: "video", taggable_id: "v1" },
        { tag_id: "t2", taggable_type: "video", taggable_id: "v1" },
      ]);
    });

    it("attach() writes the discriminant from the inverse (morphedByMany) side", async () => {
      const tag = (await Tag.find("t1"))!;
      await tag.relations.videos().attach("v1");

      expect(await taggables()).toEqual([
        { tag_id: "t1", taggable_type: "video", taggable_id: "v1" },
      ]);
    });

    it("detach() only removes rows matching the discriminant", async () => {
      const video = (await Video.find("v1"))!;
      await video.relations.tags().attach("t1");

      // A same-id row for a DIFFERENT morph type must survive.
      const { kysely } = app.make<DatabaseManager>(DATABASE_TOKEN).driver();
      await kysely
        .insertInto("taggables" as never)
        .values({ tag_id: "t1", taggable_type: "post", taggable_id: "v1" } as never)
        .execute();

      expect(await video.relations.tags().detach()).toBe(1);
      expect(await taggables()).toEqual([
        { tag_id: "t1", taggable_type: "post", taggable_id: "v1" },
      ]);
    });

    it("sync() diffs within the discriminant only", async () => {
      const video = (await Video.find("v1"))!;
      await video.relations.tags().attach(["t1", "t2"]);

      const result = await video.relations.tags().sync(["t2", "t3"]);

      expect(result).toEqual({ attached: ["t3"], detached: ["t1"], updated: [] });
    });
  });

  describe("belongsTo associate()/dissociate()", () => {
    it("sets the foreign key and the loaded relation without saving", async () => {
      const post = (await Post.find("p1"))!;
      const user = (await User.find("u2"))!;

      post.relations.author().associate(user);

      expect(post.user_id).toBe("u2");
      expect(post.author).toBe(user);
      // Not persisted until save().
      expect((await Post.find("p1"))!.user_id).toBe("u1");

      await post.save();
      expect((await Post.find("p1"))!.user_id).toBe("u2");
    });

    it("accepts a bare key and clears the stale loaded relation", async () => {
      const post = (await Post.query().with("author").where("id", "p1").first())!;
      expect(post.author).toBeDefined();

      post.relations.author().associate("u2");

      expect(post.user_id).toBe("u2");
      // The previously loaded u1 would now be a lie.
      expect(post.relationLoaded("author")).toBe(false);
    });

    it("dissociate() nulls the key and clears the relation", async () => {
      const post = (await Post.query().with("author").where("id", "p1").first())!;

      post.relations.author().dissociate();

      expect(post.user_id).toBeNull();
      expect(post.relationLoaded("author")).toBe(false);

      await post.save();
      expect((await Post.find("p1"))!.user_id).toBeNull();
    });

    it("returns the parent so the call can be chained into save()", async () => {
      const post = (await Post.find("p1"))!;
      const user = (await User.find("u2"))!;

      await post.relations.author().associate(user).save();

      expect((await Post.find("p1"))!.user_id).toBe("u2");
    });
  });

  describe("morphTo associate()/dissociate()", () => {
    it("sets both the type and the id", async () => {
      const comment = await Comment.create({
        id: "c1",
        body: "Nice",
        commentable_type: null,
        commentable_id: null,
      });
      const post = (await Post.find("p1"))!;

      comment.relations.commentable().associate(post);

      expect(comment.commentable_type).toBe("post");
      expect(comment.commentable_id).toBe("p1");
      expect(comment.commentable).toBe(post);

      await comment.save();
      const reloaded = (await Comment.find("c1"))!;
      expect(await reloaded.relations.commentable().first()).toMatchObject({ id: "p1" });
    });

    it("writes the discriminant a different target class resolves to", async () => {
      const comment = await Comment.create({
        id: "c1",
        body: "Nice",
        commentable_type: null,
        commentable_id: null,
      });
      const video = (await Video.find("v1"))!;

      comment.relations.commentable().associate(video);

      expect(comment.commentable_type).toBe("video");
      expect(comment.commentable_id).toBe("v1");
    });

    it("dissociate() nulls both columns and clears the relation", async () => {
      const comment = await Comment.create({
        id: "c1",
        body: "Nice",
        commentable_type: "post",
        commentable_id: "p1",
      });

      comment.relations.commentable().dissociate();

      expect(comment.commentable_type).toBeNull();
      expect(comment.commentable_id).toBeNull();
      expect(comment.relationLoaded("commentable")).toBe(false);
    });
  });

  describe("hasMany save()/create()", () => {
    it("create() sets the foreign key", async () => {
      const user = (await User.find("u1"))!;
      const post = await user.relations.posts().create({ id: "p9", title: "Made" });

      expect(post.user_id).toBe("u1");
      expect((await Post.find("p9"))!.title).toBe("Made");
    });

    it("createMany() creates each row against the parent", async () => {
      const user = (await User.find("u2"))!;
      const posts = await user.relations.posts().createMany([
        { id: "p8", title: "A" },
        { id: "p9", title: "B" },
      ]);

      expect(posts.map((post) => post.user_id)).toEqual(["u2", "u2"]);
      expect(await user.relations.posts().count()).toBe(2);
    });

    it("save() re-parents an existing model", async () => {
      const user = (await User.find("u2"))!;
      const post = (await Post.find("p1"))!;

      await user.relations.posts().save(post);

      expect((await Post.find("p1"))!.user_id).toBe("u2");
    });

    it("save() inserts an unsaved model", async () => {
      const user = (await User.find("u2"))!;
      const post = new Post({ id: "p7", title: "Fresh" });

      await user.relations.posts().save(post);

      expect((await Post.find("p7"))!.user_id).toBe("u2");
    });

    it("saveMany() saves each model", async () => {
      const user = (await User.find("u2"))!;
      await user.relations
        .posts()
        .saveMany([new Post({ id: "p5", title: "A" }), new Post({ id: "p6", title: "B" })]);

      expect(await user.relations.posts().count()).toBe(2);
    });
  });

  describe("morphMany save()/create()", () => {
    it("create() sets both the morph type and id", async () => {
      const post = (await Post.find("p1"))!;
      const comment = await post.relations.comments().create({ id: "c1", body: "Hi" });

      expect(comment.commentable_type).toBe("post");
      expect(comment.commentable_id).toBe("p1");
    });

    it("save() stamps the morph columns onto an existing model", async () => {
      const comment = await Comment.create({
        id: "c2",
        body: "Orphan",
        commentable_type: null,
        commentable_id: null,
      });
      const post = (await Post.find("p1"))!;

      await post.relations.comments().save(comment);

      const reloaded = (await Comment.find("c2"))!;
      expect(reloaded.commentable_type).toBe("post");
      expect(reloaded.commentable_id).toBe("p1");
    });
  });

  describe("reads reflect writes", () => {
    it("the relation query returns what was attached", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t3"]);

      const tags = await post.relations.tags().get();
      expect(tags.pluck("id").sort().toArray()).toEqual(["t1", "t3"]);
    });

    it("pivot columns written by attach() read back through withPivot", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tagsWithPivot().attach({ t1: { weight: 9 } });

      const tag = (await post.relations.tagsWithPivot().first())!;
      expect((tag as any).pivot).toMatchObject({ weight: 9 });
    });

    it("the write methods do not disturb the read builder's chaining", async () => {
      const post = (await Post.find("p1"))!;
      await post.relations.tags().attach(["t1", "t2", "t3"]);

      const tags = await post.relations.tags().where("id", "!=", "t2").orderBy("id").get();
      expect(tags.pluck("id").toArray()).toEqual(["t1", "t3"]);
    });
  });
});
