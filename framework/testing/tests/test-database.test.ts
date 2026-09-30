import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTestEngine, testEngineAvailable } from "../src/test-database.js";

/**
 * Engine selection and the skip gate. SQLite-only so this file runs on
 * any machine, including one with no docker.
 */
describe("resolveTestEngine()", () => {
  const ENV_KEYS = ["MAHI_TEST_ENGINE"] as const;
  let snapshot: Array<[string, string | undefined]>;

  beforeEach(() => {
    snapshot = ENV_KEYS.map((key) => [key, process.env[key]]);
    delete process.env.MAHI_TEST_ENGINE;
  });

  afterEach(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("defaults to sqlite", () => {
    expect(resolveTestEngine(undefined)).toEqual({ engine: "sqlite" });
  });

  it("reads MAHI_TEST_ENGINE, so a whole suite can be moved without editing tests", () => {
    process.env.MAHI_TEST_ENGINE = "postgres";

    expect(resolveTestEngine(undefined)).toEqual({ engine: "postgres" });
  });

  it("lets the explicit option win over the environment", () => {
    process.env.MAHI_TEST_ENGINE = "postgres";

    expect(resolveTestEngine("mysql")).toEqual({ engine: "mysql" });
  });

  it("keeps the label and connection name from the object form", () => {
    expect(
      resolveTestEngine({ engine: "mysql", label: "checkout", connectionName: "primary" }),
    ).toEqual({ engine: "mysql", label: "checkout", connectionName: "primary" });
  });

  it("throws on an unrecognised engine rather than falling back to sqlite", () => {
    // A typo that quietly ran SQLite would report a green Postgres run
    // having tested nothing, which is the failure this module exists to
    // remove.
    process.env.MAHI_TEST_ENGINE = "postgress";

    expect(() => resolveTestEngine(undefined)).toThrow(/Unknown test database engine "postgress"/);
    expect(() => resolveTestEngine(undefined)).toThrow(/MAHI_TEST_ENGINE/);
  });

  it("names the option, not the environment, when the option is the bad one", () => {
    expect(() => resolveTestEngine("sqlight" as never)).toThrow(/the `database` option/);
  });
});

describe("testEngineAvailable()", () => {
  const ENV_KEYS = ["CI_STRICT_MODE", "MAHI_TEST_PGPORT"] as const;
  let snapshot: Array<[string, string | undefined]>;

  beforeEach(() => {
    // `pnpm test:integration` sets CI_STRICT_MODE for the whole process,
    // and the harness reads the port on every call, so both have to go
    // back exactly as they were or later tests in this worker change
    // behaviour.
    snapshot = ENV_KEYS.map((key) => [key, process.env[key]]);
  });

  afterEach(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("is always true for sqlite, which needs no server", async () => {
    delete process.env.CI_STRICT_MODE;

    await expect(testEngineAvailable("sqlite")).resolves.toBe(true);
  });

  it("returns false when the server is unreachable", async () => {
    delete process.env.CI_STRICT_MODE;

    await expect(unreachablePostgres()).resolves.toBe(false);
  });

  it("throws instead of skipping under CI_STRICT_MODE", async () => {
    process.env.CI_STRICT_MODE = "true";

    await expect(unreachablePostgres()).rejects.toThrow(/CI_STRICT_MODE=true/);
  });
});

/** `testEngineAvailable("postgres")` against a port nothing is listening on. */
async function unreachablePostgres(): Promise<boolean> {
  process.env.MAHI_TEST_PGPORT = "1";

  return testEngineAvailable("postgres");
}
