import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../../src/database-manager.js";
import { DATABASE_TOKEN } from "../../src/database-service-provider.js";
import { Model } from "../../src/model.js";
import {
  cursorPaginate,
  type CursorPaginateOptions,
} from "../../src/pagination/cursor-paginator.js";

interface WidgetAttributes {
  id: string;
  name: string;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("cursorPaginate()", () => {
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
      .execute();

    for (let i = 1; i <= 10; i++) {
      const id = String(i).padStart(2, "0");
      await Widget.create({ id, name: `Widget ${id}` });
    }
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("walking nextCursor forward visits every row exactly once with no gaps/dupes", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let i = 0; i < 10; i++) {
      // The options are annotated to break an inference cycle: `cursor` is
      // assigned from `page.nextCursor` at the bottom of the loop, so
      // inferring `page` from a call whose argument mentions `cursor` makes
      // `page` depend on itself (TS7022). Annotating the options object
      // removes it as an inference source. Not specific to this API, the
      // same loop shape reproduces with any generic function.
      const options: CursorPaginateOptions<WidgetAttributes, "id"> = {
        column: "id",
        perPage: 3,
        cursor,
      };
      const page = await cursorPaginate(Widget.query(), options);
      seen.push(...page.data.toArray().map((r) => r.id));

      if (page.nextCursor === null) {
        break;
      }

      cursor = page.nextCursor;
    }

    expect(seen).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]);
  });

  it("nextCursor is null and hasMore-equivalent on the last page", async () => {
    const page1 = await cursorPaginate(Widget.query(), { column: "id", perPage: 7 });
    expect(page1.data.toArray()).toHaveLength(7);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await cursorPaginate(Widget.query(), {
      column: "id",
      perPage: 7,
      cursor: page1.nextCursor,
    });
    expect(page2.data.toArray()).toHaveLength(3);
    expect(page2.nextCursor).toBeNull();
  });

  it("prevCursor is null on the first page", async () => {
    const page1 = await cursorPaginate(Widget.query(), { column: "id", perPage: 3 });
    expect(page1.prevCursor).toBeNull();
  });

  it("prevCursor walks backward correctly, landing back on the previous page's rows", async () => {
    const page1 = await cursorPaginate(Widget.query(), { column: "id", perPage: 3 });
    const page2 = await cursorPaginate(Widget.query(), {
      column: "id",
      perPage: 3,
      cursor: page1.nextCursor,
    });
    expect(page2.data.toArray().map((r) => r.id)).toEqual(["04", "05", "06"]);
    expect(page2.prevCursor).not.toBeNull();

    const backToPage1 = await cursorPaginate(Widget.query(), {
      column: "id",
      perPage: 3,
      cursor: page2.prevCursor,
    });
    expect(backToPage1.data.toArray().map((r) => r.id)).toEqual(["01", "02", "03"]);
  });

  it("a row inserted BEFORE the cursor boundary doesn't cause a skip/dupe for the next page (the actual value-add over offset pagination)", async () => {
    const page1 = await cursorPaginate(Widget.query(), { column: "id", perPage: 3 });
    expect(page1.data.toArray().map((r) => r.id)).toEqual(["01", "02", "03"]);

    // Insert a row that would land ON page 1 under offset pagination
    // (lexically between "01" and "02"), shifting every subsequent
    // offset-based page by one. Cursor pagination is immune: it filters
    // by "> 03" (the last-seen id), which "015" doesn't satisfy, so it
    // simply never appears in page 2, no skip, no dupe, for rows that
    // were already fetched or would be fetched next.
    await Widget.create({ id: "015", name: "Inserted" });

    const page2 = await cursorPaginate(Widget.query(), {
      column: "id",
      perPage: 3,
      cursor: page1.nextCursor,
    });
    expect(page2.data.toArray().map((r) => r.id)).toEqual(["04", "05", "06"]);
  });

  it("supports descending direction", async () => {
    const page = await cursorPaginate(Widget.query(), {
      column: "id",
      perPage: 3,
      direction: "desc",
    });
    expect(page.data.toArray().map((r) => r.id)).toEqual(["10", "09", "08"]);
  });

  it("Model.cursorPaginate() convenience method works end-to-end", async () => {
    const page = await Widget.cursorPaginate({ column: "id", perPage: 4 });
    expect(page.data.toArray()).toHaveLength(4);
    expect(page.nextCursor).not.toBeNull();
  });

  /**
   * The cursor column is usually the primary key, which is 64-bit and so
   * reads back as a `bigint`. `JSON.stringify` throws on one, so before
   * the cursor tagged it this was a 500 on the *first* page of any
   * endpoint paginating by id — the most common case there is.
   */
  describe("64-bit cursor columns", () => {
    interface ThingAttributes {
      id: bigint;
      name: string;
    }

    class Thing extends Model<ThingAttributes>()({
      table: "things",
      primaryKey: "id",
      timestamps: false,
    }) {}

    beforeEach(async () => {
      const manager = app.make<DatabaseManager>(DATABASE_TOKEN);

      await manager
        .driver()
        .kysely.schema.createTable("things")
        .addColumn("id", "bigint", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();

      // Past Number.MAX_SAFE_INTEGER, so a round trip through a double
      // would land on a different row.
      for (let i = 0n; i < 4n; i++) {
        await Thing.create({ id: 9007199254740993n + i, name: `Thing ${i}` });
      }
    });

    it("paginates by a bigint column without throwing on encode", async () => {
      const first = await cursorPaginate(Thing.query(), { column: "id", perPage: 2 });

      expect(first.data.toArray().map((r) => r.id)).toEqual([9007199254740993n, 9007199254740994n]);
      expect(first.nextCursor).not.toBeNull();

      const second = await cursorPaginate(Thing.query(), {
        column: "id",
        perPage: 2,
        cursor: first.nextCursor!,
      });

      // The exact next rows: a cursor narrowed to a double would have
      // resumed from ...992 and repeated a row.
      expect(second.data.toArray().map((r) => r.id)).toEqual([
        9007199254740995n,
        9007199254740996n,
      ]);
    });

    it("walks back to the first page through a bigint cursor", async () => {
      const first = await cursorPaginate(Thing.query(), { column: "id", perPage: 2 });
      const second = await cursorPaginate(Thing.query(), {
        column: "id",
        perPage: 2,
        cursor: first.nextCursor!,
      });
      const back = await cursorPaginate(Thing.query(), {
        column: "id",
        perPage: 2,
        cursor: second.prevCursor!,
      });

      expect(back.data.toArray().map((r) => r.id)).toEqual([9007199254740993n, 9007199254740994n]);
    });
  });

  /**
   * Cursors come straight off a query string, so every one of these is
   * reachable by anyone typing a URL. None may throw: an unparseable
   * cursor that let a `SyntaxError` out of `JSON.parse()` escape would
   * surface as a 500 on every paginated endpoint.
   */
  describe("malformed cursors are ignored rather than throwing", () => {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");

    it.each([
      ["not base64/JSON at all", "garbage"],
      ["base64 of non-JSON", Buffer.from("not json").toString("base64url")],
      ["punctuation", "!!!!"],
      ["whitespace", " "],
      ["a JSON array", encode([])],
      ["a JSON string", encode("just-a-string")],
      ["a JSON number", encode(42)],
      ["an object with no op", encode({ value: "05" })],
      ["an object with an unknown op", encode({ value: "05", op: "sideways" })],
      ["an object with no value", encode({ op: "after" })],
      ["a null value", encode({ value: null, op: "after" })],
      ["an object value", encode({ value: { nested: true }, op: "after" })],
      ["an array value", encode({ value: ["05"], op: "after" })],
    ])("treats %s as no cursor and returns the first page", async (_label, cursor) => {
      const page = await cursorPaginate(Widget.query(), { column: "id", perPage: 3, cursor });

      // Identical to passing no cursor at all, NOT an empty page, which
      // is what a client would otherwise be told the list contains.
      expect(page.data.toArray().map((r) => r.id)).toEqual(["01", "02", "03"]);
    });

    it("still honours a well-formed cursor", async () => {
      const page = await cursorPaginate(Widget.query(), {
        column: "id",
        perPage: 3,
        cursor: encode({ value: "03", op: "after" }),
      });

      expect(page.data.toArray().map((r) => r.id)).toEqual(["04", "05", "06"]);
    });
  });

  /**
   * `perPage` is equally client-supplied. The paginator clamps only the
   * LOWER bound, a maximum page size is an application policy, so
   * callers cap it themselves (see the app's `perPageFrom()`).
   */
  describe("perPage lower bound", () => {
    it.each([
      ["zero", 0],
      ["negative", -5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("treats a %s perPage as 1 rather than returning an empty page", async (_label, perPage) => {
      const page = await cursorPaginate(Widget.query(), { column: "id", perPage });

      expect(page.data.toArray().map((r) => r.id)).toEqual(["01"]);
      expect(page.nextCursor).not.toBeNull();
    });

    it("floors a fractional perPage", async () => {
      const page = await cursorPaginate(Widget.query(), { column: "id", perPage: 2.9 });
      expect(page.data.toArray()).toHaveLength(2);
    });

    it("does NOT impose an upper bound. That is the caller's policy", async () => {
      const page = await cursorPaginate(Widget.query(), { column: "id", perPage: 1000 });

      expect(page.data.toArray()).toHaveLength(10);
      expect(page.nextCursor).toBeNull();
    });
  });
});
