import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";

/**
 * `get`/`set` declared on a model class, which is what
 * `docs/extending-models/` tells an application to write.
 *
 * Every instance is handed out behind a `Proxy` whose job is to resolve
 * attribute access, and an accessor is the one member kind where the
 * receiver it runs against decides whether it works at all. Run against
 * the bare target it sees no attributes (they live in the state record,
 * not on the instance) and cannot reach a `#private` field (subclass
 * field initialisers run after `super()` has already returned the
 * proxy, so private state is installed ON the proxy). Both failures are
 * silent: a getter reads `undefined`, and a setter writes a shadow own
 * property that dirty tracking never looks at.
 *
 * Methods are covered elsewhere and were always bound to the proxy.
 * These cases exist because an accessor is not a method and the
 * distinction is invisible at the call site — `post.isArchived` and
 * `post.isArchived()` differ by two characters and used to differ by
 * whether the answer was true.
 */
interface ArticleAttributes {
  id: string;
  title: string;
  body: string;
  published: boolean;
  archived_at: string | null;
}

class Article extends Model<ArticleAttributes>()({
  table: "articles",
  primaryKey: "id",
  timestamps: false,
  casts: { published: Cast.boolean() },
}) {
  #revision = 7;

  /** Reads a plain column. */
  get heading(): string {
    return this.title.toUpperCase();
  }

  /** Reads a CAST column, so the cast has to have been applied. */
  get isPublished(): boolean {
    return this.published === true;
  }

  /** The null comparison that silently inverted. */
  get isArchived(): boolean {
    return this.archived_at !== null;
  }

  /** Reads private state, which lives on the proxy. */
  get revision(): number {
    return this.#revision;
  }

  /** Writes a plain column; must route through `setAttribute()`. */
  set renamed(value: string) {
    this.title = value;
  }

  /** Writes a cast column, so the cast-in has to run. */
  set publish(value: boolean) {
    this.published = value;
  }

  /** Writes two columns, the usual reason to declare a setter at all. */
  set slugged(value: string) {
    this.title = value;
    this.body = `body for ${value}`;
  }

  /** No setter, so assigning must not quietly succeed. */
  get readOnly(): string {
    return "fixed";
  }

  /** A method, for the comparison the bug turned on. */
  headingMethod(): string {
    return this.title.toUpperCase();
  }
}

/** A subclass, since the documented pattern is extending a package model. */
class SpecialArticle extends Article {
  get shouted(): string {
    return `${this.title}!`;
  }
}

let app: Application;

beforeEach(async () => {
  app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);
  setCurrentApp(app);

  await manager
    .driver()
    .kysely.schema.createTable("articles")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("published", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("archived_at", "text")
    .execute();
});

afterEach(() => {
  clearCurrentApp();
});

/** A persisted row, read back the way a finder returns one. */
async function seed(overrides: Partial<ArticleAttributes> = {}): Promise<Article> {
  await Article.create({
    id: "a1",
    title: "Hello",
    body: "text",
    published: false,
    archived_at: null,
    ...overrides,
  });

  return (await Article.findOrFail("a1")) as Article;
}

