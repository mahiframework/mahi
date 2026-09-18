import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { DB } from "../src/db-facade.js";
import { normalizeBinding } from "../src/bindings.js";

/**
 * Binding normalisation. The layer that lets a caller pass a
 * `DateTime`, a `Date`, a `bigint` or a model instance straight into a
 * query, instead of serialising it by hand at the call site.
 *
 * The distinction from `builder-casts.test.ts` matters: that file covers
 * `EloquentBuilder`'s *cast* layer, which only fires for a column the
 * model **declares** a cast for. This covers normalisation, which is
 * unconditional. It applies to an undeclared column, to a model with no
 * casts at all, and to a bare `DB.table()` query that has no model to
 * consult. That gap is the actual bug: `PersonalAccessToken` types
 * `expires_at` as a plain `string` with no cast, so nothing in the cast
 * layer ever looked at it.
 */

interface EventAttributes {
  id: number;
  name: string;
  // Deliberately `string`, with NO cast declared, the PersonalAccessToken
  // shape, and the case the cast layer cannot reach.
  occurred_at: string;
  owner_id: number | null;
}

class Event extends Model<EventAttributes>()({
  table: "events",
  primaryKey: "id",
  timestamps: false,
}) {}

interface OwnerAttributes {
  id: number;
  name: string;
}

class Owner extends Model<OwnerAttributes>()({
  table: "owners",
  primaryKey: "id",
  timestamps: false,
}) {}

/** 03:04:05 UTC, expressed in a +08:00 zone as 11:04:05 the same day. */
const UTC_INSTANT = "2026-01-02T03:04:05.000Z";
const PERTH = DateTime.fromISO(UTC_INSTANT, "UTC").setTimezone("Australia/Perth");

describe("normalizeBinding()", () => {
  it("converts a DateTime to UTC ISO text", () => {
    const utc = DateTime.fromISO(UTC_INSTANT, "UTC");
    expect(normalizeBinding("sqlite", utc)).toBe(UTC_INSTANT);
  });

  it("converts a ZONED DateTime back to UTC rather than keeping its offset", () => {
    // The bug this exists for: `DateTime.toISOString()` renders in the
    // instance's own zone, so an unconverted value would serialise as
    // "2026-01-02T11:04:05.000+08:00" and be stored by SQLite/MySQL as
    // 11:04 UTC, an 8-hour silent shift.
    expect(PERTH.toISOString()).toBe("2026-01-02T11:04:05.000+08:00");
    expect(normalizeBinding("sqlite", PERTH)).toBe(UTC_INSTANT);
  });

  it("spells a DateTime the way MySQL accepts", () => {
    // MySQL rejects the ISO `Z` for a DATETIME column outright.
    expect(normalizeBinding("mysql", PERTH)).toBe("2026-01-02 03:04:05.000");
  });

  it("converts a Date to UTC ISO text", () => {
    expect(normalizeBinding("sqlite", new Date(UTC_INSTANT))).toBe(UTC_INSTANT);
  });

  /**
   * A `bigint` binds as-is. Every driver accepts one, and it is what a
   * 64-bit column reads back as, so `where("id", row.id)` has to make
   * the round trip unchanged — narrowing to a number would round any id
   * past MAX_SAFE_INTEGER into a query for a different row.
   */
  it("passes a bigint through unchanged", () => {
    expect(normalizeBinding("sqlite", 42n)).toBe(42n);
    expect(normalizeBinding("sqlite", 9007199254740993n)).toBe(9007199254740993n);
  });

  it("reduces a model instance to its key", () => {
    const owner = Owner.hydrate({ id: 7, name: "ada" });
    expect(normalizeBinding("sqlite", owner)).toBe(7);
  });

  it("passes scalars through BY IDENTITY so callers can skip allocating", () => {
    const text = "hello";
    expect(normalizeBinding("sqlite", text)).toBe(text);
    expect(normalizeBinding("sqlite", 5)).toBe(5);
    expect(normalizeBinding("sqlite", true)).toBe(true);
    expect(normalizeBinding("sqlite", null)).toBe(null);
  });

  it("is idempotent. A already-normalised value is untouched", () => {
    const once = normalizeBinding("sqlite", PERTH);
    expect(normalizeBinding("sqlite", once)).toBe(once);
  });

  it("leaves plain objects and arrays alone", () => {
    // Silently JSON-ifying these would let a mistyped value land in the
    // column instead of failing loudly; JSON columns use Cast.json().
    const obj = { a: 1 };
    const arr = [1, 2];
    expect(normalizeBinding("sqlite", obj)).toBe(obj);
    expect(normalizeBinding("sqlite", arr)).toBe(arr);
  });
});

