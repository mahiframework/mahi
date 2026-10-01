import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Factory } from "../src/factory.js";
import { Cast } from "../src/casts.js";

interface WidgetAttributes {
  id: string;
  name: string;
  active: number;
}
type WidgetTable = WidgetAttributes;

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {
  static override factory(): WidgetFactory {
    return new WidgetFactory();
  }
}

class WidgetFactory extends Factory<typeof Widget> {
  protected model = Widget;

  protected definition(): WidgetAttributes {
    return {
      id: randomUUID(),
      name: `Widget ${Math.random().toString(36).slice(2, 8)}`,
      active: 1,
    };
  }

  inactive(): this {
    return this.state({ active: 0 });
  }
}

/**
 * A factory subclass carrying constructor-set config, the case that
 * forces `clone()` to copy off the prototype: re-running this
 * constructor would need the `prefix` argument, which `clone()` has no
 * way to supply.
 */
class PrefixedWidgetFactory extends Factory<typeof Widget> {
  protected model = Widget;

  constructor(private prefix: string) {
    super();
  }

  protected definition(): WidgetAttributes {
    return { id: randomUUID(), name: `${this.prefix}-widget`, active: 1 };
  }
}

describe("Factory", () => {
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
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("make() returns an array of valid row(s) without touching the DB", async () => {
    const rows = await new WidgetFactory().make();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: 1 });
    expect(rows[0]!.id).toBeTruthy();

    expect((await Widget.all()).length).toBe(0);
  });

  it("makeOne() returns a single row without touching the DB", async () => {
    const row = await new WidgetFactory().makeOne();
    expect(row).toMatchObject({ active: 1 });
    expect(row.id).toBeTruthy();

    expect((await Widget.all()).length).toBe(0);
  });

  it("create() inserts and returns an array of row(s)", async () => {
    const rows = await new WidgetFactory().create();
    expect(rows).toBeInstanceOf(Array);
    expect(rows).toHaveLength(1);

    const found = await Widget.find(rows[0]!.id);
    expect(found).toMatchObject({ name: rows[0]!.name });
  });

  it("createOne() inserts and returns a single row", async () => {
    const row = await new WidgetFactory().createOne();
    expect(row).not.toBeInstanceOf(Array);

    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ name: row.name });
  });

  it("overrides merge over definition() defaults", async () => {
    const row = await new WidgetFactory().createOne({ active: 0 });
    expect(row.active).toBe(0);

    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ active: 0 });
  });

  it("times(n).create() inserts exactly n rows in one batch", async () => {
    const rows = await new WidgetFactory().times(5).create();
    expect(rows).toHaveLength(5);

    expect((await Widget.all()).length).toBe(5);
  });

  it("times(n).make() returns n in-memory rows without touching the DB", async () => {
    const rows = await new WidgetFactory().times(3).make();
    expect(rows).toHaveLength(3);
  });

  it("createOne()/makeOne() ignore times()", async () => {
    const row = await new WidgetFactory().times(5).makeOne();
    expect(row).not.toBeInstanceOf(Array);
  });

  it("state() layers a partial override on top of definition()", async () => {
    const row = await new WidgetFactory().inactive().makeOne();
    expect(row.active).toBe(0);
  });

  it("state() accepts a resolver receiving the attributes built so far", async () => {
    const row = await new WidgetFactory()
      .state((attrs) => ({ name: `${attrs.name}-suffixed` }))
      .makeOne();
    expect(row.name.endsWith("-suffixed")).toBe(true);
  });

  it("multiple state() calls compose in call order, explicit overrides win last", async () => {
    const row = await new WidgetFactory()
      .state({ active: 0 })
      .state({ active: 1 })
      .makeOne({ name: "explicit" });
    expect(row.active).toBe(1);
    expect(row.name).toBe("explicit");
  });

  it("afterMaking() runs on make()/makeOne(), even without a DB write", async () => {
    let called = 0;
    const row = await new WidgetFactory()
      .afterMaking((w) => {
        called++;
        w.name = `${w.name}-made`;
      })
      .makeOne();

    expect(called).toBe(1);
    expect(row.name.endsWith("-made")).toBe(true);
    expect((await Widget.all()).length).toBe(0);
  });

  it("afterMaking() runs once per row for times(n)", async () => {
    let called = 0;
    const rows = await new WidgetFactory()
      .times(3)
      .afterMaking(() => {
        called++;
      })
      .make();

    expect(called).toBe(3);
    expect(rows).toHaveLength(3);
  });

  it("afterCreating() runs after create()/createOne() inserts the row", async () => {
    const created: string[] = [];
    const row = await new WidgetFactory()
      .afterCreating((w) => {
        created.push(w.id);
      })
      .createOne();

    expect(created).toEqual([row.id]);
  });

  it("afterCreating() does not run for make()/makeOne()", async () => {
    let called = false;
    await new WidgetFactory()
      .afterCreating(() => {
        called = true;
      })
      .makeOne();

    expect(called).toBe(false);
  });

  it("Model.factory() resolves the model's declared Factory", async () => {
    const row = await Widget.factory().createOne();
    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ name: row.name });
  });

  it("Model.factory() throws for models without a factory() override", async () => {
    class Gadget extends Model<WidgetAttributes>()({
      table: "gadgets",
      primaryKey: "id",
    }) {}

    expect(() => Gadget.factory()).toThrow();
  });

  it("create()/createOne() fire creating/created Model events by default", async () => {
    const fired: string[] = [];
    Widget.on("creating", () => {
      fired.push("creating");
    });
    Widget.on("created", (row) => {
      fired.push(`created:${(row as WidgetTable).id}`);
    });

    const row = await new WidgetFactory().createOne();

    expect(fired).toEqual(["creating", `created:${row.id}`]);
  });

  it("times(n).create() fires creating/created once per row, in one batch insert", async () => {
    const fired: string[] = [];
    Widget.on("created", (row) => {
      fired.push((row as WidgetTable).id);
    });

    const rows = await new WidgetFactory().times(3).create();

    expect(fired.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("createQuietly() inserts normally but suppresses Model events", async () => {
    let called = false;
    Widget.on("created", () => {
      called = true;
    });

    const rows = await new WidgetFactory().createQuietly();

    expect(rows).toHaveLength(1);
    expect(await Widget.find(rows[0]!.id)).toMatchObject({ name: rows[0]!.name });
    expect(called).toBe(false);
  });

  it("createOneQuietly() inserts normally but suppresses Model events", async () => {
    let called = false;
    Widget.on("created", () => {
      called = true;
    });

    const row = await new WidgetFactory().createOneQuietly();

    expect(await Widget.find(row.id)).toMatchObject({ name: row.name });
    expect(called).toBe(false);
  });

  it("createQuietly() still runs afterCreating callbacks (a Factory hook, not a Model event)", async () => {
    const created: string[] = [];

    const rows = await new WidgetFactory()
      .afterCreating((w) => {
        created.push(w.id);
      })
      .createQuietly();

    expect(created).toEqual([rows[0]!.id]);
  });

  it("every chainable method returns the same instance, not a copy", () => {
    const factory = new WidgetFactory();

    expect(factory.times(2)).toBe(factory);
    expect(factory.state({ active: 0 })).toBe(factory);
    expect(factory.afterMaking(() => {})).toBe(factory);
    expect(factory.afterCreating(() => {})).toBe(factory);
    expect(factory.inactive()).toBe(factory);
  });

  it("state() on a held factory persists for later builds off that same factory", async () => {
    const factory = new WidgetFactory();
    factory.state({ active: 0 });

    expect((await factory.makeOne()).active).toBe(0);
  });

  it("times() sticks across terminal calls on a held factory", async () => {
    const factory = new WidgetFactory().times(3);

    expect(await factory.create()).toHaveLength(3);
    expect(await factory.create()).toHaveLength(3);
    expect((await Widget.all()).length).toBe(6);
  });

  it("clone() carries the accumulated states across", async () => {
    const row = await new WidgetFactory().state({ active: 0 }).clone().makeOne();

    expect(row.active).toBe(0);
  });

  it("clone() carries times() across", async () => {
    expect(await new WidgetFactory().times(4).clone().make()).toHaveLength(4);
  });

  it("mutating a clone does not affect the original", async () => {
    const base = new WidgetFactory();
    const branch = base.clone().state({ active: 0 }).times(3);

    expect(branch).not.toBe(base);
    expect((await branch.makeOne()).active).toBe(0);
    expect((await base.makeOne()).active).toBe(1);
    expect(await base.make()).toHaveLength(1);
  });

  it("mutating the original does not affect an existing clone", async () => {
    const base = new WidgetFactory();
    const branch = base.clone();
    base.state({ active: 0 }).times(5);

    expect((await branch.makeOne()).active).toBe(1);
    expect(await branch.make()).toHaveLength(1);
  });

  it("clone() preserves the factory subclass and its state methods", async () => {
    const clone = new WidgetFactory().clone();

    expect(clone).toBeInstanceOf(WidgetFactory);
    expect((await clone.inactive().makeOne()).active).toBe(0);
  });

  it("clone() carries a subclass's constructor-set fields across", async () => {
    const clone = new PrefixedWidgetFactory("alpha").state({ active: 0 }).clone();

    expect(clone).toBeInstanceOf(PrefixedWidgetFactory);

    const row = await clone.makeOne();
    expect(row.name).toBe("alpha-widget");
    expect(row.active).toBe(0);
  });

  it("clone() copies the callback arrays rather than sharing them", async () => {
    const base = new WidgetFactory();
    const branch = base.clone();

    let baseCalls = 0;
    let branchCalls = 0;
    base.afterMaking(() => {
      baseCalls++;
    });
    branch.afterMaking(() => {
      branchCalls++;
    });

    await base.makeOne();
    expect(baseCalls).toBe(1);
    expect(branchCalls).toBe(0);

    await branch.makeOne();
    expect(baseCalls).toBe(1);
    expect(branchCalls).toBe(1);
  });

  it("clone() keeps callbacks registered before the branch on both sides", async () => {
    let calls = 0;
    const base = new WidgetFactory().afterMaking(() => {
      calls++;
    });

    await base.clone().makeOne();
    await base.makeOne();

    expect(calls).toBe(2);
  });
});

/**
 * A `definition()` is typed as the model shape, so a factory author
 * writes `published: true` and `meta: { … }`, and those must reach the
 * database as `1` and `'{"a":1}'`.
 *
 * The build path used to go through `setRawAttributes()`, which skips
 * casts entirely, so both bound as a raw boolean/object: `create()` threw
 * on SQLite and MySQL and silently coerced on Postgres. It builds through
 * `forceFill()` now (casts applied, `fillable`/`guarded` deliberately
 * bypassed. A factory is trusted fixture code).
 */
describe("Factory applies the model's casts", () => {
  let app: Application;

  interface CastedAttributes {
    id: string;
    published: boolean;
    meta: Record<string, unknown> | null;
    note: string | null;
  }

  class Casted extends Model<CastedAttributes>()({
    table: "casted",
    primaryKey: "id",
    timestamps: false,
    keyType: "uuid",
    casts: { published: Cast.boolean(), meta: Cast.json<Record<string, unknown>>() },
  }) {}

  class CastedFactory extends Factory<typeof Casted> {
    protected model = Casted;
    protected definition(): Record<string, any> {
      // Model-shape values, exactly as the type invites.
      return { published: true, meta: { a: 1 }, note: null };
    }
  }

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("casted")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("published", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("meta", "text")
      .addColumn("note", "text")
      .execute();
  });

  afterEach(() => clearCurrentApp());

  it("create() writes the cast DB shape", async () => {
    await new CastedFactory().createOne();

    const raw = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("casted")
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(raw.published).toBe(1);
    expect(raw.meta).toBe('{"a":1}');
  });

  it("make() reads back through the casts", async () => {
    const row = await new CastedFactory().makeOne();
    expect(row.published).toBe(true);
    expect(row.meta).toEqual({ a: 1 });
  });

  it("casts an override the same way as a definition value", async () => {
    await new CastedFactory().createOne({ published: false, meta: { b: 2 } });

    const raw = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("casted")
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(raw.published).toBe(0);
    expect(raw.meta).toBe('{"b":2}');
  });

  it("leaves an uncast column alone", async () => {
    const row = await new CastedFactory().createOne({ note: "plain" });
    expect(row.note).toBe("plain");
  });

  it("still sets guarded columns (a factory bypasses fillable/guarded)", async () => {
    // `forceFill` rather than `fill`. A factory must be able to set an
    // `id` (or any guarded column) on a totally-guarded model.
    class Guarded extends Model<CastedAttributes>()({
      table: "casted",
      primaryKey: "id",
      timestamps: false,
      keyType: "uuid",
      guarded: ["*"],
      casts: { published: Cast.boolean(), meta: Cast.json<Record<string, unknown>>() },
    }) {}

    class GuardedFactory extends Factory<typeof Guarded> {
      protected model = Guarded;
      protected definition(): Record<string, any> {
        return { published: true, meta: null, note: null };
      }
    }

    const row = await new GuardedFactory().createOne();
    expect(row.published).toBe(true);
  });
});
