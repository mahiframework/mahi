import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahiframework/core";
import {
  DatabaseServiceProvider,
  DatabaseManager,
  DATABASE_TOKEN,
  Model,
  MysqlDriver,
  PostgresDriver,
} from "@mahiframework/database";
import { createTestApplication } from "../src/create-test-application.js";
import { testEngineAvailable, type TestDatabaseEngine } from "../src/test-database.js";
import { assertDatabaseHas } from "../src/database-assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = path.join(__dirname, "__fixtures__/migrations");

interface WidgetAttributes {
  id: string;
  name: string;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

class WidgetsProvider extends ServiceProvider {
  migrations(): string {
    return FIXTURE_MIGRATIONS_DIR;
  }
}

/**
 * A fixture app configured the way the scaffolded template is: three
 * named connections, all fed from the `DB_*` environment.
 * `createTestApplication()` writes those before this runs, so selecting
 * an engine needs no test-specific configuration here — which is the
 * whole mechanism under test.
 */
async function bootstrapFixtureApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: process.env.DB_CONNECTION ?? "sqlite",
    connections: {
      sqlite: { driver: "sqlite", filename: process.env.DB_FILENAME },
      mysql: {
        driver: "mysql",
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 3306),
        database: process.env.DB_DATABASE,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
      },
      pgsql: {
        driver: "postgres",
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_DATABASE,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
      },
    },
  });

  app.register(DatabaseServiceProvider);
  app.register(WidgetsProvider);

  await app.bootstrap();

  return app;
}

/** An admin connection to the engine's default database, for asserting on scratch databases. */
function adminDriver(engine: TestDatabaseEngine) {
  if (engine === "mysql") {
    return new MysqlDriver({
      host: process.env.MAHI_TEST_MYSQL_HOST ?? "127.0.0.1",
      port: Number(process.env.MAHI_TEST_MYSQL_PORT ?? 3306),
      database: process.env.MAHI_TEST_MYSQL_DATABASE ?? "mahi_test",
      username: process.env.MAHI_TEST_MYSQL_USER ?? "root",
      password: process.env.MAHI_TEST_MYSQL_PASSWORD ?? "mysql",
    });
  }

  return new PostgresDriver({
    host: process.env.MAHI_TEST_PGHOST ?? "127.0.0.1",
    port: Number(process.env.MAHI_TEST_PGPORT ?? 5432),
    database: process.env.MAHI_TEST_PGDATABASE ?? "mahi_test",
    username: process.env.MAHI_TEST_PGUSER ?? "postgres",
    password: process.env.MAHI_TEST_PGPASSWORD ?? "postgres",
  });
}

async function databaseExists(engine: TestDatabaseEngine, name: string): Promise<boolean> {
  const admin = adminDriver(engine);

  try {
    await admin.connect?.();
    const query =
      engine === "mysql"
        ? sql<{
            name: string;
          }>`select schema_name as name from information_schema.schemata where schema_name = ${name}`
        : sql<{ name: string }>`select datname as name from pg_database where datname = ${name}`;
    const { rows } = await query.execute(admin.kysely);

    return rows.length > 0;
  } finally {
    await admin.disconnect?.().catch(() => {});
  }
}

const ENGINES: readonly TestDatabaseEngine[] = ["sqlite", "mysql", "postgres"];

/**
 * An application booted against each engine in turn.
 *
 * The point is not that `createTestApplication()` works — the SQLite
 * suites cover that — but that an application's own tests can run
 * against the engine it deploys on. A suite that only ever sees SQLite
 * is not testing its own schema: `like` folds case there and not on
 * Postgres, `lock()` is a no-op, there is no type affinity, and partial
 * or GIN indexes cannot be created at all.
 */
