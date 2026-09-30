/**
 * Provisioning a throwaway database for `createTestApplication()`, so an
 * application's feature tests can run against the engine it actually
 * deploys on rather than always SQLite.
 *
 * ## Why this duplicates the database package's harness
 *
 * `framework/database/tests/support/drivers.ts` does the same job for
 * the framework's own cross-dialect suite, and this is a deliberate
 * near-copy of it rather than a shared module. `@mahiframework/testing`
 * depends on `@mahiframework/database`, so the database package cannot
 * import from here, and turbo's `dependsOn: ["^build"]` makes the
 * reverse direction a build cycle. Moving the shared parts into the
 * database package's published surface would mean shipping test-harness
 * code to every application. A copy in each package is the cheaper of
 * the two, but the two should be kept in step.
 */

import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import {
  MysqlDriver,
  PostgresDriver,
  type DatabaseDriver,
  type MysqlConnectionConfig,
  type PostgresConnectionConfig,
} from "@mahiframework/database";

/** The engines `createTestApplication()` can boot an application against. */
export type TestDatabaseEngine = "sqlite" | "mysql" | "postgres";

export interface TestDatabaseOptions {
  engine: TestDatabaseEngine;

  /**
   * Prefixed onto the scratch database name, purely so a leftover from a
   * crashed run is recognisable (`mahi_test_app_checkout_a1b2c3d4`).
   * A random suffix is always appended regardless, so this never has to
   * be unique and omitting it cannot cause two test files to collide.
   */
  label?: string;

  /**
   * Which connection in the application's own `config/database.ts` to
   * select, written to `DB_CONNECTION`.
   *
   * Defaults to the names the scaffolded template uses: `sqlite`,
   * `mysql`, and `pgsql` for Postgres. An application that names its
   * connections differently passes the name it uses.
   */
  connectionName?: string;
}

/**
 * Where the MySQL/Postgres test servers live. The same variables the
 * framework's own cross-dialect suite reads, so `docker-compose.yml` and
 * CI provision them once for both.
 *
 * The `MAHI_TEST_` prefix is not decoration. Bare `PGHOST`/`PGDATABASE`
 * are libpq's own namespace and `node-postgres` falls back to them for
 * any field a config omits, so a developer with `psql` variables exported
 * would silently redirect the harness. `DB_*` is equally unusable here:
 * those belong to the application under test and this module *writes*
 * them (see `connectionEnv`), so reading its own configuration from
 * them would mean reading back the values it just set.
 *
 * Read on every call rather than once at import, so a value set in a
 * setup file or `beforeAll` after this module loaded still applies.
 */
function mysqlServer(): MysqlConnectionConfig {
  return {
    host: process.env.MAHI_TEST_MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MAHI_TEST_MYSQL_PORT ?? 3306),
    database: process.env.MAHI_TEST_MYSQL_DATABASE ?? "mahi_test",
    username: process.env.MAHI_TEST_MYSQL_USER ?? "root",
    password: process.env.MAHI_TEST_MYSQL_PASSWORD ?? "mysql",
  };
}

function postgresServer(): PostgresConnectionConfig {
  return {
    host: process.env.MAHI_TEST_PGHOST ?? "127.0.0.1",
    port: Number(process.env.MAHI_TEST_PGPORT ?? 5432),
    database: process.env.MAHI_TEST_PGDATABASE ?? "mahi_test",
    username: process.env.MAHI_TEST_PGUSER ?? "postgres",
    password: process.env.MAHI_TEST_PGPASSWORD ?? "postgres",
  };
}

const CONNECTION_NAMES: Record<TestDatabaseEngine, string> = {
  sqlite: "sqlite",
  mysql: "mysql",
  // The scaffolded template calls the Postgres connection `pgsql` (the
  // driver is `postgres`), matching Laravel.
  postgres: "pgsql",
};

const ENGINES: readonly TestDatabaseEngine[] = ["sqlite", "mysql", "postgres"];

