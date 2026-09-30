import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";

/**
 * `EloquentBuilder` casts the values it binds, in both the where and the
 * write direction, the model-shape-in / DB-shape-out contract the
 * instance accessors and the static `Model.update()` already had.
 *
 * The engine-visible half of this lives in
 * `drivers/cross-dialect.integration.test.ts` (C11), which is what
 * proves it on MySQL and Postgres too. These are the binding-level
 * cases: cheap, exact, and able to assert things a round-trip cannot
 * (that an *uncast* column is left strictly alone, that a subquery is
 * not mangled, that a qualified column still resolves its cast).
 */

interface WidgetAttributes {
  id: number;
  name: string;
  active: boolean;
  meta: Record<string, unknown> | null;
  published_at: DateTime | null;
  note: string | null;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
  casts: {
    active: Cast.boolean(),
    meta: Cast.json<Record<string, unknown>>(),
    published_at: Cast.datetime() as never,
  },
}) {}

const WHEN = DateTime.fromISO("2026-01-02T03:04:05.000Z", "UTC");

describe("EloquentBuilder casts its bindings", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("widgets")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("meta", "text")
      .addColumn("published_at", "text")
      .addColumn("note", "text")
      .execute();
  });

  afterEach(() => clearCurrentApp());

  describe("where family", () => {
    it("casts a boolean comparand to the DB 0/1", () => {
      expect(Widget.query().where("active", true).getBindings()).toEqual([1]);
      expect(Widget.query().where("active", false).getBindings()).toEqual([0]);
    });

    it("casts with an explicit operator too", () => {
      expect(Widget.query().where("active", "!=", true).getBindings()).toEqual([1]);
    });

    it("casts a DateTime comparand to its ISO string", () => {
      expect(
        Widget.query()
          .where("published_at", WHEN as never)
          .getBindings(),
      ).toEqual([WHEN.toISOString()]);
    });

    it("casts an object comparand to JSON text", () => {
      expect(
        Widget.query()
          .where("meta", { a: 1 } as never)
          .getBindings(),
      ).toEqual(['{"a":1}']);
    });

    it("leaves an UNCAST column's value strictly alone", () => {
      expect(Widget.query().where("note", "hello").getBindings()).toEqual(["hello"]);
      expect(Widget.query().where("name", "x").getBindings()).toEqual(["x"]);
    });

    it("passes null through without casting", () => {
      // `whereNull` is the idiomatic spelling, but an explicit null
      // comparand must not be turned into `0` by the boolean cast.
      expect(
        Widget.query()
          .where("active", null as never)
          .getBindings(),
      ).toEqual([null]);
    });

    it("applies to orWhere/whereNot/orWhereNot alike", () => {
      expect(Widget.query().orWhere("active", true).getBindings()).toEqual([1]);
      expect(Widget.query().whereNot("active", true).getBindings()).toEqual([1]);
      expect(Widget.query().orWhereNot("active", true).getBindings()).toEqual([1]);
    });

    it("casts inside a nested where() group", () => {
      const builder = Widget.query().where((q) => {
        q.where("active", true).orWhere("active", false);
      });
      expect(builder.getBindings()).toEqual([1, 0]);
    });

    it("resolves the cast for a table-qualified column", () => {
      expect(
        Widget.query()
          .where("widgets.active" as never, true as never)
          .getBindings(),
      ).toEqual([1]);
    });
  });

  describe("whereLike", () => {
    it("binds the pattern uncast, even on a cast column", () => {
      // A `LIKE` pattern is not a column value: running `%2026%`
      // through the datetime cast would either throw or rewrite it into
      // something that matches nothing.
      expect(
        Widget.query()
          .whereLike("published_at" as never, "%2026%")
          .getBindings(),
      ).toEqual(["%2026%"]);
      expect(
        Widget.query()
          .whereLike("meta" as never, "%a%")
          .getBindings(),
      ).toEqual(["%a%"]);
    });

    it("reaches the grammar through every variant", () => {
      expect(Widget.query().orWhereLike("name", "%x%").getBindings()).toEqual(["%x%"]);
      expect(Widget.query().whereNotLike("name", "%x%").getBindings()).toEqual(["%x%"]);
      expect(Widget.query().orWhereNotLike("name", "%x%").getBindings()).toEqual(["%x%"]);
    });

    it("filters rows through the model layer", async () => {
      await Widget.create({
        name: "Sprocket",
        active: true,
        meta: null,
        published_at: null,
        note: null,
      });
      await Widget.create({
        name: "Cog",
        active: true,
        meta: null,
        published_at: null,
        note: null,
      });

      const found = await Widget.query().whereLike("name", "%spro%").get();
      expect(found.toArray().map((w) => w.name)).toEqual(["Sprocket"]);
    });
  });

  describe("whereIn / whereBetween", () => {
    it("casts every value in an IN list", () => {
      expect(Widget.query().whereIn("active", [true, false]).getBindings()).toEqual([1, 0]);
    });

    it("casts a whereNotIn list", () => {
      expect(Widget.query().whereNotIn("active", [true]).getBindings()).toEqual([1]);
    });

    it("leaves a subquery form untouched", () => {
      // There are no value bindings to cast in the subquery form, and
      // casting the callback itself would be nonsense.
      const builder = Widget.query().whereIn("id", (q) => {
        q.table("widgets").select("id").where("name", "x");
      });
      expect(builder.getBindings()).toEqual(["x"]);
    });

    it("casts both bounds of a between", () => {
      const min = DateTime.fromISO("2026-01-01T00:00:00.000Z", "UTC");
      const max = DateTime.fromISO("2026-12-31T00:00:00.000Z", "UTC");
      expect(
        Widget.query()
          .whereBetween("published_at", min as never, max as never)
          .getBindings(),
      ).toEqual([min.toISOString(), max.toISOString()]);
    });
  });

  describe("writes", () => {
    it("update() casts each column it sets", async () => {
      await Widget.create({ name: "w", active: false, meta: null, published_at: null, note: null });
      await Widget.query()
        .where("name", "w")
        .update({ active: true, meta: { a: 1 }, published_at: WHEN } as never);

      const raw = await app
        .make<DatabaseManager>(DATABASE_TOKEN)
        .driver()
        .kysely.selectFrom("widgets")
        .selectAll()
        .executeTakeFirstOrThrow();

      expect(raw.active).toBe(1);
      expect(raw.meta).toBe('{"a":1}');
      expect(raw.published_at).toBe(WHEN.toISOString());
    });

    it("insert() casts each column it writes", async () => {
      await Widget.query().insert({
        name: "i",
        active: true,
        meta: { b: 2 },
        published_at: WHEN,
      } as never);

      const row = await Widget.query().where("name", "i").firstOrFail();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ b: 2 });
      expect(row.published_at?.toISOString()).toBe(WHEN.toISOString());
    });

    it("leaves an uncast column in a write payload alone", async () => {
      await Widget.query().insert({ name: "n", note: "plain" } as never);
      const row = await Widget.query().where("name", "n").firstOrFail();
      expect(row.note).toBe("plain");
    });

    it("increment()'s extra payload casts, and the counter itself is untouched", async () => {
      await Widget.create({ name: "c", active: false, meta: null, published_at: null, note: null });
      await Widget.query()
        .where("name", "c")
        .increment("id", 0, { active: true } as never);

      const row = await Widget.query().where("name", "c").firstOrFail();
      expect(row.active).toBe(true);
    });

    it("is idempotent, a value already in DB shape survives a second cast", async () => {
      // The static `Model.update()` casts before calling the builder,
      // which now casts again. `toDatabaseType` accepts `ModelType |
      // DbType` precisely so this is a no-op rather than, say,
      // double-encoding the JSON.
      await Widget.create({ name: "d", active: false, meta: null, published_at: null, note: null });
      await Widget.query()
        .where("name", "d")
        .update({ active: 1, meta: '{"a":1}', published_at: WHEN.toISOString() } as never);

      const row = await Widget.query().where("name", "d").firstOrFail();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ a: 1 });
      expect(row.published_at?.toISOString()).toBe(WHEN.toISOString());
    });
  });
});