for (const engine of ENGINES) {
  const suite = (await testEngineAvailable(engine)) ? describe : describe.skip;

  suite(`createTestApplication({ database: "${engine}" })`, () => {
    afterEach(() => {
      clearCurrentApp();
    });

    it("boots, migrates, inserts and reads", async () => {
      const testApp = await createTestApplication(bootstrapFixtureApp, { database: engine });

      try {
        expect(testApp.app.isBooted()).toBe(true);
        expect(testApp.app.make<DatabaseManager>(DATABASE_TOKEN).driver().dialect).toBe(engine);

        await Widget.create({ id: "w1", name: "Sprocket" });

        await assertDatabaseHas(testApp.app, "widgets", { id: "w1", name: "Sprocket" });
        expect((await Widget.all()).toArray()).toHaveLength(1);
      } finally {
        await testApp.cleanup();
      }
    });

    it("clearDatabase() empties the rows and keeps the schema", async () => {
      const testApp = await createTestApplication(bootstrapFixtureApp, { database: engine });

      try {
        await Widget.create({ id: "w1", name: "Sprocket" });
        expect((await Widget.all()).toArray()).toHaveLength(1);

        await testApp.clearDatabase();

        expect((await Widget.all()).toArray()).toHaveLength(0);
        // The table is still there: a second insert needs no re-migrate.
        await Widget.create({ id: "w2", name: "Cog" });
        expect((await Widget.all()).toArray()).toHaveLength(1);
      } finally {
        await testApp.cleanup();
      }
    });
  });
}

/**
 * The isolation assertion, and the reason for a database per call rather
 * than one shared scratch database.
 *
 * Vitest runs test *files* in parallel, so two suites sharing a database
 * would see each other's rows and each other's teardown. Two applications
 * live at once here is the same condition, deliberately provoked.
 */
for (const engine of ENGINES.filter((e) => e !== "sqlite")) {
  const suite = (await testEngineAvailable(engine)) ? describe : describe.skip;

  suite(`scratch database isolation (${engine})`, () => {
    afterEach(() => {
      clearCurrentApp();
    });

    it("gives two concurrent applications separate databases", async () => {
      const first = await createTestApplication(bootstrapFixtureApp, {
        database: { engine, label: "first" },
      });
      const second = await createTestApplication(bootstrapFixtureApp, {
        database: { engine, label: "second" },
      });

      try {
        const firstDb = first.app.make<DatabaseManager>(DATABASE_TOKEN).driver().kysely;
        const secondDb = second.app.make<DatabaseManager>(DATABASE_TOKEN).driver().kysely;

        await firstDb.insertInto("widgets").values({ id: "a", name: "from first" }).execute();
        await secondDb.insertInto("widgets").values({ id: "b", name: "from second" }).execute();

        const inFirst = await firstDb.selectFrom("widgets").selectAll().execute();
        const inSecond = await secondDb.selectFrom("widgets").selectAll().execute();

        expect(inFirst.map((r: any) => r.id)).toEqual(["a"]);
        expect(inSecond.map((r: any) => r.id)).toEqual(["b"]);
      } finally {
        await second.cleanup();
        await first.cleanup();
      }
    });

    it("cleanup() drops the scratch database", async () => {
      const testApp = await createTestApplication(bootstrapFixtureApp, { database: engine });
      const name = process.env.DB_DATABASE!;

      expect(name).toMatch(/^mahi_test_app/);
      expect(await databaseExists(engine, name)).toBe(true);

      await testApp.cleanup();

      expect(await databaseExists(engine, name)).toBe(false);
    });

    it("cleanup() does not throw when the database is already gone", async () => {
      const testApp = await createTestApplication(bootstrapFixtureApp, { database: engine });
      const name = process.env.DB_DATABASE!;

      // Terminate first so the drop below is not blocked by this app's
      // own open sessions, then remove the database out from under
      // `cleanup()`. A teardown that threw here would turn one failed
      // test into a failed suite.
      await testApp.app.terminate();

      const admin = adminDriver(engine);
      await admin.connect?.();
      const quoted = engine === "mysql" ? `\`${name}\`` : `"${name}"`;
      await sql.raw(`drop database if exists ${quoted}`).execute(admin.kysely);
      await admin.disconnect?.();

      await expect(testApp.cleanup()).resolves.toBeUndefined();
    });

    it("restores the DB_* environment it overwrote", async () => {
      process.env.DB_CONNECTION = "pre-existing";
      process.env.DB_DATABASE = "pre-existing-db";

      try {
        const testApp = await createTestApplication(bootstrapFixtureApp, { database: engine });
        expect(process.env.DB_DATABASE).toMatch(/^mahi_test_app/);
        await testApp.cleanup();

        expect(process.env.DB_CONNECTION).toBe("pre-existing");
        expect(process.env.DB_DATABASE).toBe("pre-existing-db");
      } finally {
        delete process.env.DB_CONNECTION;
        delete process.env.DB_DATABASE;
      }
    });
  });
}