/** Whether this engine needs a server that may not be running. */
export function isExternalEngine(engine: TestDatabaseEngine): boolean {
  return engine !== "sqlite";
}

/**
 * Which engine to run against: the explicit option wins, then
 * `MAHI_TEST_ENGINE`, then SQLite.
 *
 * The env var exists so an application can run its *whole* existing
 * suite against Postgres (`MAHI_TEST_ENGINE=postgres vitest run`)
 * without editing a single test file, which is the difference between
 * "we could test on Postgres" and "we do".
 *
 * An unrecognised value throws rather than falling back. A typo'd
 * `MAHI_TEST_ENGINE=postgress` that quietly ran SQLite would report a
 * green Postgres run having tested nothing, which is the exact failure
 * this module exists to remove.
 */
export function resolveTestEngine(
  option: TestDatabaseEngine | TestDatabaseOptions | undefined,
): TestDatabaseOptions {
  if (typeof option === "string") {
    return { engine: assertEngine(option, "the `database` option") };
  }

  if (option) {
    return { ...option, engine: assertEngine(option.engine, "the `database` option") };
  }

  const fromEnv = process.env.MAHI_TEST_ENGINE;

  if (fromEnv !== undefined && fromEnv !== "") {
    return { engine: assertEngine(fromEnv, "MAHI_TEST_ENGINE") };
  }

  return { engine: "sqlite" };
}

function assertEngine(value: string, source: string): TestDatabaseEngine {
  if ((ENGINES as readonly string[]).includes(value)) {
    return value as TestDatabaseEngine;
  }

  throw new Error(
    `Unknown test database engine "${value}" (from ${source}). Expected one of: ${ENGINES.join(", ")}.`,
  );
}

/** A driver for `engine`, optionally pointed at a non-default database. */
function makeDriver(engine: TestDatabaseEngine, database?: string): DatabaseDriver {
  if (engine === "mysql") {
    return new MysqlDriver({ ...mysqlServer(), ...(database ? { database } : {}) });
  }

  return new PostgresDriver({ ...postgresServer(), ...(database ? { database } : {}) });
}

/**
 * `mahi_test_app_<label>_<random>`, sanitised to the identifier
 * characters both engines accept and truncated to MySQL's 64-character
 * limit.
 *
 * Random rather than derived from the test file: `createTestApplication()`
 * cannot see its caller's filename, one file may call it more than once,
 * and two files sharing a name would silently share a database — exactly
 * the cross-talk the per-call database exists to prevent. The cost is
 * that a crashed run leaves a database behind rather than reusing it
 * next time, which the shared `mahi_test_app_` prefix makes easy to spot
 * and sweep.
 */
function scratchDatabaseName(label: string | undefined): string {
  const slug = (label ?? "").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const suffix = randomBytes(4).toString("hex");
  const stem = slug ? `mahi_test_app_${slug}` : "mahi_test_app";

  // Trim the stem, not the suffix: the random part is what guarantees
  // uniqueness, so it must survive the 64-character limit intact.
  return `${stem.slice(0, 64 - suffix.length - 1)}_${suffix}`;
}

function quoteIdentifier(engine: TestDatabaseEngine, name: string): string {
  return engine === "mysql" ? `\`${name}\`` : `"${name}"`;
}

/**
 * Create the throwaway database this test application will own, and
 * return its name. A no-op returning `undefined` for SQLite, which gets
 * a temp file instead.
 */
export async function createScratchDatabase(
  engine: TestDatabaseEngine,
  label?: string,
): Promise<string | undefined> {
  if (!isExternalEngine(engine)) {
    return undefined;
  }

  const name = scratchDatabaseName(label);
  // Connect to the default database purely to issue the CREATE.
  const admin = makeDriver(engine);

  try {
    await admin.connect?.();
    // Postgres has no `CREATE DATABASE IF NOT EXISTS` (it is a syntax
    // error, 42601), so only MySQL gets the guard and Postgres relies on
    // catching "already exists" below.
    const ifNotExists = engine === "mysql" ? "if not exists " : "";
    await sql
      .raw(`create database ${ifNotExists}${quoteIdentifier(engine, name)}`)
      .execute(admin.kysely);
  } catch (error) {
    // 42P04 / "already exists". Astronomically unlikely given the random
    // suffix, but a collision must not be reported as a connection
    // failure.
    if (!/already exists|42P04/i.test((error as Error).message)) {
      throw error;
    }
  } finally {
    await admin.disconnect?.().catch(() => {});
  }

  return name;
}

