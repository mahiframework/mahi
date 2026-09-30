import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Rule, Validator, rule } from "@mahiframework/validation";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { registerValidationPresenceResolver } from "../src/validation-presence.js";
import { transaction } from "../src/transaction.js";

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

describe("exists / unique against sqlite", () => {
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

    registerValidationPresenceResolver();

    await Widget.create({ id: "1", name: "Sprocket", active: 1 });
  });

  afterEach(() => {
    Rule.setPresenceResolver(undefined);
    clearCurrentApp();
  });

  it("exists() passes when the row is present and fails when it is not", async () => {
    const ok = new Validator({ id: "1" }, {}, { id: rule().exists(Widget) });
    expect(await ok.passes()).toBe(true);

    const missing = new Validator({ id: "nope" }, {}, { id: rule().exists(Widget) });
    expect(await missing.passes()).toBe(false);
    expect(missing.errors().id).toBeTruthy();
  });

  it("unique() fails for a taken value and passes for a new one", async () => {
    const taken = new Validator({ name: "Sprocket" }, {}, { name: rule().unique(Widget, "name") });
    expect(await taken.passes()).toBe(false);

    const free = new Validator({ name: "Cog" }, {}, { name: rule().unique(Widget, "name") });
    expect(await free.passes()).toBe(true);
  });

  it("unique().ignore() skips the current row", async () => {
    const self = new Validator(
      { name: "Sprocket" },
      {},
      {
        name: rule().unique(Widget, "name").ignore("1"),
      },
    );
    expect(await self.passes()).toBe(true);

    await Widget.create({ id: "2", name: "Cog", active: 1 });
    const other = new Validator(
      { name: "Cog" },
      {},
      {
        name: rule().unique(Widget, "name").ignore("1"),
      },
    );
    expect(await other.passes()).toBe(false);
  });
});

describe("exists / unique inside a transaction", () => {
  let app: Application;
  let manager: DatabaseManager;

  beforeEach(async () => {
    app = new Application();
    manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
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

    registerValidationPresenceResolver();
  });

  afterEach(() => {
    Rule.setPresenceResolver(undefined);
    clearCurrentApp();
  });

  /**
   * The rules resolve their connection per call, so they see the
   * enclosing transaction's uncommitted writes. Reading the root
   * connection instead would validate against pre-transaction state and
   * wave through a duplicate the same transaction had just written.
   */
  it("sees a row written by the enclosing transaction", async () => {
    await transaction(manager.driver().kysely, async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: 1 });

      const taken = new Validator(
        { name: "Sprocket" },
        {},
        { name: rule().unique(Widget, "name") },
      );
      expect(await taken.passes()).toBe(false);

      const found = new Validator({ id: "1" }, {}, { id: rule().exists(Widget) });
      expect(await found.passes()).toBe(true);
    });
  });

  it("does not see a row the transaction rolled back", async () => {
    await expect(
      transaction(manager.driver().kysely, async () => {
        await Widget.create({ id: "1", name: "Sprocket", active: 1 });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    const free = new Validator({ name: "Sprocket" }, {}, { name: rule().unique(Widget, "name") });
    expect(await free.passes()).toBe(true);
  });
});
