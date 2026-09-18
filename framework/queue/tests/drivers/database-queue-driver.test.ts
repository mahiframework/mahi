import { afterEach, describe, expect, it } from "vitest";
import type {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
} from "kysely";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  MigrationRunner,
  SCHEMA_TOKEN,
  SqliteDriver,
  transaction,
} from "@mahiframework/database";
import { DatabaseQueueDriver } from "../../src/drivers/database-queue-driver.js";
import type { DatabaseQueueDriverOptions } from "../../src/drivers/database-queue-driver.js";

/**
 * A migrated in-memory database plus a driver on it. The Kysely instance
 * comes back too, so tests can assert on raw rows (reservation state,
 * failed-job columns) that the driver's own API deliberately hides.
 */
async function freshDatabase(options: DatabaseQueueDriverOptions = {}) {
  const sqlite = new SqliteDriver({ filename: ":memory:" });
  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => sqlite);
  app.instance(DATABASE_TOKEN, manager);
  app.bind(SCHEMA_TOKEN, () => manager.schema());
  setCurrentApp(app);

  const runner = new MigrationRunner(sqlite.kysely);
  await runner.up([new URL("../../src/migrations", import.meta.url).pathname]);

  return { db: sqlite.kysely, driver: new DatabaseQueueDriver(sqlite.kysely, options), app };
}

async function freshDriver(options: DatabaseQueueDriverOptions = {}) {
  return (await freshDatabase(options)).driver;
}

/** Backdate a job's reservation so it looks abandoned `secondsAgo` seconds ago. */
async function backdateReservation(
  db: Kysely<any>,
  id: string | bigint,
  secondsAgo: number,
): Promise<void> {
  await db
    .updateTable("jobs")
    .set({ reserved_at: new Date(Date.now() - secondsAgo * 1000).toISOString() })
    .where("id", "=", id)
    .execute();
}

/**
 * A Kysely plugin that reports every query's AST as it is executed, and
 * can make chosen ones throw.
 *
 * The AST, not a SQL string, because that's what a plugin actually
 * receives, and because "the select node carries a limit" is a stronger
 * assertion than "the SQL text contains the word limit" anyway. The
 * `fail` hook is how the atomicity tests simulate a mid-`fail()` crash
 * without needing a real one.
 */
function inspectingPlugin(options: {
  onQuery?: (node: any) => void;
  failWhen?: (node: any) => boolean;
}): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs) {
      options.onQuery?.(args.node);

      if (options.failWhen?.(args.node)) {
        throw new Error("disk full");
      }

      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs) {
      return args.result;
    },
  };
}

/** Whether an insert/delete/select AST node targets `table`. */
function targets(node: any, table: string): boolean {
  const named =
    node?.into?.table?.identifier?.name ?? node?.from?.froms?.[0]?.table?.identifier?.name;

  return named === table;
}

