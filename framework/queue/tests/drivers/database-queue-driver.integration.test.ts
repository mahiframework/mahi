import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  MysqlDriver,
  PostgresDriver,
  SCHEMA_TOKEN,
  transaction,
  type DatabaseDriver,
  type MysqlConnectionConfig,
  type PostgresConnectionConfig,
} from "@mahiframework/database";
import { DatabaseQueueDriver } from "../../src/drivers/database-queue-driver.js";
import createJobsTable from "../../src/migrations/0001_create_jobs_table.js";
import queueReliability from "../../src/migrations/0002_queue_reliability.js";

/**
 * The SQLite suite covers the portable behaviour; this one exists for the
 * parts that are **only** exercised on a real client/server engine:
 *
 *   - the `SELECT ... FOR UPDATE SKIP LOCKED` reservation path, which
 *     SQLite never takes;
 *   - timestamp comparison, where MySQL's `DATETIME` silently refuses to
 *     compare against an ISO-8601 `...Z` string, so `available_at <= now`
 *     matches nothing and the queue appears permanently empty;
 *   - genuinely concurrent workers on separate connections, which SQLite's
 *     single writer cannot express.
 *
 * Skipped (not failed) when the engine isn't reachable.
 */

const MYSQL: MysqlConnectionConfig = {
  host: "127.0.0.1",
  port: 3306,
  database: "mahi_test",
  username: "root",
  password: "mysql",
};

const POSTGRES: PostgresConnectionConfig = {
  host: "127.0.0.1",
  port: 5432,
  database: "mahi_test",
  username: "postgres",
  password: "postgres",
};

type LiveDriver = DatabaseDriver & { connect(): Promise<void>; disconnect(): Promise<void> };

interface Engine {
  name: string;
  make(): LiveDriver;
}

const engines: Engine[] = [
  { name: "mysql", make: () => new MysqlDriver(MYSQL) },
  { name: "postgres", make: () => new PostgresDriver(POSTGRES) },
];

async function reachable(make: () => LiveDriver): Promise<boolean> {
  try {
    const driver = make();
    await driver.connect();
    await driver.disconnect();

    return true;
  } catch {
    return false;
  }
}

