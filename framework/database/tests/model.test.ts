import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model, ModelNotFoundError } from "../src/model.js";

interface WidgetAttributes {
  id: string;
  name: string;
  active: number;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

/**
 * A nullable column (`note`) and a defaulted one (`active`), the two
 * shapes a `create()` payload can leave out. Separate from `Widget`,
 * whose every column the existing tests supply.
 */
interface GadgetAttributes {
  id: string;
  name: string;
  note: string | null;
  active: number;
}

class Gadget extends Model<GadgetAttributes>()({
  table: "gadgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("Model (static)", () => {
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

    await manager
      .driver()
      .kysely.schema.createTable("gadgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("note", "text")
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("create() inserts a row and returns the values passed in", async () => {
    const created = await Widget.create({ id: "1", name: "Sprocket", active: 1 });
    expect(created).toEqual({ id: "1", name: "Sprocket", active: 1 });
  });

  it("create() leaves a column it was not given ABSENT, not null", async () => {
    // The insert reads back the primary key alone, so the instance holds
    // exactly what went into it. The same row re-read has the database's
    // own values, `null` for a nullable column and the default for a
    // defaulted one — neither of which `create()` can infer from the
    // payload, which is why they are absent rather than guessed.
    const created = await Gadget.create({ id: "1", name: "Sprocket" });

    expect(created.note).toBeUndefined();
    expect(created.active).toBeUndefined();

    const reread = await Gadget.findOrFail("1");

    expect(reread.note).toBeNull();
    expect(reread.active).toBe(1);

    // `refresh()` brings the instance up to the row.
    await created.refresh();
    expect(created.note).toBeNull();
    expect(created.active).toBe(1);
  });

  it("create() keeps a column passed explicitly as null, on both the instance and a re-read", async () => {
    const created = await Gadget.create({ id: "1", name: "Sprocket", note: null });

    expect(created.note).toBeNull();
    expect((await Gadget.findOrFail("1")).note).toBeNull();
  });

  it("find() returns the row by id, or undefined if missing", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    expect(await Widget.find("1")).toMatchObject({ name: "Sprocket" });
    expect(await Widget.find("missing")).toBeUndefined();
  });

  it("findOrFail() throws ModelNotFoundError when missing", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    await expect(Widget.findOrFail("1")).resolves.toMatchObject({ name: "Sprocket" });
    await expect(Widget.findOrFail("missing")).rejects.toThrow(ModelNotFoundError);
  });

  it("all() returns every row as a Collection", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });
    await Widget.create({ id: "2", name: "Cog", active: 0 });

    const all = await Widget.all();
    expect(all.length).toBe(2);
    expect(all.toArray()).toHaveLength(2);
  });

  it("first() returns the first row, or undefined if none", async () => {
    expect(await Widget.first()).toBeUndefined();

    await Widget.create({ id: "1", name: "Sprocket", active: 1 });
    expect(await Widget.first()).toMatchObject({ name: "Sprocket" });
  });

  it("firstOrFail() throws ModelNotFoundError when empty", async () => {
    await expect(Widget.firstOrFail()).rejects.toThrow(ModelNotFoundError);
  });

  it("query().where() filters by a single column", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });
    await Widget.create({ id: "2", name: "Cog", active: 0 });

    const active = await Widget.query().where("active", 1).get();
    expect(active.length).toBe(1);
    expect(active.first()).toMatchObject({ name: "Sprocket" });
  });

  it("update() patches only the given columns", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    await Widget.update("1", { active: 0 });
    const updated = await Widget.find("1");

    expect(updated).toMatchObject({ id: "1", name: "Sprocket", active: 0 });
  });

  it("delete() removes the row", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    await Widget.delete("1");

    expect(await Widget.find("1")).toBeUndefined();
  });

  it("findMany() returns matching rows in one batched query, absent for missing ids", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });
    await Widget.create({ id: "2", name: "Cog", active: 0 });
    await Widget.create({ id: "3", name: "Gear", active: 1 });

    const found = await Widget.findMany(["1", "3", "missing"]);
    expect(found.pluck("id").sort().toArray()).toEqual(["1", "3"]);
  });

  it("findMany() returns an empty Collection for an empty id list without querying", async () => {
    const found = await Widget.findMany([]);
    expect(found.toArray()).toEqual([]);
  });

  it("firstOrNew() returns the matching row unpersisted-shape when found, or a plain merged object when not", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    const found = await Widget.firstOrNew({ id: "1" });
    expect(found).toMatchObject({ name: "Sprocket" });

    const notFound = await Widget.firstOrNew({ id: "2" }, { name: "Cog", active: 0 });
    expect(notFound).toEqual({ id: "2", name: "Cog", active: 0 });
    // firstOrNew() never writes to the database.
    expect(await Widget.find("2")).toBeUndefined();
  });

  it("firstOrCreate() returns the matching row, or creates and returns a new one", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    const found = await Widget.firstOrCreate({ id: "1" });
    expect(found).toMatchObject({ name: "Sprocket" });

    const created = await Widget.firstOrCreate({ id: "2" }, { name: "Cog", active: 0 });
    expect(created).toMatchObject({ id: "2", name: "Cog", active: 0 });
    expect(await Widget.find("2")).toMatchObject({ name: "Cog" });
  });

  it("updateOrCreate() updates the matching row, or creates one when none matches", async () => {
    await Widget.create({ id: "1", name: "Sprocket", active: 1 });

    const updated = await Widget.updateOrCreate({ id: "1" }, { name: "Sprocket Mk2" });
    expect(updated).toMatchObject({ id: "1", name: "Sprocket Mk2" });
    expect(await Widget.find("1")).toMatchObject({ name: "Sprocket Mk2" });

    const created = await Widget.updateOrCreate({ id: "2" }, { name: "Cog", active: 0 });
    expect(created).toMatchObject({ id: "2", name: "Cog", active: 0 });
    expect(await Widget.find("2")).toMatchObject({ name: "Cog" });
  });
});
