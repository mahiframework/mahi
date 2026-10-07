import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { uuidv7, type KeyStrategy } from "../src/key-strategy.js";

interface AutoWidgetAttributes {
  id: number;
  name: string;
}

interface UuidWidgetAttributes {
  id: string;
  name: string;
}

// keyType: "increment" (the default), DB-generated integer key.
class AutoWidget extends Model<AutoWidgetAttributes>()({
  table: "auto_widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

// keyType: "uuid", client-generated string key, filled before insert.
class UuidWidget extends Model<UuidWidgetAttributes>()({
  table: "uuid_widgets",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {}

// keyType: "uuidv7", the time-ordered string form.
class Uuidv7Widget extends Model<UuidWidgetAttributes>()({
  table: "uuid_widgets",
  primaryKey: "id",
  keyType: "uuidv7",
  timestamps: false,
}) {}

// The same strategy supplied as an object rather than a name.
class Uuidv7ObjectWidget extends Model<UuidWidgetAttributes>()({
  table: "uuid_widgets",
  primaryKey: "id",
  keyType: uuidv7(),
  timestamps: false,
}) {}

describe("key strategies (keyType)", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("auto_widgets")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await manager
      .driver()
      .kysely.schema.createTable("uuid_widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it('keyType "increment" (default): create() returns the row with the DB-generated PK merged in', async () => {
    const created = await AutoWidget.create({ name: "Sprocket" });

    // A rowid alias is 64-bit, and so reads back as a `bigint` — the
    // same type `bigserial`/`BIGINT AUTO_INCREMENT` yield elsewhere.
    expect(typeof created.id).toBe("bigint");
    expect(created.id).toBeGreaterThan(0);

    const found = await AutoWidget.find(created.id);
    expect(found).toMatchObject({ name: "Sprocket" });
  });

  it('keyType "increment": successive create() calls get increasing generated ids', async () => {
    const first = await AutoWidget.create({ name: "Sprocket" });
    const second = await AutoWidget.create({ name: "Cog" });

    expect(second.id).toBeGreaterThan(first.id);
  });

  it('keyType "uuid": caller-supplied PK passes through unchanged', async () => {
    const created = await UuidWidget.create({ id: "custom-id", name: "Sprocket" });

    expect(created.id).toBe("custom-id");
    const found = await UuidWidget.find("custom-id");
    expect(found).toMatchObject({ name: "Sprocket" });
  });

  it('keyType "uuid": a missing PK is filled with a random UUID before insert', async () => {
    const created = await UuidWidget.create({ name: "Sprocket" });

    expect(typeof created.id).toBe("string");
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await UuidWidget.find(created.id)).toMatchObject({ name: "Sprocket" });
  });

  it('keyType "uuidv7": a missing PK is filled with a v7 UUID before insert', async () => {
    const created = await Uuidv7Widget.create({ name: "Sprocket" });

    expect(typeof created.id).toBe("string");
    // Version nibble is 7, and the variant is RFC 4122.
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await Uuidv7Widget.find(created.id)).toMatchObject({ name: "Sprocket" });
  });

  it('keyType "uuidv7": ids are time-ordered, so they sort chronologically', async () => {
    const first = await Uuidv7Widget.create({ name: "a" });
    // Cross a millisecond boundary: within one ms v7 ordering is
    // arbitrary by design (the tail is entropy).
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await Uuidv7Widget.create({ name: "b" });

    expect(second.id > first.id).toBe(true);
  });

  it("keyType uuidv7() object form behaves identically to the name", async () => {
    const created = await Uuidv7ObjectWidget.create({ name: "Sprocket" });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keyType "uuidv7": caller-supplied PK passes through unchanged', async () => {
    const created = await Uuidv7Widget.create({ id: "explicit-id", name: "Sprocket" });

    expect(created.id).toBe("explicit-id");
  });

  it("a custom KeyStrategy fills a missing PK from its generate() (given the model name)", async () => {
    const fixed: KeyStrategy<string> = {
      type: "string",
      generate: (context) => `generated-${context.modelName}`,
    };

    class GeneratedWidget extends Model<UuidWidgetAttributes>()({
      table: "uuid_widgets",
      primaryKey: "id",
      keyType: fixed,
      timestamps: false,
    }) {}

    const created = await GeneratedWidget.create({ name: "Sprocket" });
    expect(created.id).toBe("generated-GeneratedWidget");
    expect(await GeneratedWidget.find("generated-GeneratedWidget")).toMatchObject({
      name: "Sprocket",
    });
  });
});