describe("query builder normalises its bindings", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const schema = manager.driver().kysely.schema;

    await schema
      .createTable("events")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("occurred_at", "text")
      .addColumn("owner_id", "integer")
      .execute();

    await schema
      .createTable("owners")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
  });

  afterEach(() => clearCurrentApp());

  it("binds a DateTime on an UNCAST column. The case casts cannot reach", () => {
    expect(
      Event.query()
        .where("occurred_at", "<=", PERTH as never)
        .getBindings(),
    ).toEqual([UTC_INSTANT]);
  });

  it("binds a DateTime through a bare DB.table() query, which has no model", () => {
    expect(
      DB.table("events")
        .where("occurred_at", "<=", PERTH as never)
        .getBindings(),
    ).toEqual([UTC_INSTANT]);
  });

  it("binds a model instance as its key", () => {
    const owner = Owner.hydrate({ id: 7, name: "ada" });
    expect(
      Event.query()
        .where("owner_id", owner as never)
        .getBindings(),
    ).toEqual([7]);
  });

  it("normalises whereIn lists and whereBetween bounds", () => {
    const min = DateTime.fromISO("2026-01-01T00:00:00.000Z", "UTC");

    expect(
      Event.query()
        .whereIn("occurred_at", [PERTH, min] as never)
        .getBindings(),
    ).toEqual([UTC_INSTANT, "2026-01-01T00:00:00.000Z"]);

    expect(
      Event.query()
        .whereBetween("occurred_at", min as never, PERTH as never)
        .getBindings(),
    ).toEqual(["2026-01-01T00:00:00.000Z", UTC_INSTANT]);
  });

  it("normalises raw bindings and having values", () => {
    expect(Event.query().whereRaw("occurred_at <= ?", [PERTH]).getBindings()).toEqual([
      UTC_INSTANT,
    ]);

    expect(Event.query().groupBy("name").having("occurred_at", "<=", PERTH).getBindings()).toEqual([
      UTC_INSTANT,
    ]);
  });

  it("round-trips a DateTime written through insert() and matched by where()", async () => {
    await Event.query().insert({ name: "launch", occurred_at: PERTH } as never);

    const row = await Event.query().where("name", "launch").first();
    expect(row?.occurred_at).toBe(UTC_INSTANT);

    // And the value is findable by the same DateTime that wrote it.
    const found = await Event.query()
      .where("occurred_at", PERTH as never)
      .first();
    expect(found?.name).toBe("launch");
  });

  it("normalises an update() payload", async () => {
    await Event.query().insert({ name: "launch", occurred_at: UTC_INSTANT } as never);
    await Event.query()
      .where("name", "launch")
      .update({ occurred_at: PERTH } as never);

    const row = await Event.query().where("name", "launch").first();
    expect(row?.occurred_at).toBe(UTC_INSTANT);
  });

  it("compares whereDate against the UTC calendar date, not the local one", () => {
    // 2026-01-02T23:30Z is already 2026-01-03 in Perth. The column stores
    // UTC, so the extracted date must be the 2nd.
    const lateUtc = DateTime.fromISO("2026-01-02T23:30:00.000Z", "UTC").setTimezone(
      "Australia/Perth",
    );
    expect(lateUtc.format("yyyy-MM-dd")).toBe("2026-01-03");

    // SQLite extracts via `strftime('%Y-%m-%d', col)`, so the grammar
    // contributes the format string as a binding of its own; the
    // comparand is the last one.
    const bindings = Event.query().whereDate("occurred_at", lateUtc).getBindings();
    expect(bindings.at(-1)).toBe("2026-01-02");
  });

  it("still binds a plain ISO string unchanged", () => {
    expect(Event.query().where("occurred_at", "<=", UTC_INSTANT).getBindings()).toEqual([
      UTC_INSTANT,
    ]);
  });
});