describe("DatabaseQueueDriver", () => {
  afterEach(() => {
    clearCurrentApp();
  });
  it("push() then pop() returns the job with attempts reserved (reserved_at set)", async () => {
    const driver = await freshDriver();

    await driver.push("send-email", { to: "a@example.com" });
    const job = await driver.pop();

    expect(job).toBeDefined();
    expect(job?.jobClass).toBe("send-email");
    expect(job?.state).toEqual({ to: "a@example.com" });
    expect(job?.attempts).toBe(0);
  });

  it("a second pop() does not return the same (already-reserved) row", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", { to: "a@example.com" });

    const first = await driver.pop();
    const second = await driver.pop();

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("delete() removes the job permanently", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", {});
    const job = await driver.pop();

    await driver.delete(job!);

    // Even after release-style logic there should be nothing left to pop.
    expect(await driver.pop()).toBeUndefined();
  });

  it("release() makes the job poppable again immediately (no delay)", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", {});
    const job = await driver.pop();

    await driver.release(job!);

    const rePopped = await driver.pop();
    expect(rePopped).toBeDefined();
    expect(rePopped?.attempts).toBe(1);
  });

  it("release() with a delay makes the job unavailable until that delay elapses", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", {});
    const job = await driver.pop();

    await driver.release(job!, 3600); // 1 hour from now

    expect(await driver.pop()).toBeUndefined();
  });

  it("push() with delaySeconds is not immediately poppable", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", {}, { delaySeconds: 3600 });

    expect(await driver.pop()).toBeUndefined();
  });

  it("fail() moves the job to failed_jobs and removes it from jobs", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", { to: "a@example.com" });
    const job = await driver.pop();

    await driver.fail(job!, new Error("smtp down"));

    expect(await driver.pop()).toBeUndefined();
  });

  it("persists and round-trips an attached chain through push()/pop()", async () => {
    const driver = await freshDriver();
    await driver.push(
      "step",
      { step: "a" },
      {
        chain: [
          { jobClass: "step", state: { step: "b" } },
          { jobClass: "step", state: { step: "c" } },
        ],
      },
    );

    const job = await driver.pop();
    expect(job?.chain).toEqual([
      { jobClass: "step", state: { step: "b" } },
      { jobClass: "step", state: { step: "c" } },
    ]);
  });

  it("leaves the chain intact across a release()/re-pop()", async () => {
    const driver = await freshDriver();
    await driver.push(
      "step",
      { step: "a" },
      {
        chain: [{ jobClass: "step", state: { step: "b" } }],
      },
    );

    const first = await driver.pop();
    await driver.release(first!, 0);
    const again = await driver.pop();

    expect(again?.attempts).toBe(1);
    expect(again?.chain).toEqual([{ jobClass: "step", state: { step: "b" } }]);
  });

  it("an unchained job pops with no chain property", async () => {
    const driver = await freshDriver();
    await driver.push("send-email", { to: "a@example.com" });
    const job = await driver.pop();
    expect(job?.chain).toBeUndefined();
  });

  describe("failed-job repository", () => {
    async function failOne(
      driver: DatabaseQueueDriver,
      jobClass = "send-email",
      state: unknown = { to: "a@example.com" },
    ) {
      await driver.push(jobClass, state as any);
      const job = await driver.pop();
      await driver.fail(job!, new Error("smtp down"));

      // The failed-job API is keyed by string (ids reach it from a
      // command line), while the driver handle is a snowflake.
      return { ...job!, id: String(job!.id) };
    }

    it("fail() stores the full stack trace in the error column", async () => {
      const driver = await freshDriver();
      const err = new Error("smtp down");
      await driver.push("send-email", {});
      const job = await driver.pop();
      await driver.fail(job!, err);

      const [record] = await driver.listFailed();
      expect(record?.error).toBe(err.stack);
      expect(record?.error).toContain("smtp down");
    });

    it("listFailed() returns every stored failure", async () => {
      const driver = await freshDriver();
      await failOne(driver, "job-a");
      await failOne(driver, "job-b");

      const failed = await driver.listFailed();
      expect(failed.map((f) => f.jobClass).sort()).toEqual(["job-a", "job-b"]);
    });

    it("findFailed() returns a single record or undefined", async () => {
      const driver = await freshDriver();
      const job = await failOne(driver);

      expect((await driver.findFailed(job.id))?.jobClass).toBe("send-email");
      expect(await driver.findFailed("nope")).toBeUndefined();
    });

    it("retry() re-queues the payload and removes the failed row", async () => {
      const driver = await freshDriver();
      const job = await failOne(driver, "send-email", { to: "b@example.com" });

      expect(await driver.retry(job.id)).toBe(true);
      expect(await driver.findFailed(job.id)).toBeUndefined();

      const requeued = await driver.pop();
      expect(requeued?.jobClass).toBe("send-email");
      expect(requeued?.state).toEqual({ to: "b@example.com" });
      expect(requeued?.attempts).toBe(0);
    });

    it("retry() returns false for an unknown id", async () => {
      const driver = await freshDriver();
      expect(await driver.retry("nope")).toBe(false);
    });

    it("forget() deletes a single failed job", async () => {
      const driver = await freshDriver();
      const job = await failOne(driver);

      expect(await driver.forget(job.id)).toBe(true);
      expect(await driver.findFailed(job.id)).toBeUndefined();
      expect(await driver.forget(job.id)).toBe(false);
    });

    it("flush() with no argument deletes every failed job", async () => {
      const driver = await freshDriver();
      await failOne(driver, "job-a");
      await failOne(driver, "job-b");

      expect(await driver.flush()).toBe(2);
      expect(await driver.listFailed()).toEqual([]);
    });

    it("flush(hours) only deletes failures older than the cutoff", async () => {
      const driver = await freshDriver();
      await failOne(driver); // failed just now

      // Nothing is older than 1 hour yet.
      expect(await driver.flush(1)).toBe(0);
      expect(await driver.listFailed()).toHaveLength(1);
    });
  });

  describe("reclaiming abandoned jobs (retryAfter)", () => {
    it("does not reclaim a job reserved more recently than retryAfter", async () => {
      const { db, driver } = await freshDatabase({ retryAfterSeconds: 90 });
      await driver.push("send-email", {});
      const job = await driver.pop();

      await backdateReservation(db, job!.id, 30); // still well inside the window

      expect(await driver.pop()).toBeUndefined();
    });

    it("reclaims a job whose worker died, returning it with attempts + 1", async () => {
      const { db, driver } = await freshDatabase({ retryAfterSeconds: 90 });
      await driver.push("send-email", { to: "a@example.com" });

      // Reserve it, then simulate the worker being killed: nothing ever
      // deletes/releases the row, and its reservation ages out.
      const first = await driver.pop();
      expect(first?.attempts).toBe(0);
      await backdateReservation(db, first!.id, 120);

      const reclaimed = await driver.pop();
      expect(reclaimed?.id).toBe(first!.id);
      expect(reclaimed?.attempts).toBe(1);
      expect(reclaimed?.state).toEqual({ to: "a@example.com" });
    });

    it("persists the incremented attempt count, so repeated crashes are bounded", async () => {
      const { db, driver } = await freshDatabase({ retryAfterSeconds: 90 });
      await driver.push("send-email", {});

      const first = await driver.pop();
      await backdateReservation(db, first!.id, 120);
      await driver.pop();
      await backdateReservation(db, first!.id, 120);

      expect((await driver.pop())?.attempts).toBe(2);
    });

    it("re-reserves a reclaimed job, so a second worker can't take it at once", async () => {
      const { db, driver } = await freshDatabase({ retryAfterSeconds: 90 });
      await driver.push("send-email", {});
      const first = await driver.pop();
      await backdateReservation(db, first!.id, 120);

      const reclaimed = await driver.pop();
      expect(reclaimed).toBeDefined();
      // Freshly reserved again, nobody else may have it.
      expect(await driver.pop()).toBeUndefined();
    });

    it("keeps a reclaimed job's chain intact", async () => {
      const { db, driver } = await freshDatabase({ retryAfterSeconds: 90 });
      await driver.push(
        "step",
        { step: "a" },
        { chain: [{ jobClass: "step", state: { step: "b" } }] },
      );

      const first = await driver.pop();
      await backdateReservation(db, first!.id, 120);

      expect((await driver.pop())?.chain).toEqual([{ jobClass: "step", state: { step: "b" } }]);
    });
  });

  describe("bounded reads", () => {
    it("pop() reads a bounded batch rather than the whole backlog", async () => {
      const { db } = await freshDatabase();

      const selects: any[] = [];
      const observed = db.withPlugin(
        inspectingPlugin({
          onQuery: (node) => {
            if (node.kind === "SelectQueryNode" && targets(node, "jobs")) {
              selects.push(node);
            }
          },
        }),
      );

      await new DatabaseQueueDriver(observed, { popBatchSize: 5 }).pop();

      expect(selects).toHaveLength(1);
      // The candidate read is capped, an unbounded select here is a full
      // scan of the backlog on every poll of every worker.
      expect(selects[0].limit).toBeDefined();
      expect(selects[0].limit.limit.value).toBe(5);
    });

    it("the migration creates an index matching pop()'s WHERE and ORDER BY", async () => {
      const { db } = await freshDatabase();

      const indexes = (await db
        .selectFrom("sqlite_master" as any)
        .select(["name", "sql"] as any)
        .where("type", "=", "index")
        .where("tbl_name", "=", "jobs")
        .execute()) as { name: string; sql: string | null }[];

      // The column order matters: it has to satisfy `ORDER BY
      // available_at, id`, or MySQL adds a filesort, and a filesorted
      // `FOR UPDATE SKIP LOCKED` locks every row it sorts, so concurrent
      // workers skip them all and the queue looks empty.
      const covering = indexes.find((index) =>
        /queue.*available_at.*(id|"id")/s.test(index.sql ?? ""),
      );
      expect(covering).toBeDefined();
    });
  });

  /**
   * `available_at` is truncated to whole seconds, so it cannot order a
   * burst dispatched inside one — `id` is the only thing that can, and
   * that is what makes push order survive.
   */
  describe("ordering", () => {
    it("pops a burst in the order it was pushed", async () => {
      const driver = await freshDriver();

      const pushed = Array.from({ length: 200 }, (_, n) => n);

      for (const n of pushed) {
        await driver.push("send-email", { n });
      }

      const popped: number[] = [];

      for (let i = 0; i < pushed.length; i += 1) {
        const job = await driver.pop();

        popped.push((job!.state as { n: number }).n);
        await driver.delete(job!);
      }

      expect(popped).toEqual(pushed);
    });

    it("pushes ids that ascend, so the tiebreak is push order", async () => {
      const { db, driver } = await freshDatabase();

      for (let n = 0; n < 50; n += 1) {
        await driver.push("send-email", { n });
      }

      // Sorted by payload, not by id: `id` is the primary key, so reading
      // the table back in id order proves nothing on its own. This asks
      // whether the ids ascend *with the push sequence*.
      const rows = (await db.selectFrom("jobs").select(["id", "payload_json"]).execute()) as {
        id: string;
        payload_json: string;
      }[];

      const ids = rows
        .sort(
          (a, b) =>
            (JSON.parse(a.payload_json) as { n: number }).n -
            (JSON.parse(b.payload_json) as { n: number }).n,
        )
        .map((row) => row.id);

      expect([...ids].sort()).toEqual(ids);
    });

    it("runs a job due sooner before one pushed earlier but delayed", async () => {
      const driver = await freshDriver();

      await driver.push("send-email", { n: "delayed" }, { delaySeconds: 60 });
      await driver.push("send-email", { n: "immediate" });

      const job = await driver.pop();

      expect((job?.state as { n: string }).n).toBe("immediate");
    });
  });

  describe("named queues", () => {
    it("pop() only returns jobs from the queue it was asked for", async () => {
      const driver = await freshDriver();
      await driver.push("send-email", { n: 1 }, { queue: "emails" });
      await driver.push("send-email", { n: 2 }, { queue: "reports" });

      const email = await driver.pop("emails");
      expect(email?.state).toEqual({ n: 1 });
      expect(email?.queue).toBe("emails");

      expect(await driver.pop("emails")).toBeUndefined();
      expect((await driver.pop("reports"))?.state).toEqual({ n: 2 });
    });

    it("a driver's configured queue is what push()/pop() default to", async () => {
      const driver = await freshDriver({ queue: "emails" });
      await driver.push("send-email", { n: 1 });

      expect(await driver.pop("default")).toBeUndefined();
      expect((await driver.pop())?.state).toEqual({ n: 1 });
    });

    it("clear() deletes only the named queue's pending jobs", async () => {
      const driver = await freshDriver();
      await driver.push("a", {}, { queue: "emails" });
      await driver.push("b", {}, { queue: "emails" });
      await driver.push("c", {}, { queue: "reports" });

      expect(await driver.clear("emails")).toBe(2);
      expect(await driver.size("emails")).toBe(0);
      expect(await driver.size("reports")).toBe(1);
    });
  });

  describe("atomicity", () => {
    it("fail() does not delete the job when recording the failure throws", async () => {
      const { db, driver } = await freshDatabase();
      await driver.push("send-email", {});
      const job = await driver.pop();

      // Break the insert half of fail(). Without a transaction around the
      // pair, the delete would still land and the job would vanish with
      // no record anywhere that it ever existed.
      const broken = db.withPlugin(
        inspectingPlugin({
          failWhen: (node) => node.kind === "InsertQueryNode" && targets(node, "failed_jobs"),
        }),
      );

      await expect(new DatabaseQueueDriver(broken).fail(job!, new Error("boom"))).rejects.toThrow(
        "disk full",
      );

      // Still there, still reserved, reclaimable after retryAfter, not lost.
      expect(await db.selectFrom("jobs").selectAll().execute()).toHaveLength(1);
      expect(await driver.listFailed()).toEqual([]);
    });

    it("retry() leaves the failed record alone when the requeue throws", async () => {
      const { db, driver } = await freshDatabase();
      await driver.push("send-email", {});
      const job = await driver.pop();
      await driver.fail(job!, new Error("boom"));

      const broken = db.withPlugin(
        inspectingPlugin({
          failWhen: (node) => node.kind === "InsertQueryNode" && targets(node, "jobs"),
        }),
      );

      await expect(new DatabaseQueueDriver(broken).retry(String(job!.id))).rejects.toThrow(
        "disk full",
      );

      // The failed record survived, so the job is recoverable rather than
      // deleted-but-never-requeued.
      expect(await driver.findFailed(String(job!.id))).toBeDefined();
      expect(await driver.pop()).toBeUndefined();
    });
  });

  describe("failed jobs keep enough context to be retried faithfully", () => {
    it("records the connection and queue the job failed on", async () => {
      const driver = await freshDriver({ connectionName: "database" });
      await driver.push("send-email", {}, { queue: "emails" });
      const job = await driver.pop("emails");
      await driver.fail(job!, new Error("boom"));

      const [record] = await driver.listFailed();
      expect(record?.connection).toBe("database");
      expect(record?.queue).toBe("emails");
    });

    it("retry() restores the chain instead of dropping it", async () => {
      const driver = await freshDriver();
      await driver.push(
        "step",
        { step: "a" },
        {
          chain: [
            { jobClass: "step", state: { step: "b" } },
            { jobClass: "step", state: { step: "c" } },
          ],
        },
      );
      const job = await driver.pop();
      await driver.fail(job!, new Error("boom"));

      expect((await driver.findFailed(String(job!.id)))?.chain).toEqual([
        { jobClass: "step", state: { step: "b" } },
        { jobClass: "step", state: { step: "c" } },
      ]);

      await driver.retry(String(job!.id));

      // The links queued behind it still run.
      expect((await driver.pop())?.chain).toEqual([
        { jobClass: "step", state: { step: "b" } },
        { jobClass: "step", state: { step: "c" } },
      ]);
    });

    it("retry() puts the job back on the queue it failed on", async () => {
      const driver = await freshDriver();
      await driver.push("send-email", {}, { queue: "emails" });
      const job = await driver.pop("emails");
      await driver.fail(job!, new Error("boom"));

      await driver.retry(String(job!.id));

      expect(await driver.pop("default")).toBeUndefined();
      expect(await driver.pop("emails")).toBeDefined();
    });
  });

  describe("transactions", () => {
    it("push() inside a transaction rolls back with it", async () => {
      const { db, driver } = await freshDatabase();

      await expect(
        transaction(db, async () => {
          await driver.push("send-email", {});
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      expect(await driver.pop()).toBeUndefined();
    });

    it("push() inside a committed transaction is visible afterwards", async () => {
      const { db, driver } = await freshDatabase();

      await transaction(db, async () => {
        await driver.push("send-email", { n: 1 });
      });

      expect((await driver.pop())?.state).toEqual({ n: 1 });
    });

    it("pushAfterCommit() pushes nothing when the transaction rolls back", async () => {
      const { db, driver } = await freshDatabase();

      await expect(
        transaction(db, async () => {
          await driver.pushAfterCommit("send-email", {});
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      expect(await driver.pop()).toBeUndefined();
    });

    it("pushAfterCommit() pushes exactly once, after the transaction commits", async () => {
      const { db, driver } = await freshDatabase();

      let visibleDuring: unknown;
      await transaction(db, async (trx) => {
        await driver.pushAfterCommit("send-email", { n: 1 });
        // Nothing written yet, the whole point. Read through `trx`, not
        // the root: SQLite's single writer is held by this transaction,
        // so a root-connection read would just block until busy_timeout.
        visibleDuring = await trx.selectFrom("jobs").selectAll().execute();
      });

      expect(visibleDuring).toEqual([]);
      expect((await driver.pop())?.state).toEqual({ n: 1 });
      expect(await driver.pop()).toBeUndefined();
    });

    it("pushAfterCommit() outside a transaction pushes immediately", async () => {
      const driver = await freshDriver();
      await driver.pushAfterCommit("send-email", { n: 1 });
      expect((await driver.pop())?.state).toEqual({ n: 1 });
    });
  });
});