for (const engine of engines) {
  describe(`DatabaseQueueDriver on ${engine.name}`, async () => {
    const available = await reachable(engine.make);
    const maybe = available ? describe : describe.skip;

    maybe(`${engine.name} (live)`, () => {
      let db: LiveDriver;
      let app: Application;

      /**
       * A driver on the live connection. The dialect is deliberately not
       * passed. The driver reads it off the connection, so these tests
       * exercise that resolution rather than being told the answer.
       */
      function makeDriver(options: Partial<{ retryAfterSeconds: number; queue: string }> = {}) {
        return new DatabaseQueueDriver(db.kysely, {
          connectionName: engine.name,
          ...options,
        });
      }

      beforeAll(async () => {
        db = engine.make();
        await db.connect();

        app = new Application();
        const manager = new DatabaseManager(app, { default: engine.name, connections: {} });
        manager.extend(engine.name, () => db);
        app.instance(DATABASE_TOKEN, manager);
        app.bind(SCHEMA_TOKEN, () => manager.schema());
        setCurrentApp(app);

        await manager.schema().dropAllTables();

        // The migrations are applied directly rather than through
        // `MigrationRunner`, because the runner's own bookkeeping writes
        // `migrations.migrated_at` / `migrations_lock.acquired_at` as
        // ISO-8601 `...Z` strings, which MySQL's DATETIME rejects
        // outright ("Incorrect datetime value"). That is a real bug, but
        // it is the migrator's, not the queue's, and it is owned by the
        // MySQL/Postgres plan, running the migrations directly keeps
        // this suite testing what it is about (the driver) instead of
        // being blocked by an unrelated defect.
        await createJobsTable.up();
        await queueReliability.up();
      });

      afterAll(async () => {
        if (!db) {
          return;
        }

        const manager = app.make<DatabaseManager>(DATABASE_TOKEN);
        await manager.schema().dropAllTables();
        clearCurrentApp();
        await db.disconnect();
      });

      beforeEach(async () => {
        await db.kysely.deleteFrom("jobs").execute();
        await db.kysely.deleteFrom("failed_jobs").execute();
      });

      it("push() then pop() round-trips, the timestamps actually compare", async () => {
        // MySQL's DATETIME comparison rejects the trailing `Z` of an
        // ISO-8601 string; if the timestamps were written that way,
        // `available_at <= now` would match nothing and every queue would
        // look permanently empty.
        const driver = makeDriver();
        await driver.push("send-email", { to: "a@example.com" });

        const job = await driver.pop();
        expect(job?.jobClass).toBe("send-email");
        expect(job?.state).toEqual({ to: "a@example.com" });
        expect(job?.attempts).toBe(0);
      });

      it("a delayed job is not poppable until it is due", async () => {
        const driver = makeDriver();
        await driver.push("send-email", {}, { delaySeconds: 3600 });
        expect(await driver.pop()).toBeUndefined();
      });

      it("a second pop() does not return an already-reserved row", async () => {
        const driver = makeDriver();
        await driver.push("send-email", {});

        expect(await driver.pop()).toBeDefined();
        expect(await driver.pop()).toBeUndefined();
      });

      it("two workers on SEPARATE connections never reserve the same job", async () => {
        // The assertion SQLite structurally cannot make. With SKIP LOCKED
        // the losing worker steps over the locked row rather than
        // blocking on it or double-reserving.
        const other = engine.make();
        await other.connect();
        try {
          const a = makeDriver();
          const b = new DatabaseQueueDriver(other.kysely, {
            connectionName: engine.name,
          });

          await a.push("send-email", { n: 1 });

          const [first, second] = await Promise.all([a.pop(), b.pop()]);
          expect([first, second].filter(Boolean)).toHaveLength(1);
        } finally {
          await other.disconnect();
        }
      });

      it("three concurrent workers each get a distinct job", async () => {
        const extras = [engine.make(), engine.make()];
        await Promise.all(extras.map((d) => d.connect()));
        try {
          const drivers = [
            makeDriver(),
            ...extras.map(
              (d) =>
                new DatabaseQueueDriver(d.kysely, {
                  connectionName: engine.name,
                }),
            ),
          ];

          for (const n of [1, 2, 3]) {
            await drivers[0]!.push("send-email", { n });
          }

          const popped = await Promise.all(drivers.map((d) => d.pop()));
          const ids = popped.filter(Boolean).map((j) => j!.id);

          expect(ids).toHaveLength(3);
          expect(new Set(ids).size).toBe(3); // all distinct
        } finally {
          await Promise.all(extras.map((d) => d.disconnect()));
        }
      });

      it("reclaims a job whose worker died, with attempts + 1", async () => {
        // retryAfter 0: the reservation is expired the instant it's made,
        // which is what a killed worker looks like without waiting 90s.
        const driver = makeDriver({ retryAfterSeconds: 0 });
        await driver.push("send-email", { n: 1 });

        const first = await driver.pop();
        expect(first?.attempts).toBe(0);

        const reclaimed = await driver.pop();
        expect(reclaimed?.id).toBe(first!.id);
        expect(reclaimed?.attempts).toBe(1);
      });

      it("does not reclaim a job still inside its visibility window", async () => {
        const driver = makeDriver({ retryAfterSeconds: 90 });
        await driver.push("send-email", {});

        expect(await driver.pop()).toBeDefined();
        expect(await driver.pop()).toBeUndefined();
      });

      it("release() makes the job available again with an incremented attempt", async () => {
        const driver = makeDriver();
        await driver.push("send-email", {});

        const job = await driver.pop();
        await driver.release(job!);

        expect((await driver.pop())?.attempts).toBe(1);
      });

      it("fail() moves the job atomically, keeping its chain and queue", async () => {
        const driver = makeDriver();
        await driver.push(
          "step",
          { step: "a" },
          {
            queue: "emails",
            chain: [{ jobClass: "step", state: { step: "b" } }],
          },
        );

        const job = await driver.pop("emails");
        await driver.fail(job!, new Error("boom"));

        const [record] = await driver.listFailed();
        expect(record?.queue).toBe("emails");
        expect(record?.connection).toBe(engine.name);
        expect(record?.chain).toEqual([{ jobClass: "step", state: { step: "b" } }]);
        expect(await driver.pop("emails")).toBeUndefined();
      });

      it("retry() puts the job back on its own queue with the chain intact", async () => {
        const driver = makeDriver();
        await driver.push(
          "step",
          { step: "a" },
          {
            queue: "emails",
            chain: [{ jobClass: "step", state: { step: "b" } }],
          },
        );
        const job = await driver.pop("emails");
        await driver.fail(job!, new Error("boom"));

        expect(await driver.retry(String(job!.id))).toBe(true);

        expect(await driver.pop("default")).toBeUndefined();
        const requeued = await driver.pop("emails");
        expect(requeued?.attempts).toBe(0);
        expect(requeued?.chain).toEqual([{ jobClass: "step", state: { step: "b" } }]);
      });

      it("named queues are isolated", async () => {
        const driver = makeDriver();
        await driver.push("a", {}, { queue: "emails" });
        await driver.push("b", {}, { queue: "reports" });

        expect((await driver.pop("emails"))?.jobClass).toBe("a");
        expect(await driver.pop("emails")).toBeUndefined();
        expect((await driver.pop("reports"))?.jobClass).toBe("b");
      });

      it("a push inside a rolled-back transaction leaves no job behind", async () => {
        // The insert must go in on the transaction's connection, not the
        // root one: on MySQL/PG a root-connection insert commits
        // independently, so a worker could pop a job whose rows never
        // existed.
        const driver = makeDriver();

        await expect(
          transaction(db.kysely, async () => {
            await driver.push("send-email", {});
            throw new Error("rolled back");
          }),
        ).rejects.toThrow("rolled back");

        expect(await driver.pop()).toBeUndefined();
      });

      it("pushAfterCommit() is invisible until the transaction commits, then pushes once", async () => {
        const driver = makeDriver();
        const other = engine.make();
        await other.connect();

        try {
          let visibleToOtherConnection = -1;

          await transaction(db.kysely, async () => {
            await driver.pushAfterCommit("send-email", { n: 1 });
            // A separate connection is exactly what a worker process is.
            const rows = await other.kysely.selectFrom("jobs").selectAll().execute();
            visibleToOtherConnection = rows.length;
          });

          expect(visibleToOtherConnection).toBe(0);
          expect((await driver.pop())?.state).toEqual({ n: 1 });
          expect(await driver.pop()).toBeUndefined();
        } finally {
          await other.disconnect();
        }
      });

      it("pushAfterCommit() pushes nothing when the transaction rolls back", async () => {
        const driver = makeDriver();

        await expect(
          transaction(db.kysely, async () => {
            await driver.pushAfterCommit("send-email", {});
            throw new Error("rolled back");
          }),
        ).rejects.toThrow("rolled back");

        expect(await driver.pop()).toBeUndefined();
      });
    });
  });
}