describe("a getter on a model", () => {
  it("reads a plain attribute", async () => {
    const article = await seed();

    expect(article.heading).toBe("HELLO");
  });

  it("agrees with the same logic written as a method", async () => {
    // The whole bug in one assertion: these differ only in being an
    // accessor and a method, and used to disagree.
    const article = await seed();

    expect(article.heading).toBe(article.headingMethod());
  });

  it("reads a cast attribute as its model type", async () => {
    const article = await seed({ published: true });

    expect(article.isPublished).toBe(true);
  });

  it("answers false for a null column, not true", async () => {
    // Reading `undefined` made `!== null` answer true for every row.
    const article = await seed({ archived_at: null });

    expect(article.isArchived).toBe(false);
  });

  it("answers true for a populated column", async () => {
    const article = await seed({ archived_at: "2026-01-01" });

    expect(article.isArchived).toBe(true);
  });

  it("reaches a private field rather than throwing", async () => {
    // Private state is installed on the proxy, because subclass field
    // initialisers run after `super()` returns it.
    const article = await seed();

    expect(article.revision).toBe(7);
  });

  it("works on a newly constructed instance, not only a hydrated one", async () => {
    const article = new Article({
      id: "a2",
      title: "Fresh",
      body: "text",
      published: false,
      archived_at: null,
    });

    expect(article.heading).toBe("FRESH");
  });

  it("works on an instance from a collection read", async () => {
    await seed();

    const first = (await Article.query().get()).first();

    expect(first?.heading).toBe("HELLO");
  });

  it("works when declared on a subclass", async () => {
    await seed();

    expect((await SpecialArticle.findOrFail("a1")).shouted).toBe("Hello!");
  });

  it("sees a later write", async () => {
    const article = await seed();

    article.title = "Changed";

    expect(article.heading).toBe("CHANGED");
  });
});

describe("a setter on a model", () => {
  it("writes through to the attribute", async () => {
    const article = await seed();

    article.renamed = "Changed";

    expect(article.title).toBe("Changed");
  });

  it("marks the model dirty, so the write survives a save", async () => {
    // The write-side half, and the worse one: assigning a shadow own
    // property left `isDirty()` false, so `save()` dropped the change
    // without erroring.
    const article = await seed();

    article.renamed = "Changed";

    expect(article.isDirty()).toBe(true);
    expect(Object.keys(article.getDirty())).toEqual(["title"]);
  });

  it("persists through save", async () => {
    const article = await seed();

    article.renamed = "Persisted";
    await article.save();

    expect((await Article.findOrFail("a1")).title).toBe("Persisted");
  });

  it("applies the cast on the way in", async () => {
    const article = await seed();

    article.publish = true;
    await article.save();

    expect((await Article.findOrFail("a1")).published).toBe(true);
  });

  it("writes every column it touches", async () => {
    const article = await seed();

    article.slugged = "multi";
    await article.save();

    const reloaded = await Article.findOrFail("a1");

    expect([reloaded.title, reloaded.body]).toEqual(["multi", "body for multi"]);
  });

  it("does not become an attribute of its own", async () => {
    // `renamed` is a declared member, so it must not be mistaken for a
    // column and written back on save.
    const article = await seed();

    article.renamed = "Changed";

    expect(Object.keys(article.toObject())).not.toContain("renamed");
  });

  it("refuses an assignment to a getter with no setter", async () => {
    const article = await seed();

    expect(() => {
      (article as unknown as { readOnly: string }).readOnly = "nope";
    }).toThrow(TypeError);
    expect(article.readOnly).toBe("fixed");
  });
});

describe("the rest of the proxy is unaffected", () => {
  it("still resolves plain attributes", async () => {
    const article = await seed();

    expect(article.title).toBe("Hello");
  });

  it("still assigns plain attributes", async () => {
    const article = await seed();

    article.title = "Direct";

    expect(article.isDirty()).toBe(true);
  });

  it("still reaches the class statics through `constructor`", async () => {
    const article = await seed();

    expect((article.constructor as typeof Article).table).toBe("articles");
  });

  it("still binds methods to the proxy", async () => {
    const article = await seed();
    const { headingMethod } = article;

    expect(headingMethod()).toBe("HELLO");
  });

  it("still reports the framework's own accessors", async () => {
    // `wasRecentlyCreated` is a getter on the base class, so it goes
    // through the same path as an app's.
    const created = await Article.create({
      id: "a3",
      title: "New",
      body: "text",
      published: false,
      archived_at: null,
    });

    expect(created.wasRecentlyCreated).toBe(true);
    expect((await Article.findOrFail("a3")).wasRecentlyCreated).toBe(false);
  });
});
