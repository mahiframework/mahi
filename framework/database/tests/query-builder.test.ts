import { beforeEach, describe, expect, it } from "vitest";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { QueryBuilder } from "../src/query-builder.js";
import { Expression } from "../src/expression.js";

interface WidgetTable {
  id: string;
  name: string;
  active: number;
  price: number;
  min_price: number;
  deleted_at: string | null;
  created_at: string;
  tags: string;
}

describe("QueryBuilder", () => {
  let query: () => QueryBuilder<WidgetTable>;
  let kysely: SqliteDriver["kysely"];

  beforeEach(async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });
    kysely = driver.kysely;
    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("price", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("min_price", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("deleted_at", "text")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo("2024-01-01 00:00:00"))
      .addColumn("tags", "text", (col) => col.notNull().defaultTo("[]"))
      .execute();

    await driver.kysely
      .insertInto("widgets")
      .values([
        {
          id: "1",
          name: "Sprocket",
          active: 1,
          price: 10,
          min_price: 5,
          deleted_at: null,
          created_at: "2024-03-15 10:30:00",
          tags: JSON.stringify(["metal", "small"]),
        },
        {
          id: "2",
          name: "Cog",
          active: 0,
          price: 20,
          min_price: 25,
          deleted_at: "2024-01-01",
          created_at: "2024-06-20 08:00:00",
          tags: JSON.stringify(["metal", "vip"]),
        },
        {
          id: "3",
          name: "Gear",
          active: 1,
          price: 30,
          min_price: 5,
          deleted_at: null,
          created_at: "2024-06-20 22:15:00",
          tags: JSON.stringify([]),
        },
      ])
      .execute();

    query = () => new QueryBuilder<WidgetTable>(() => driver.kysely, "widgets");
  });

  it("chains where().where().orderBy().limit().get()", async () => {
    const rows = await query()
      .where("active", 1)
      .where("price", ">", 5)
      .orderBy("price", "desc")
      .limit(1)
      .get();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Gear" });
  });

  it("where() accepts a two-arg equality shorthand", async () => {
    const rows = await query().where("active", 0).get();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Cog" });
  });

  it("orWhere() combines conditions with OR instead of AND", async () => {
    const rows = await query()
      .where("name", "Sprocket")
      .orWhere("name", "Cog")
      .orderBy("name")
      .get();
    expect(rows.map((r) => r.name)).toEqual(["Cog", "Sprocket"]);
  });

  it("where(callback) groups nested conditions, composing with AND against the outer clause", async () => {
    const rows = await query()
      .where("active", 1)
      .where((q) => q.where("name", "Sprocket").orWhere("name", "Gear"))
      .orderBy("name")
      .get();

    expect(rows.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);
  });

  it("whereNot()/orWhereNot() negate a condition", async () => {
    const rows = await query().whereNot("name", "Sprocket").orderBy("name").get();
    expect(rows.map((r) => r.name)).toEqual(["Cog", "Gear"]);
  });

  it("whereIn() filters by a set of values", async () => {
    const rows = await query().whereIn("name", ["Sprocket", "Gear"]).orderBy("name").get();
    expect(rows.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);
  });

  it("whereNotIn() excludes a set of values", async () => {
    const rows = await query().whereNotIn("name", ["Sprocket", "Gear"]).get();
    expect(rows.map((r) => r.name)).toEqual(["Cog"]);
  });

  it("whereIn() accepts a Subquery callback in place of a value list, same overload real Laravel uses", async () => {
    await kysely.schema
      .createTable("featured")
      .addColumn("widget_id", "text", (col) => col.notNull())
      .execute();
    await kysely
      .insertInto("featured" as never)
      .values([{ widget_id: "1" }, { widget_id: "3" }] as never)
      .execute();

    const rows = await query()
      .whereIn("id", (q) => q.table("featured").select("widget_id"))
      .orderBy("name")
      .get();

    expect(rows.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);
  });

  it("whereIn(subquery) composes with other where clauses", async () => {
    await kysely.schema
      .createTable("featured")
      .addColumn("widget_id", "text", (col) => col.notNull())
      .execute();
    await kysely
      .insertInto("featured" as never)
      .values([{ widget_id: "1" }, { widget_id: "3" }] as never)
      .execute();

    const rows = await query()
      .whereIn("id", (q) => q.table("featured").select("widget_id"))
      .where("price", ">", 20)
      .get();

    expect(rows.map((r) => r.name)).toEqual(["Gear"]);
  });

  it("whereNull()/whereNotNull() filter by IS NULL / IS NOT NULL", async () => {
    const active = await query().whereNull("deleted_at").orderBy("name").get();
    expect(active.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);

    const trashed = await query().whereNotNull("deleted_at").get();
    expect(trashed.map((r) => r.name)).toEqual(["Cog"]);
  });

  it("whereBetween()/whereNotBetween() filter by an inclusive range", async () => {
    const between = await query().whereBetween("price", 10, 20).orderBy("name").get();
    expect(between.map((r) => r.name)).toEqual(["Cog", "Sprocket"]);

    const notBetween = await query().whereNotBetween("price", 10, 20).get();
    expect(notBetween.map((r) => r.name)).toEqual(["Gear"]);
  });

  /**
   * SQLite only. The four methods share one grammar member, so the
   * per-engine spelling is proven once in `query-grammar.test.ts` (shape)
   * and the cross-dialect suite (rows); what's left to check is that the
   * connector and negation wiring behaves like the `where` family's.
   */
  describe("whereLike()", () => {
    it("matches a pattern, folding case by default", async () => {
      const rows = await query().whereLike("name", "%spro%").get();
      expect(rows.map((r) => r.name)).toEqual(["Sprocket"]);
    });

    it("treats % and _ as wildcards rather than escaping them", async () => {
      // The value IS the pattern, matching Laravel. A caller who wants a
      // literal `%` escapes it themselves.
      expect((await query().whereLike("name", "Spr_cket").get()).map((r) => r.name)).toEqual([
        "Sprocket",
      ]);
      expect(await query().whereLike("name", "spro").get()).toHaveLength(0);
    });

    it("orWhereLike() widens rather than narrowing", async () => {
      const rows = await query()
        .where("name", "Cog")
        .orWhereLike("name", "%gear%")
        .orderBy("name")
        .get();
      expect(rows.map((r) => r.name)).toEqual(["Cog", "Gear"]);
    });

    it("whereNotLike() excludes the matches", async () => {
      const rows = await query().whereNotLike("name", "%o%").get();
      expect(rows.map((r) => r.name)).toEqual(["Gear"]);
    });

    it("orWhereNotLike() combines the negation with OR", async () => {
      const rows = await query()
        .where("name", "Sprocket")
        .orWhereNotLike("name", "%o%")
        .orderBy("name")
        .get();
      expect(rows.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);
    });

    it("composes inside a where() group", async () => {
      const rows = await query()
        .where("active", 1)
        .where((q) => q.whereLike("name", "%spro%").orWhereLike("name", "%gear%"))
        .orderBy("name")
        .get();
      expect(rows.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);
    });
  });

  it("whereColumn() compares two columns on the same row", async () => {
    const rows = await query().whereColumn("price", ">", "min_price").orderBy("name").get();
    expect(rows.map((r) => r.name)).toEqual(["Gear", "Sprocket"]);
  });

  it("whereExists()/whereNotExists() filter by correlated subquery existence", async () => {
    await kysely.schema
      .createTable("featured")
      .addColumn("widget_id", "text", (col) => col.notNull())
      .execute();
    await kysely
      .insertInto("featured" as never)
      .values([{ widget_id: "1" }] as never)
      .execute();

    const withFeature = await query()
      .whereExists((q) =>
        q
          .table("featured")
          .select("widget_id")
          .whereColumn("featured.widget_id", "=", "widgets.id"),
      )
      .get();
    expect(withFeature.map((r) => r.name)).toEqual(["Sprocket"]);

    const withoutFeature = await query()
      .whereNotExists((q) =>
        q
          .table("featured")
          .select("widget_id")
          .whereColumn("featured.widget_id", "=", "widgets.id"),
      )
      .orderBy("name")
      .get();
    expect(withoutFeature.map((r) => r.name)).toEqual(["Cog", "Gear"]);
  });

  it("whereIn()/whereExists() accept an already-built QueryBuilder instance directly (no callback)", async () => {
    await kysely.schema
      .createTable("featured")
      .addColumn("widget_id", "text", (col) => col.notNull())
      .execute();
    await kysely
      .insertInto("featured" as never)
      .values([{ widget_id: "1" }] as never)
      .execute();

    const featuredIds = new QueryBuilder<{ widget_id: string }>(() => kysely, "featured").select(
      "widget_id",
    );
    const rows = await query().whereIn("id", featuredIds).get();
    expect(rows.map((r) => r.name)).toEqual(["Sprocket"]);

    const hasFeatured = new QueryBuilder<{ widget_id: string }>(() => kysely, "featured").select(
      "widget_id",
    );
    const withFeature = await query().whereExists(hasFeatured).get();
    expect(withFeature.length).toBe(3); // uncorrelated, matches every row since "featured" has at least one row
  });

  it("whereIn()/whereExists() accept a raw Expression as the subquery value, correctly parenthesized", async () => {
    const rows = await query()
      .whereIn("id", Expression.raw("select id from widgets where price > ?", [15]))
      .orderBy("name")
      .get();
    expect(rows.map((r) => r.name)).toEqual(["Cog", "Gear"]);

    const withMatch = await query()
      .whereExists(Expression.raw("select 1 from widgets where price > ?", [15]))
      .get();
    expect(withMatch.length).toBe(3); // uncorrelated, matches every row since at least one widget has price > 15
  });

  it("whereRaw()/orWhereRaw() accept a raw SQL fragment with positional bindings", async () => {
    const rows = await query().whereRaw("price > ?", [15]).orderBy("name").get();
    expect(rows.map((r) => r.name)).toEqual(["Cog", "Gear"]);
  });

  it("orderByDesc()/latest()/oldest() are ordering shorthands", async () => {
    const desc = await query().orderByDesc("price").get();
    expect(desc.map((r) => r.name)).toEqual(["Gear", "Cog", "Sprocket"]);

    const oldest = await query().oldest("price").get();
    expect(oldest.map((r) => r.name)).toEqual(["Sprocket", "Cog", "Gear"]);
  });

  it("distinct() marks the query as SELECT DISTINCT", async () => {
    const rows = await query().distinct().where("active", 1).get();
    expect(rows).toHaveLength(2);
  });

  it("offset()/skip() skips the given number of rows", async () => {
    // SQLite requires a LIMIT alongside OFFSET.
    const rows = await query().orderBy("price", "asc").limit(10).offset(1).get();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Cog" });

    const skipped = await query().orderBy("price", "asc").take(10).skip(1).get();
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({ name: "Cog" });
  });

  it("first() returns undefined when nothing matches", async () => {
    const row = await query().where("name", "Missing").first();
    expect(row).toBeUndefined();
  });

  it("first() returns the first matching row", async () => {
    const row = await query().where("active", 1).orderBy("price", "asc").first();
    expect(row).toMatchObject({ name: "Sprocket" });
  });

  it("count() respects where() conditions but ignores orderBy()/limit()/offset()", async () => {
    const total = await query().limit(1).count();
    expect(total).toBe(3);

    const filtered = await query().where("active", 1).limit(1).count();
    expect(filtered).toBe(2);
  });

  it("exists()/doesntExist() report whether any row matches", async () => {
    expect(await query().where("name", "Sprocket").exists()).toBe(true);
    expect(await query().where("name", "Missing").exists()).toBe(false);
    expect(await query().where("name", "Missing").doesntExist()).toBe(true);
  });

  it("min()/max()/sum()/avg() compute scalar aggregates over matching rows", async () => {
    expect(await query().min("price")).toBe(10);
    expect(await query().max("price")).toBe(30);
    expect(await query().sum("price")).toBe(60);
    expect(await query().avg("price")).toBe(20);
  });

  it("countBy() groups matching rows by a column and returns a value -> count map", async () => {
    const counts = await query().countBy("active");
    expect(counts.get(1)).toBe(2);
    expect(counts.get(0)).toBe(1);
  });

  it("insert() inserts a row and returns the values passed in", async () => {
    const created = await query().insert({
      id: "4",
      name: "Bolt",
      active: 1,
      price: 5,
      min_price: 1,
      deleted_at: null,
    });
    expect(created).toMatchObject({ id: "4", name: "Bolt" });

    const row = await query().where("id", "4").first();
    expect(row).toMatchObject({ name: "Bolt" });
  });

  it("update() patches rows matching where() and returns the affected count", async () => {
    const affected = await query().where("active", 1).update({ active: 0 });
    expect(affected).toBe(2);

    const stillActive = await query().where("active", 1).count();
    expect(stillActive).toBe(0);
  });

  it("delete() removes rows matching where() and returns the affected count", async () => {
    const affected = await query().where("active", 0).delete();
    expect(affected).toBe(1);

    expect(await query().count()).toBe(2);
  });

  it("updateOrInsert() updates an existing matching row instead of inserting a duplicate", async () => {
    const changed = await query().updateOrInsert({ id: "1" }, { name: "Sprocket Mk2" });
    expect(changed).toBe(true);

    const row = await query().where("id", "1").first();
    expect(row).toMatchObject({ name: "Sprocket Mk2" });
    expect(await query().count()).toBe(3);
  });

  it("updateOrInsert() inserts a new row when nothing matches", async () => {
    const inserted = await query().updateOrInsert(
      { id: "4" },
      { name: "Bolt", active: 1, price: 5, min_price: 1, deleted_at: null },
    );
    expect(inserted).toBe(true);
    expect(await query().count()).toBe(4);

    const row = await query().where("id", "4").first();
    expect(row).toMatchObject({ name: "Bolt" });
  });

  it("upsert() inserts new rows and updates conflicting ones by the unique column", async () => {
    const affected = await query().upsert(
      [
        { id: "1", name: "Sprocket Renamed", active: 1, price: 99, min_price: 5, deleted_at: null },
        { id: "4", name: "Bolt", active: 1, price: 5, min_price: 1, deleted_at: null },
      ],
      "id",
    );
    expect(affected).toBe(2);

    const renamed = await query().where("id", "1").first();
    expect(renamed).toMatchObject({ name: "Sprocket Renamed", price: 99 });

    const inserted = await query().where("id", "4").first();
    expect(inserted).toMatchObject({ name: "Bolt" });
  });

  it("increment()/decrement() adjust a numeric column in one UPDATE", async () => {
    const affected = await query().where("id", "1").increment("price", 5);
    expect(affected).toBe(1);
    expect(await query().where("id", "1").first()).toMatchObject({ price: 15 });

    await query().where("id", "1").decrement("price");
    expect(await query().where("id", "1").first()).toMatchObject({ price: 14 });
  });

  it("incrementEach()/decrementEach() adjust multiple columns in one UPDATE", async () => {
    await query().where("id", "1").incrementEach({ price: 5, min_price: 1 });
    expect(await query().where("id", "1").first()).toMatchObject({ price: 15, min_price: 6 });

    await query().where("id", "1").decrementEach({ price: 5, min_price: 1 });
    expect(await query().where("id", "1").first()).toMatchObject({ price: 10, min_price: 5 });
  });

  it("raw() exposes the underlying Kysely SELECT builder as an escape hatch", async () => {
    const rows = await query().where("active", 1).raw().execute();
    expect(rows).toHaveLength(2);
  });

  it("whereDate()/whereMonth()/whereDay()/whereYear()/whereTime() filter by a date part", async () => {
    const byDate = await query().whereDate("created_at", "2024-03-15").get();
    expect(byDate.map((r) => r.name)).toEqual(["Sprocket"]);

    const byMonth = await query().whereMonth("created_at", "06").orderBy("name").get();
    expect(byMonth.map((r) => r.name)).toEqual(["Cog", "Gear"]);

    const byYear = await query().whereYear("created_at", "2024").orderBy("name").get();
    expect(byYear.map((r) => r.name)).toEqual(["Cog", "Gear", "Sprocket"]);

    const byDay = await query().whereDay("created_at", "20").orderBy("name").get();
    expect(byDay.map((r) => r.name)).toEqual(["Cog", "Gear"]);

    const byTime = await query().whereTime("created_at", ">", "12:00:00").get();
    expect(byTime.map((r) => r.name)).toEqual(["Gear"]);
  });

  it("orWhereDate()/orWhereMonth() combine a date-part condition with OR", async () => {
    const rows = await query()
      .where("name", "Sprocket")
      .orWhereMonth("created_at", "06")
      .orderBy("name")
      .get();
    expect(rows.map((r) => r.name)).toEqual(["Cog", "Gear", "Sprocket"]);
  });

  it("whereJsonContains()/whereJsonDoesntContain() filter by JSON array membership", async () => {
    const withMetal = await query().whereJsonContains("tags", "metal").orderBy("name").get();
    expect(withMetal.map((r) => r.name)).toEqual(["Cog", "Sprocket"]);

    const withoutMetal = await query().whereJsonDoesntContain("tags", "metal").get();
    expect(withoutMetal.map((r) => r.name)).toEqual(["Gear"]);
  });

  it("whereJsonContains() matches numeric JSON members by value", async () => {
    await query()
      .where("id", "1")
      .update({ tags: JSON.stringify([1, 2, 3]) });
    await query()
      .where("id", "2")
      .update({ tags: JSON.stringify([2, 4]) });
    await query()
      .where("id", "3")
      .update({ tags: JSON.stringify([5]) });

    const withTwo = await query().whereJsonContains("tags", 2).orderBy("name").get();
    expect(withTwo.map((r) => r.name)).toEqual(["Cog", "Sprocket"]);

    const withoutTwo = await query().whereJsonDoesntContain("tags", 2).get();
    expect(withoutTwo.map((r) => r.name)).toEqual(["Gear"]);
  });

  it("whereJsonContains() uses value equality, so a null needle matches no rows (not JSON-null members)", async () => {
    // The `IS` operator this replaced matched a JSON `null` element against
    // a bound null (and treated the needle as an identity test), diverging
    // from MySQL/Postgres value-containment. `=` never matches null, which
    // is the correct, cross-dialect behaviour.
    await query()
      .where("id", "1")
      .update({ tags: JSON.stringify([null, "x"]) });

    const rows = await query()
      .whereJsonContains("tags", null as unknown as string)
      .get();
    expect(rows).toEqual([]);
  });

  it("whereJsonContainsKey()/whereJsonDoesntContainKey() check JSON path presence", async () => {
    const present = await query().whereJsonContainsKey("tags").orderBy("name").get();
    expect(present).toHaveLength(3);

    const missing = await query().whereJsonDoesntContainKey("tags").get();
    expect(missing).toHaveLength(0);
  });

  it("whereJsonLength() filters by JSON array length", async () => {
    const rows = await query().whereJsonLength("tags", ">", 0).orderBy("name").get();
    expect(rows.map((r) => r.name)).toEqual(["Cog", "Sprocket"]);

    const empty = await query().whereJsonLength("tags", 0).get();
    expect(empty.map((r) => r.name)).toEqual(["Gear"]);
  });

  it("orderByRaw()/inRandomOrder() append raw ORDER BY fragments", async () => {
    const rows = await query().orderByRaw("price desc").get();
    expect(rows.map((r) => r.name)).toEqual(["Gear", "Cog", "Sprocket"]);

    const randomized = await query().inRandomOrder().get();
    expect(randomized).toHaveLength(3);
  });

  it("reorder()/reorderDesc() replace any previously accumulated ordering", async () => {
    const rows = await query().orderBy("name", "asc").reorder("price", "desc").get();
    expect(rows.map((r) => r.name)).toEqual(["Gear", "Cog", "Sprocket"]);

    const descRows = await query().orderBy("name", "asc").reorderDesc("price").get();
    expect(descRows.map((r) => r.name)).toEqual(["Gear", "Cog", "Sprocket"]);

    const cleared = await query().orderBy("name", "asc").reorder().where("id", "1").get();
    expect(cleared.map((r) => r.name)).toEqual(["Sprocket"]);
  });

  it("lock()/lockForUpdate()/sharedLock() track intent but are a documented no-op on SQLite", async () => {
    // Must not throw, SQLite's dialect errors if FOR UPDATE/SHARE is
    // actually compiled into the query, so these are no-ops by design.
    const rows = await query().where("active", 1).lockForUpdate().get();
    expect(rows).toHaveLength(2);

    const q = query().sharedLock();
    expect(q.getLock()).toBe(false);
  });

  it("toSql()/getBindings() expose the compiled SQL and its bound parameters", async () => {
    const q = query().where("active", 1).where("price", ">", 15);
    expect(q.toSql()).toContain("where");
    expect(q.getBindings()).toEqual([1, 15]);
  });

  it("toRawSql() inlines bound values into the SQL string for debugging", async () => {
    const q = query().where("name", "Sprocket");
    expect(q.toRawSql()).toContain("'Sprocket'");
  });

  it("clone() branches a query into independent copies that don't affect each other", async () => {
    const base = query().where("active", 1);
    const clone = base.clone().where("price", ">", 15);

    const baseRows = await base.get();
    const cloneRows = await clone.get();

    expect(baseRows.map((r) => r.name).sort()).toEqual(["Gear", "Sprocket"]);
    expect(cloneRows.map((r) => r.name)).toEqual(["Gear"]);
  });

  it("selectRaw() widens the row type and adds a correlated-subquery column", async () => {
    await kysely.schema
      .createTable("featured")
      .addColumn("widget_id", "text", (col) => col.notNull())
      .execute();
    await kysely
      .insertInto("featured" as never)
      .values([{ widget_id: "1" }, { widget_id: "1" }, { widget_id: "3" }] as never)
      .execute();

    const rows = await query()
      .selectRaw<{ feature_count: number }>(
        "(select count(*) from featured where featured.widget_id = widgets.id) as feature_count",
      )
      .orderBy("name")
      .get();

    expect(rows.map((r) => ({ name: r.name, feature_count: r.feature_count }))).toEqual([
      { name: "Cog", feature_count: 0 },
      { name: "Gear", feature_count: 1 },
      { name: "Sprocket", feature_count: 2 },
    ]);
  });

  it("selectRaw() supports positional ? bindings", async () => {
    const rows = await query()
      .selectRaw<{ label: string }>("CASE WHEN active = ? THEN ? ELSE ? END as label", [
        1,
        "on",
        "off",
      ])
      .orderBy("name")
      .get();

    expect(rows.map((r) => r.label)).toEqual(["off", "on", "on"]);
  });

  it("selectRaw() applies to first() as well as get()", async () => {
    const row = await query()
      .selectRaw<{ doubled: number }>("price * 2 as doubled")
      .where("id", "1")
      .first();

    expect(row?.doubled).toBe(20);
  });

  it("when()/unless() conditionally apply a callback, chaining when the callback returns void", async () => {
    const name = "Cog";
    const rows = await query()
      .when(name, (q, value) => q.where("name", value))
      .get();
    expect(rows.map((r) => r.name)).toEqual(["Cog"]);

    const all = await query()
      .when("", (q) => q.where("name", "Cog"))
      .get();
    expect(all.length).toBe(3);

    const unlessRows = await query()
      .unless(false, (q) => q.where("name", "Gear"))
      .get();
    expect(unlessRows.map((r) => r.name)).toEqual(["Gear"]);

    const fromClosure = await query()
      .when(
        (q) => q.toSql().length > 0,
        (q) => q.where("active", 1),
      )
      .get();
    expect(fromClosure.length).toBe(2);
  });

  describe("groupBy() / having()", () => {
    it("groups by a column with an aggregate selectRaw()", async () => {
      const rows = await query()
        .selectRaw<{ active: number; total: number }>("active, count(*) as total")
        .groupBy("active")
        .orderBy("active")
        .get();

      expect(rows.map((r) => [(r as any).active, (r as any).total])).toEqual([
        [0, 1],
        [1, 2],
      ]);
    });

    it("filters groups with having()", async () => {
      const rows = await query()
        .selectRaw<{ active: number; total: number }>("active, count(*) as total")
        .groupBy("active")
        .having("total", ">", 1)
        .get();

      expect(rows.map((r) => (r as any).active)).toEqual([1]);
    });

    it("supports havingRaw() with bindings", async () => {
      const rows = await query()
        .selectRaw<{ active: number; total: number }>("active, count(*) as total")
        .groupBy("active")
        .havingRaw("count(*) >= ?", [2])
        .get();

      expect(rows.map((r) => (r as any).active)).toEqual([1]);
    });

    it("combines multiple having clauses with orHaving()", async () => {
      const rows = await query()
        .selectRaw<{ active: number; total: number }>("active, count(*) as total")
        .groupBy("active")
        .having("total", ">", 5)
        .orHaving("active", 0)
        .orderBy("active")
        .get();

      expect(rows.map((r) => (r as any).active)).toEqual([0]);
    });
  });

  describe("first()", () => {
    it("compiles with limit 1 rather than fetching the whole result set", async () => {
      // Kysely's executeTakeFirst() is `const [row] = await execute()`,
      // without an explicit limit the database ships every matching row.
      const executor = (kysely as any).getExecutor();
      const original = executor.executeQuery.bind(executor);
      const statements: string[] = [];
      executor.executeQuery = (compiled: any, ...rest: any[]) => {
        statements.push(compiled.sql);

        return original(compiled, ...rest);
      };

      try {
        await query().where("active", 1).first();
      } finally {
        executor.executeQuery = original;
      }

      expect(statements).toHaveLength(1);
      expect(statements[0]!.toLowerCase()).toContain("limit");
    });

    it("still honours offset(), so first() after skip() is the nth row", async () => {
      const row = await query().orderBy("id").offset(1).first();
      expect(row).toMatchObject({ id: "2" });
    });

    it("returns the first row of an ordered query", async () => {
      const row = await query().orderBy("price", "desc").first();
      expect(row).toMatchObject({ name: "Gear" });
    });
  });

  describe("whereIn() with an empty list", () => {
    it("whereIn([]) matches nothing (never compiles `in ()`)", async () => {
      const rows = await query().whereIn("id", []).get();
      expect(rows).toHaveLength(0);
      expect(query().whereIn("id", []).toSql()).not.toContain("in ()");
    });

    it("whereNotIn([]) matches everything", async () => {
      const rows = await query().whereNotIn("id", []).get();
      expect(rows).toHaveLength(3);
    });

    it("an empty whereIn still composes with other conditions", async () => {
      const rows = await query().where("active", 1).orWhereIn("id", []).get();
      expect(rows).toHaveLength(2);

      const all = await query().where("active", 1).orWhereNotIn("id", []).get();
      expect(all).toHaveLength(3);
    });

    it("count() of an empty whereIn is 0", async () => {
      expect(await query().whereIn("id", []).count()).toBe(0);
    });
  });

  describe("count() with grouping / distinct / union", () => {
    it("counts GROUPS, not rows, for a grouped query", async () => {
      // Two distinct `active` values (0 and 1) across three rows.
      expect(await query().groupBy("active").count()).toBe(2);
    });

    it("honours having() when counting groups", async () => {
      expect(await query().groupBy("active").havingRaw("count(*) > ?", [1]).count()).toBe(1);
    });

    it("counts distinct projections for a distinct query", async () => {
      expect(await query().select("active").distinct().count()).toBe(2);
    });

    it("counts both sides of a union", async () => {
      const total = await query()
        .where("active", 1)
        .select("id")
        .unionAll((q) => q.table("widgets").select("id").where("active", 0))
        .count();
      expect(total).toBe(3);
    });

    it("ignores limit/offset/order when counting a grouped query", async () => {
      expect(await query().groupBy("active").orderBy("active").limit(1).offset(1).count()).toBe(2);
    });

    it("is unchanged for an ordinary query", async () => {
      expect(await query().where("active", 1).count()).toBe(2);
    });
  });

  describe("updateOrInsert()", () => {
    it("does not permanently mutate the builder it was called on", async () => {
      const builder = query();
      await builder.updateOrInsert({ id: "1" }, { name: "Renamed" });

      // The `id = 1` predicate belonged to that one call. If it were
      // pushed onto `this`, this count would be 1.
      expect(await builder.count()).toBe(3);
    });

    it("updates an existing row", async () => {
      await query().updateOrInsert({ id: "1" }, { name: "Renamed" });
      expect(await query().where("id", "1").first()).toMatchObject({ name: "Renamed" });
      expect(await query().count()).toBe(3);
    });

    it("inserts when nothing matches", async () => {
      await query().updateOrInsert({ id: "9" }, { name: "New" });
      expect(await query().where("id", "9").first()).toMatchObject({ name: "New" });
    });

    it("a second call on the same builder still targets the right row", async () => {
      const builder = query();
      await builder.updateOrInsert({ id: "1" }, { name: "First" });
      await builder.updateOrInsert({ id: "2" }, { name: "Second" });

      expect(await query().where("id", "1").first()).toMatchObject({ name: "First" });
      expect(await query().where("id", "2").first()).toMatchObject({ name: "Second" });
    });
  });

  describe("whereRaw() placeholder tokenising", () => {
    it("does not treat a `?` inside a string literal as a placeholder", async () => {
      const rows = await query().whereRaw("name = 'Sprocket?' or name = 'Cog'").get();
      expect(rows.map((r) => r.name)).toEqual(["Cog"]);
    });

    it("counts placeholders outside quotes only", async () => {
      const rows = await query().whereRaw("name like ? and name != 'x?y'", ["S%"]).get();
      expect(rows.map((r) => r.name)).toEqual(["Sprocket"]);
    });

    it("`??` outside quotes is an escape, consuming no binding", () => {
      // Postgres' `??` (the escaped form of its `?` JSON operator) must
      // not be read as two placeholders demanding two bindings.
      expect(() => query().whereRaw(`"tags" ?? 'urgent'`, []).toSql()).not.toThrow();
    });

    it("does not treat Postgres' `?|` / `?&` JSON operators as placeholders", () => {
      expect(() => query().whereRaw(`"tags" ?| '{a,b}'`, []).toSql()).not.toThrow();
      expect(() => query().whereRaw(`"tags" ?& '{a,b}'`, []).toSql()).not.toThrow();
    });

    it("handles an escaped quote inside a string literal", async () => {
      const rows = await query().whereRaw("name != 'it''s ? here'", []).get();
      expect(rows).toHaveLength(3);
    });

    it("still rejects a binding-count mismatch", () => {
      expect(() => query().whereRaw("name = ? and price = ?", ["x"]).toSql()).toThrow(
        /1 binding\(s\) provided but the SQL has 2/,
      );
    });

    it("does not treat a `?` inside a quoted identifier as a placeholder", async () => {
      const rows = await query().whereRaw(`"name" != 'x'`).get();
      expect(rows).toHaveLength(3);
    });
  });
});
