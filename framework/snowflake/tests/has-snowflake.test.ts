import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DatabaseManager,
  DATABASE_TOKEN,
  Factory,
  Model,
  SqliteDriver,
} from "@mahiframework/database";
import { snowflake } from "../src/has-snowflake.js";
import { Snowflake } from "../src/snowflake.js";
import { SnowflakeServiceProvider } from "../src/snowflake-service-provider.js";

interface WidgetAttributes {
  id: bigint;
  name: string;
}

type WidgetTable = WidgetAttributes;

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  // The snowflake `KeyStrategy` assigns a 64-bit id on create when one
  // is missing (per-model sequence group = the class name).
  keyType: snowflake(),
  // This fixture is about the snowflake PRIMARY KEY, not timestamps, and
  // its table below has no created_at/updated_at columns, `Model
  // .timestamps` defaults to true, so opt out explicitly rather than
  // widening the fixture schema for columns nothing here asserts on.
  timestamps: false,
}) {}

class WidgetFactory extends Factory<typeof Widget> {
  protected model = Widget;

  protected definition(): WidgetTable {
    return { name: "Sprocket" } as WidgetTable;
  }
}

describe("HasSnowflake", () => {
  beforeEach(async () => {
    Snowflake.reset();
    const app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    // `HasSnowflake.newUniqueId()` resolves SNOWFLAKE_TOKEN out of the
    // container, so the generator has to actually be registered. The
    // extension is not self-binding. `register()` only queues the
    // provider; `bootstrap()` is what runs its register()/boot().
    app.register(SnowflakeServiceProvider);
    await app.bootstrap();
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("widgets")
      .addColumn("id", "bigint", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
    Snowflake.reset();
  });

  it("assigns a snowflake id on create when id is missing", async () => {
    const row = await Widget.create({ name: "Sprocket" } as WidgetTable);
    expect(typeof row.id).toBe("bigint");
    expect(String(row.id)).toMatch(/^\d{17,19}$/);
    expect(row.name).toBe("Sprocket");

    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ name: "Sprocket" });
  });

  it("leaves an explicit id alone", async () => {
    const row = await Widget.create({ id: 4242n, name: "Cog" });
    expect(row.id).toBe(4242n);
  });

  it("sets incrementing to false so the DB is not asked for an insertId", async () => {
    await Widget.create({ name: "Sprocket" } as WidgetTable);
    expect(Widget.incrementing).toBe(false);
  });

  it("Factory.create() fills missing ids the same way", async () => {
    const [row] = await new WidgetFactory().create();
    expect(String(row!.id)).toMatch(/^\d{17,19}$/);
  });

  it("the snowflake() strategy's generate() returns a 64-bit id", async () => {
    const id = await snowflake().generate({ modelName: "Widget" });
    expect(typeof id).toBe("bigint");
    expect(String(id)).toMatch(/^\d{17,19}$/);
  });
});
