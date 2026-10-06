import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import {
  BaseModel,
  KNOWN_CONFIG_KEYS,
  MISPLACED_STATICS,
  Model,
  RelationNotLoadedError,
} from "../src/model.js";
import { Cast } from "../src/casts.js";
import { hasMany } from "../src/relations.js";
import type { HasMany } from "../src/markers.js";

/**
 * The two `ModelConfig` keys that are accepted but have no effect at the
 * type level: `strictRelations` (the N+1 tripwire) and `connection` (a
 * model pinned to "analytics" must not silently use the primary
 * database).
 */

interface CommentAttributes {
  id: string;
  post_id: string;
  body: string;
}

interface PostAttributes {
  id: string;
  title: string;
  comments: HasMany<Comment>;
}

class Comment extends Model<CommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  timestamps: false,
}) {}

class StrictPost extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
  strictRelations: true,
}) {
  static override relationships = {
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
  };
}

class LenientPost extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
  };
}

interface EventAttributes {
  id: string;
  name: string;
}

/** Pinned to a *named* connection, not the default. */
class AnalyticsEvent extends Model<EventAttributes>()({
  table: "events",
  primaryKey: "id",
  timestamps: false,
  connection: "analytics",
}) {}

/** Same table, default connection, the control. */
class PrimaryEvent extends Model<EventAttributes>()({
  table: "events",
  primaryKey: "id",
  timestamps: false,
}) {}

async function createSchema(kysely: any): Promise<void> {
  await kysely.schema
    .createTable("posts")
    .addColumn("id", "text", (col: any) => col.primaryKey())
    .addColumn("title", "text", (col: any) => col.notNull())
    .execute();
  await kysely.schema
    .createTable("comments")
    .addColumn("id", "text", (col: any) => col.primaryKey())
    .addColumn("post_id", "text", (col: any) => col.notNull())
    .addColumn("body", "text", (col: any) => col.notNull())
    .execute();
  await kysely.schema
    .createTable("events")
    .addColumn("id", "text", (col: any) => col.primaryKey())
    .addColumn("name", "text", (col: any) => col.notNull())
    .execute();
}

describe("config: strictRelations", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);
    await createSchema(manager.driver().kysely);

    await StrictPost.create({ id: "p1", title: "hi" });
    await Comment.create({ id: "c1", post_id: "p1", body: "first" });
  });

  afterEach(() => clearCurrentApp());

  it("throws on reading a declared relation that was never loaded", async () => {
    const post = await StrictPost.findOrFail("p1");
    expect(() => post.comments).toThrow(RelationNotLoadedError);
    expect(() => post.comments).toThrow(/strictRelations/);
  });

  it("names all three escape hatches in the message", async () => {
    const post = await StrictPost.findOrFail("p1");
    try {
      void post.comments;
      expect.unreachable("expected a RelationNotLoadedError");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('.with("comments")');
      expect(message).toContain('load("comments")');
      expect(message).toContain("relations.comments()");
    }
  });

  it("does not throw once the relation is eager loaded", async () => {
    const post = await StrictPost.query().with("comments").firstOrFail();
    expect(post.comments).toHaveLength(1);
  });

  it("does not throw once the relation is lazily loaded", async () => {
    const post = await StrictPost.findOrFail("p1");
    await post.load("comments");
    expect(post.comments).toHaveLength(1);
  });

  it("still returns an empty collection for a genuinely empty loaded relation", async () => {
    await StrictPost.create({ id: "p2", title: "lonely" });
    const post = await StrictPost.query().with("comments").where("id", "p2").firstOrFail();
    expect(post.comments).toHaveLength(0);
  });

  it("never blocks the query-side `relations` namespace", async () => {
    const post = await StrictPost.findOrFail("p1");
    await expect(post.relations.comments().count()).resolves.toBe(1);
  });

  it("does not shadow a real column that shares a relation's name", async () => {
    const post = StrictPost.hydrate({ id: "p1", title: "hi", comments: 3 });
    expect(post.comments).toBe(3);
  });

  it("leaves an undeclared/unknown attribute alone", async () => {
    const post = await StrictPost.findOrFail("p1");
    expect((post as any).nonsense).toBeUndefined();
  });

  it("is off by default", async () => {
    const post = await LenientPost.findOrFail("p1");
    expect(post.comments).toBeUndefined();
  });
});