/**
 * Drop a database created by `createScratchDatabase()`.
 *
 * Swallows every error by design. A leftover scratch database is
 * harmless — it is uniquely named and nothing will reuse it — whereas a
 * throwing teardown turns one failed test into a failed suite and buries
 * the real result. The framework's own harness swallows for the same
 * reason.
 *
 * ⚠️ Must run *after* the application has terminated. Postgres refuses
 * to drop a database while any session is connected to it, and it is
 * `app.terminate()` (via the database provider's `shutdown()`) that
 * closes the pool.
 */
export async function dropScratchDatabase(
  engine: TestDatabaseEngine,
  name: string | undefined,
): Promise<void> {
  if (!isExternalEngine(engine) || !name) {
    return;
  }

  const admin = makeDriver(engine);

  try {
    await admin.connect?.();
    await sql.raw(`drop database if exists ${quoteIdentifier(engine, name)}`).execute(admin.kysely);
  } catch {
    // Deliberately ignored. See the docstring.
  } finally {
    await admin.disconnect?.().catch(() => {});
  }
}

/**
 * The `DB_*` environment variables pointing an application's own
 * `config/database.ts` at `database` on this engine.
 *
 * Returned rather than applied so the caller can snapshot the keys
 * before overwriting them. Empty for SQLite, which is configured through
 * `DB_FILENAME` instead.
 */
export function connectionEnv(
  options: TestDatabaseOptions,
  database: string,
): Record<string, string> {
  const server = options.engine === "mysql" ? mysqlServer() : postgresServer();

  return {
    DB_CONNECTION: options.connectionName ?? CONNECTION_NAMES[options.engine],
    DB_HOST: server.host ?? "127.0.0.1",
    DB_PORT: String(server.port),
    DB_DATABASE: database,
    DB_USERNAME: server.username ?? "",
    DB_PASSWORD: server.password ?? "",
  };
}

/** The `DB_CONNECTION` value for an engine, for the SQLite case. */
export function connectionNameFor(options: TestDatabaseOptions): string {
  return options.connectionName ?? CONNECTION_NAMES[options.engine];
}

/**
 * Whether `engine` can be reached right now, for gating a suite:
 *
 *   const suite = (await testEngineAvailable("postgres")) ? describe : describe.skip;
 *
 * SQLite always can. For the two server engines this opens a real
 * connection and throws it away, so a developer without docker running
 * gets the suite skipped rather than a wall of connection errors.
 *
 * **Except under `CI_STRICT_MODE=true`**, where the services are
 * provisioned and an unreachable database means the harness is
 * misconfigured. Silently skipping there would turn the whole
 * cross-engine suite into a no-op that still reports green.
 *
 * Deliberately NOT keyed off `CI`: GitHub Actions sets `CI=true` on
 * every runner, so the service-free job would fail on the very suites it
 * is meant to skip. The opt-in has to be something only the job that
 * starts the services sets.
 */
export async function testEngineAvailable(engine: TestDatabaseEngine): Promise<boolean> {
  if (!isExternalEngine(engine)) {
    return true;
  }

  let driver: DatabaseDriver | undefined;

  try {
    driver = makeDriver(engine);
    await driver.connect?.();

    return true;
  } catch (error) {
    if (process.env.CI_STRICT_MODE === "true") {
      throw new Error(
        `${engine} is unreachable and CI_STRICT_MODE=true, so the suite cannot be skipped. ` +
          `Original error: ${(error as Error).message}`,
      );
    }

    return false;
  } finally {
    await driver?.disconnect?.().catch(() => {});
  }
}