describe("config: connection", () => {
  let app: Application;
  let manager: DatabaseManager;

  beforeEach(async () => {
    app = new Application();
    manager = new DatabaseManager(app, { default: "primary", connections: {} });
    manager.extend("primary", () => new SqliteDriver({ filename: ":memory:" }));
    manager.extend("analytics", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    // Two genuinely separate in-memory databases, each with an `events`
    // table, so a write landing on the wrong one is visible, not merely
    // undetectable.
    await createSchema(manager.driver("primary").kysely);
    await createSchema(manager.driver("analytics").kysely);
  });

  afterEach(() => clearCurrentApp());

  it("writes to the named connection, not the default", async () => {
    await AnalyticsEvent.create({ id: "e1", name: "signup" });

    const onAnalytics = await manager
      .driver("analytics")
      .kysely.selectFrom("events")
      .selectAll()
      .execute();
    const onPrimary = await manager
      .driver("primary")
      .kysely.selectFrom("events")
      .selectAll()
      .execute();

    expect(onAnalytics).toHaveLength(1);
    expect(onPrimary).toHaveLength(0);
  });

  it("reads from the named connection, not the default", async () => {
    await manager
      .driver("primary")
      .kysely.insertInto("events")
      .values({ id: "p1", name: "primary-only" })
      .execute();
    await manager
      .driver("analytics")
      .kysely.insertInto("events")
      .values({ id: "a1", name: "analytics-only" })
      .execute();

    expect(await AnalyticsEvent.find("p1")).toBeUndefined();
    expect((await AnalyticsEvent.findOrFail("a1")).name).toBe("analytics-only");
    expect((await PrimaryEvent.findOrFail("p1")).name).toBe("primary-only");
    expect(await PrimaryEvent.find("a1")).toBeUndefined();
  });

  it("is not captured by a transaction open on a different connection", async () => {
    await manager
      .transaction(async () => {
        await PrimaryEvent.create({ id: "p1", name: "rolled-back" });
        await AnalyticsEvent.create({ id: "a1", name: "committed" });
        throw new Error("rollback");
      }, "primary")
      .catch(() => {});

    // The primary write rolled back with its transaction; the analytics
    // model was never inside it, so its row survives.
    expect(await PrimaryEvent.find("p1")).toBeUndefined();
    expect(await AnalyticsEvent.find("a1")).toBeDefined();
  });

  it("participates in a transaction on its OWN connection", async () => {
    await manager
      .transaction(async () => {
        await AnalyticsEvent.create({ id: "a1", name: "rolled-back" });
        throw new Error("rollback");
      }, "analytics")
      .catch(() => {});

    expect(await AnalyticsEvent.find("a1")).toBeUndefined();
  });
});

/**
 * The runtime config validator. These configs are all rejected by the
 * type-checker, so every case here is one a plain-JS consumer, a
 * dynamically-assembled config, or an `as any` could actually produce.
 * Without the validator each builds a broken model class that fails
 * later, far from the cause.
 */
describe("runtime config validation", () => {
  /** Build with a config the type-checker would refuse. */
  const build = (config: unknown) => () => (Model as any)()(config);

  it("still requires a table", () => {
    expect(build({})).toThrow(/`table` is required/);
    expect(build({ table: "" })).toThrow(/`table` is required/);
  });

  it("rejects a casts entry that is not a Cast", () => {
    // Without the check this is accepted, then throws `toModelType is not
    // a function` from inside hydration on the first read.
    expect(build({ table: "t", casts: { active: "boolean" } })).toThrow(
      /casts\.active is not a Cast/,
    );
    expect(build({ table: "t", casts: { active: null } })).toThrow(/casts\.active is not a Cast/);
  });

  it("accepts a real Cast", () => {
    expect(build({ table: "t", casts: { active: Cast.boolean() } })).not.toThrow();
  });

  it("rejects an unknown keyType, and accepts the three valid forms", () => {
    expect(build({ table: "t", keyType: "bogus" })).toThrow(/`keyType` must be/);
    expect(build({ table: "t", keyType: {} })).toThrow(/`keyType` must be/);
    expect(build({ table: "t", keyType: { generate: () => "x", type: "wrong" } })).toThrow(
      /`keyType.type`/,
    );

    expect(build({ table: "t", keyType: "increment" })).not.toThrow();
    expect(build({ table: "t", keyType: "uuid" })).not.toThrow();
    expect(build({ table: "t", keyType: { type: "string", generate: () => "x" } })).not.toThrow();
  });

  it("rejects a non-array fillable/guarded/hidden/visible/appends", () => {
    expect(build({ table: "t", fillable: "name" })).toThrow(/`fillable` must be an array/);
    expect(build({ table: "t", guarded: "name" })).toThrow(/`guarded` must be an array/);
    expect(build({ table: "t", hidden: [1] })).toThrow(/`hidden` must be an array/);
  });

  it("rejects declaring both fillable and guarded:[*]", () => {
    // Laravel's precedence is fillable-wins, which silently ignores the
    // `guarded: ["*"]` the author wrote to lock the model down.
    expect(build({ table: "t", fillable: ["name"], guarded: ["*"] })).toThrow(
      /use one or the other/,
    );

    // Either alone is fine, as is guarding specific columns alongside fillable.
    expect(build({ table: "t", guarded: ["*"] })).not.toThrow();
    expect(build({ table: "t", fillable: ["name"] })).not.toThrow();
    expect(build({ table: "t", fillable: ["name"], guarded: ["id"] })).not.toThrow();
  });

  it("rejects a malformed timestamps or softDeletes", () => {
    expect(build({ table: "t", timestamps: "yes" })).toThrow(/`timestamps` must be/);
    expect(build({ table: "t", timestamps: { createdAt: 5 } })).toThrow(/`timestamps.createdAt`/);
    expect(build({ table: "t", softDeletes: {} })).toThrow(/requires a `column`/);
    expect(build({ table: "t", softDeletes: "yes" })).toThrow(/`softDeletes` must be/);

    // `null` disables one half of the pair, a supported form.
    expect(build({ table: "t", timestamps: { createdAt: null } })).not.toThrow();
    expect(build({ table: "t", softDeletes: { column: "archived_at" } })).not.toThrow();
  });

  it("names the table in the message, so the failing model is obvious", () => {
    expect(build({ table: "widgets", keyType: "bogus" })).toThrow(/Model config for "widgets"/);
  });

  /*
   * The unknown-key branch. Unlike every case above, this one is also
   * silent at the *type* level without the matching `ModelLint` rules
   * (see `types.test-d.ts`): the config literal is inferred into `const
   * C`, so excess-property checking never fires, and the factory reads
   * only the keys it knows. A `dispatchesEvents` written here therefore
   * typechecked, validated, and dispatched nothing.
   */
  it("rejects a class static written into the config, and says what to do", () => {
    expect(build({ table: "t", dispatchesEvents: {} })).toThrow(
      /`dispatchesEvents` is a static on the model class, not a config key/,
    );
    expect(build({ table: "t", dispatchesEvents: {} })).toThrow(/static override dispatchesEvents/);

    // The whole list, since each is a plausible config key for a
    // different reason: a lifecycle hook, a declaration, or the resolved
    // form of a config key that does exist.
    for (const key of MISPLACED_STATICS) {
      expect(build({ table: "t", [key]: {} })).toThrow(
        new RegExp(`\`${key}\` is a static on the model class`),
      );
    }
  });

  it("rejects a key that is neither a config option nor a known static", () => {
    expect(build({ table: "t", nonsense: 1 })).toThrow(/`nonsense` is not a Model config option/);
    // A near-miss typo gets the same treatment — it is not a static, so
    // the "declare it with static override" advice would be wrong.
    expect(build({ table: "t", softDelete: true })).toThrow(
      /`softDelete` is not a Model config option/,
    );
  });

  it("accepts every key ModelConfig declares", () => {
    // Guards the rejection above against being too broad: the list the
    // validator checks against is hand-written, so a config option added
    // to the interface and forgotten there would reject a valid model.
    const everyKey = Object.fromEntries(KNOWN_CONFIG_KEYS.map((key) => [key, undefined]));
    expect(build({ ...everyKey, table: "t" })).not.toThrow();
  });

  it("checks unknown keys before the shape of the known ones", () => {
    // A misplaced static is likelier to be the cause of whatever else
    // looks wrong than a malformed value, so it should be the error the
    // author sees.
    expect(build({ table: "t", relationships: {}, keyType: "bogus" })).toThrow(
      /`relationships` is a static on the model class/,
    );
  });
});

/**
 * The two key lists the validator checks against duplicate type-level
 * knowledge (`ModelConfig` and `MisplacedStatics`). `tsc` catches a name
 * in a list that the type does not have, and a type key missing from a
 * list, but neither can see whether `MISPLACED_STATICS` still names
 * something that is a real static on `BaseModel` at runtime.
 */
describe("config key lists", () => {
  it("names only real statics in MISPLACED_STATICS", () => {
    // The point of the list: each name is a static, which is exactly why
    // writing it in the config looks plausible. If one is renamed or
    // removed, its rule would name a key nobody can write.
    for (const key of MISPLACED_STATICS) {
      expect(BaseModel).toHaveProperty(key);
    }
  });

  it("keeps the two lists disjoint", () => {
    // An overlap would be a contradiction: a key cannot be both a valid
    // config option and a misplaced static. The static's rule is
    // unreachable in that case, since the known-key check runs first.
    const known = new Set<string>(KNOWN_CONFIG_KEYS);
    expect(MISPLACED_STATICS.filter((key) => known.has(key))).toEqual([]);
  });
});
