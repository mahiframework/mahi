import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedJob } from "@mahiframework/queue";
import {
  WatchtowerQueueDriver,
  isWatchtowerJob,
  supportsDeferral,
  type WatchtowerQueuedJob,
} from "../src/drivers/watchtower-queue-driver.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

function makeDriver(
  options: {
    onDefer?: (seconds: number) => Promise<void>;
    queue?: string;
    fifo?: boolean;
  } = {},
): WatchtowerQueueDriver {
  return new WatchtowerQueueDriver(harness.database.driver().kysely, {
    connectionName: "watchtower",
    ...options,
  });
}

async function rowFor(id: string | bigint): Promise<{
  attempts: number;
  deferrals: number;
  available_at: string;
  reserved_at: string | null;
  reserved_by: string | null;
  priority: number;
  dispatch_id: string;
}> {
  return (await harness.database
    .driver()
    .kysely.selectFrom("watchtower_jobs" as never)
    .selectAll()
    .where("id" as never, "=", id as never)
    .executeTakeFirstOrThrow()) as never;
}

describe("WatchtowerQueueDriver", () => {
  it("pushes and pops a job, carrying its state", async () => {
    harness = await createHarness();
    const driver = makeDriver();

    await driver.push("app.jobs.sync", { invoiceId: 42 });
    const job = await driver.pop();

    expect(job?.jobClass).toBe("app.jobs.sync");
    expect(job?.state).toEqual({ invoiceId: 42 });
    expect(job?.attempts).toBe(0);
  });

  it("assigns a dispatch id at push", async () => {
    harness = await createHarness();
    const driver = makeDriver();

    await driver.push("app.jobs.sync", {});
    const job = await driver.pop();

    expect(isWatchtowerJob(job!)).toBe(true);
    expect((job as WatchtowerQueuedJob).dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns nothing when the queue is empty", async () => {
    harness = await createHarness();

    expect(await makeDriver().pop()).toBeUndefined();
  });

  it("does not pop a delayed job before it is due", async () => {
    harness = await createHarness();
    const driver = makeDriver();

    await driver.push("app.jobs.later", {}, { delaySeconds: 60 });

    expect(await driver.pop()).toBeUndefined();
  });

  it("reserves a popped job so a second pop misses it", async () => {
    harness = await createHarness();
    const driver = makeDriver();

    await driver.push("app.jobs.sync", {});

    expect(await driver.pop()).toBeDefined();
    expect(await driver.pop()).toBeUndefined();
  });

  it("records which worker reserved a job", async () => {
    harness = await createHarness();
    const driver = makeDriver();
    const runId = "018f0000-0000-7000-8000-00000000aaaa";

    await driver.push("app.jobs.sync", {});
    const job = await driver.popFor(undefined, runId);

    // So a reclaim can report "worker 7 died holding this" rather than
    // silently incrementing a counter.
    expect((await rowFor(job!.id)).reserved_by).toBe(runId);
  });

  it("keeps queues separate", async () => {
    harness = await createHarness();
    const driver = makeDriver();

    await driver.push("app.jobs.a", {}, { queue: "alpha" });
    await driver.push("app.jobs.b", {}, { queue: "beta" });

    expect((await driver.pop("alpha"))?.jobClass).toBe("app.jobs.a");
    expect((await driver.pop("beta"))?.jobClass).toBe("app.jobs.b");
  });

  describe("ordering", () => {
    it("is FIFO for jobs pushed in the same second", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      for (let index = 0; index < 5; index += 1) {
        await driver.push(`app.jobs.job-${index}`, {});
      }

      const popped: string[] = [];

      for (let index = 0; index < 5; index += 1) {
        popped.push((await driver.pop())!.jobClass);
      }

      // `available_at` is second-precision, so all five tie on it and the
      // auto-increment key alone decides the order. This is the
      // assertion a UUID key would have broken.
      expect(popped).toEqual([
        "app.jobs.job-0",
        "app.jobs.job-1",
        "app.jobs.job-2",
        "app.jobs.job-3",
        "app.jobs.job-4",
      ]);
    });

    it("takes a higher priority first within one queue", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.low", {}, { priority: 0 } as never);
      await driver.push("app.jobs.high", {}, { priority: 10 } as never);
      await driver.push("app.jobs.mid", {}, { priority: 5 } as never);

      expect((await driver.pop())?.jobClass).toBe("app.jobs.high");
      expect((await driver.pop())?.jobClass).toBe("app.jobs.mid");
      expect((await driver.pop())?.jobClass).toBe("app.jobs.low");
    });

    it("stays FIFO within one priority band", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.first", {}, { priority: 5 } as never);
      await driver.push("app.jobs.second", {}, { priority: 5 } as never);

      expect((await driver.pop())?.jobClass).toBe("app.jobs.first");
      expect((await driver.pop())?.jobClass).toBe("app.jobs.second");
    });

    it("treats a non-numeric priority as zero rather than writing NaN", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      // Postgres rejects NaN against a smallint outright, so this would
      // be a hard insert failure rather than a wrong sort.
      await driver.push("app.jobs.odd", {}, { priority: "high" } as never);

      const job = await driver.pop();
      expect((await rowFor(job!.id)).priority).toBe(0);
    });
  });

  describe("release", () => {
    it("reschedules and spends an attempt by default", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      const job = (await driver.pop())!;
      const before = await rowFor(job.id);

      await driver.release(job, 60);
      const after = await rowFor(job.id);

      expect(after.attempts).toBe(1);
      expect(after.available_at > before.available_at).toBe(true);
      expect(after.reserved_at).toBeNull();
    });

    it("sends the job to the back, even with no delay", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.first", {});
      await driver.push("app.jobs.second", {});

      const job = (await driver.pop())!;
      expect(job.jobClass).toBe("app.jobs.first");

      // A second boundary, so the restamped `available_at` is visible.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await driver.release(job, 0);

      // Measured, and the reason `fifo` needs its own behaviour at all:
      // reservation order is `available_at asc`, so ANY delay >= 0 makes
      // the released job newer than everything already waiting.
      expect((await driver.pop())?.jobClass).toBe("app.jobs.second");
    });

    it("leaves deferrals alone", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      const job = (await driver.pop())!;

      await driver.release(job, 0);

      expect((await rowFor(job.id)).deferrals).toBe(0);
    });
  });

  describe("release on a fifo process", () => {
    it("spends the attempt, exactly as an ordinary release does", async () => {
      harness = await createHarness();
      const driver = makeDriver({ fifo: true });

      await driver.push("app.jobs.xero", {});
      const job = (await driver.pop()) as WatchtowerQueuedJob;

      await driver.release(job, 60);

      const row = await rowFor(job.id);

      // Being rate-limited is not a free pass: this attempt did not
      // complete, so it counts, and a job that keeps being released
      // still fails once it exhausts `maxAttempts`.
      expect(row.attempts).toBe(1);

      // Tracked separately for reporting, so "throttled 4 times" is
      // distinguishable from "failed 4 times" on the dashboard.
      expect(row.deferrals).toBe(1);
    });

    it("keeps the job at the head of the queue", async () => {
      harness = await createHarness();
      const driver = makeDriver({ fifo: true });

      await driver.push("app.jobs.first", {});
      await driver.push("app.jobs.second", {});

      const job = (await driver.pop()) as WatchtowerQueuedJob;
      expect(job.jobClass).toBe("app.jobs.first");

      const before = await rowFor(job.id);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await driver.release(job, 60);
      const after = await rowFor(job.id);

      // The only divergence from the ordinary path: `available_at` is
      // untouched, so the job does not sort behind what is already
      // waiting. The process does the waiting instead.
      expect(after.available_at).toBe(before.available_at);
      expect((await driver.pop())?.jobClass).toBe("app.jobs.first");
    });

    it("is the SAME call a job makes on a non-fifo process", async () => {
      harness = await createHarness();

      // The point of the whole design. One job body, one call, run
      // against two differently-configured processes — no branching, no
      // second method, no extra argument. Only the outcome differs.
      const releaseLikeAJobWould = async (driver: WatchtowerQueueDriver) => {
        const job = (await driver.pop())!;
        await driver.release(job, 60);

        return job;
      };

      const ordinary = makeDriver({ queue: "ordinary" });
      await ordinary.push("app.jobs.a", {}, { queue: "ordinary" });
      await ordinary.push("app.jobs.b", {}, { queue: "ordinary" });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await releaseLikeAJobWould(ordinary);

      const strict = makeDriver({ queue: "strict", fifo: true });
      await strict.push("app.jobs.a", {}, { queue: "strict" });
      await strict.push("app.jobs.b", {}, { queue: "strict" });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await releaseLikeAJobWould(strict);

      // Same code, different queue ordering, both perfectly valid.
      expect((await ordinary.pop("ordinary"))?.jobClass).toBe("app.jobs.b");
      expect((await strict.pop("strict"))?.jobClass).toBe("app.jobs.a");
    });

    it("un-reserves the job so the same worker can take it again", async () => {
      harness = await createHarness();
      const driver = makeDriver({ fifo: true });

      await driver.push("app.jobs.xero", {});
      const job = (await driver.pop()) as WatchtowerQueuedJob;

      await driver.release(job, 60);

      const row = await rowFor(job.id);
      expect(row.reserved_at).toBeNull();
      expect(row.reserved_by).toBeNull();
    });

    it("accumulates both counters across repeated cooldowns", async () => {
      harness = await createHarness();
      const driver = makeDriver({ fifo: true });

      await driver.push("app.jobs.xero", {});

      for (let round = 1; round <= 3; round += 1) {
        const job = (await driver.pop()) as WatchtowerQueuedJob;
        expect(job.attempts).toBe(round - 1);
        expect(job.deferrals).toBe(round - 1);
        await driver.release(job, 1);
      }

      const job = (await driver.pop()) as WatchtowerQueuedJob;

      // Three throttles, three attempts spent. A job with
      // `maxAttempts: 3` is now out of budget and the worker fails it,
      // which is the documented behaviour.
      expect(job.attempts).toBe(3);
      expect(job.deferrals).toBe(3);
    });

    it("records the cooldown through the injected hook", async () => {
      harness = await createHarness();
      const onDefer = vi.fn(async () => {});
      const driver = makeDriver({ fifo: true, onDefer });

      await driver.push("app.jobs.xero", {});
      const job = (await driver.pop())!;

      await driver.release(job, 45);

      expect(onDefer).toHaveBeenCalledWith(45);
    });

    it("does not record a cooldown on a non-fifo process", async () => {
      harness = await createHarness();
      const onDefer = vi.fn(async () => {});
      const driver = makeDriver({ onDefer });

      await driver.push("app.jobs.sync", {});
      await driver.release((await driver.pop())!, 45);

      expect(onDefer).not.toHaveBeenCalled();
    });

    it("still releases when no cooldown hook is wired", async () => {
      harness = await createHarness();
      const driver = makeDriver({ fifo: true });

      await driver.push("app.jobs.xero", {});
      const job = (await driver.pop())!;

      await driver.release(job, 60);

      // The right degradation for a test or a single-worker script: the
      // job is runnable again, just nothing holds the process back.
      const row = await rowFor(job.id);
      expect(row.reserved_at).toBeNull();
      expect(row.attempts).toBe(1);
    });

    it("reports its mode, and supportsDeferral detects it", async () => {
      harness = await createHarness();

      expect(makeDriver({ fifo: true }).fifo).toBe(true);
      expect(makeDriver().fifo).toBe(false);

      // The guard is about whether the driver UNDERSTANDS fifo, not
      // whether it is enabled — so a worker can refuse to start a
      // `fifo: true` process against a driver that would ignore it.
      expect(supportsDeferral(makeDriver())).toBe(true);
      expect(supportsDeferral({})).toBe(false);
      expect(supportsDeferral(null)).toBe(false);
    });
  });

  describe("reclaim", () => {
    it("re-offers an abandoned job and burns an attempt", async () => {
      harness = await createHarness();
      // A one-second visibility window, so the test does not have to
      // wait 90.
      const driver = new WatchtowerQueueDriver(harness.database.driver().kysely, {
        retryAfterSeconds: 1,
      });

      await driver.push("app.jobs.sync", {});
      const first = await driver.pop();
      expect(first).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const reclaimed = await driver.pop();

      // Counting the attempt is what stops a job that reliably kills its
      // worker from cycling forever.
      expect(reclaimed?.id).toBe(first?.id);
      expect(reclaimed?.attempts).toBe(1);
    });
  });

  describe("delete and fail", () => {
    it("deletes a completed job", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      const job = (await driver.pop())!;

      await driver.delete(job);

      expect(await driver.size()).toBe(0);
    });

    it("moves a failed job to the failed table, atomically", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", { invoiceId: 7 });
      const job = (await driver.pop())!;

      await driver.fail(job, new Error("Xero returned 429"));

      expect(await driver.size()).toBe(0);

      const failed = await driver.listFailed();
      expect(failed).toHaveLength(1);
      expect(failed[0]?.jobClass).toBe("app.jobs.sync");
      expect(failed[0]?.error).toContain("Xero returned 429");
      expect(failed[0]?.connection).toBe("watchtower");
    });

    it("stores the whole stack trace, not just the message", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      const job = (await driver.pop())!;

      await driver.fail(job, new Error("boom"));

      // The trace is what makes a failure diagnosable; the message alone
      // rarely is.
      expect((await driver.listFailed())[0]?.error).toContain("at ");
    });

    it("preserves the dispatch id across a failure", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      const job = (await driver.pop()) as WatchtowerQueuedJob;
      const dispatchId = job.dispatchId;

      await driver.fail(job, new Error("boom"));

      const row = (await harness.database
        .driver()
        .kysely.selectFrom("watchtower_failed_jobs" as never)
        .selectAll()
        .executeTakeFirstOrThrow()) as { dispatch_id: string };

      expect(row.dispatch_id).toBe(dispatchId);
    });

    it("carries the chain onto the failed row", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push(
        "app.jobs.first",
        {},
        { chain: [{ jobClass: "app.jobs.second", state: {} }] },
      );
      const job = (await driver.pop())!;

      await driver.fail(job, new Error("boom"));

      // A retry that drops the chain silently cancels every job queued
      // behind it.
      expect((await driver.listFailed())[0]?.chain).toEqual([
        { jobClass: "app.jobs.second", state: {} },
      ]);
    });
  });

  describe("failed job repository", () => {
    it("retries a failed job back onto its queue, keeping the dispatch id", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", { invoiceId: 7 }, { queue: "alpha" });
      const job = (await driver.pop("alpha")) as WatchtowerQueuedJob;
      const dispatchId = job.dispatchId;

      await driver.fail(job, new Error("boom"));
      expect(await driver.retry(String(job.id))).toBe(true);

      // Back on its own queue, with attempts reset.
      const retried = (await driver.pop("alpha")) as WatchtowerQueuedJob;
      expect(retried.jobClass).toBe("app.jobs.sync");
      expect(retried.attempts).toBe(0);
      expect(retried.state).toEqual({ invoiceId: 7 });

      // And rejoining the same run-history chain, which is the whole
      // reason `dispatch_id` is not the row's key.
      expect(retried.dispatchId).toBe(dispatchId);

      expect(await driver.listFailed()).toHaveLength(0);
    });

    it("gives a retry a fresh row key so it does not jump the queue", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.old", {});
      const job = (await driver.pop())!;
      await driver.fail(job, new Error("boom"));

      await driver.push("app.jobs.new", {});
      await driver.retry(String(job.id));

      // `id` is the FIFO tiebreak, so reusing the failed row's old key
      // would place the retry ahead of a job dispatched after it.
      expect((await driver.pop())?.jobClass).toBe("app.jobs.new");
      expect((await driver.pop())?.jobClass).toBe("app.jobs.old");
    });

    it("reports a retry of an unknown id rather than throwing", async () => {
      harness = await createHarness();

      expect(await makeDriver().retry("999")).toBe(false);
    });

    it("passes a non-numeric id through rather than hitting the database with it", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      // Postgres hard-errors on a non-numeric string against a bigint,
      // so a typo would surface as a database exception instead of "no
      // such job".
      expect(await driver.retry("not-an-id")).toBe(false);
      expect(await driver.findFailed("not-an-id")).toBeUndefined();
      expect(await driver.forget("not-an-id")).toBe(false);
    });

    it("forgets a failed job", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      const job = (await driver.pop())!;
      await driver.fail(job, new Error("boom"));

      expect(await driver.forget(String(job.id))).toBe(true);
      expect(await driver.listFailed()).toHaveLength(0);
    });

    it("flushes every failed job", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      for (let index = 0; index < 3; index += 1) {
        await driver.push(`app.jobs.job-${index}`, {});
        await driver.fail((await driver.pop())!, new Error("boom"));
      }

      expect(await driver.flush()).toBe(3);
      expect(await driver.listFailed()).toHaveLength(0);
    });

    it("keeps recent failures when flushing by age", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      await driver.fail((await driver.pop())!, new Error("boom"));

      // Nothing is an hour old yet, so nothing goes.
      expect(await driver.flush(1)).toBe(0);
      expect(await driver.listFailed()).toHaveLength(1);
    });

    it("lists newest failures first", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.older", {});
      await driver.fail((await driver.pop())!, new Error("boom"));

      // A second apart, because `failed_at` is second-precision and two
      // rows written in the same second cannot be ordered by it.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await driver.push("app.jobs.newer", {});
      await driver.fail((await driver.pop())!, new Error("boom"));

      expect((await driver.listFailed()).map((row) => row.jobClass)).toEqual([
        "app.jobs.newer",
        "app.jobs.older",
      ]);
    });

    it("does not touch the core failed_jobs table", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.sync", {});
      await driver.fail((await driver.pop())!, new Error("boom"));

      // The reason these are separate tables at all: the core
      // `listFailed()` is unfiltered and its `retry()` re-inserts into
      // `jobs`, so a Watchtower failure living there would be
      // resurrected into a queue no Watchtower worker reads.
      const tables = (await harness.database
        .driver()
        .kysely.selectFrom("sqlite_master" as never)
        .select(["name" as never])
        .where("type" as never, "=", "table" as never)
        .execute()) as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).not.toContain("failed_jobs");
    });
  });

  describe("size and clear", () => {
    it("counts jobs on a queue", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.a", {}, { queue: "alpha" });
      await driver.push("app.jobs.b", {}, { queue: "alpha" });
      await driver.push("app.jobs.c", {}, { queue: "beta" });

      expect(await driver.size("alpha")).toBe(2);
      expect(await driver.size("beta")).toBe(1);
    });

    it("clears one queue without touching another", async () => {
      harness = await createHarness();
      const driver = makeDriver();

      await driver.push("app.jobs.a", {}, { queue: "alpha" });
      await driver.push("app.jobs.c", {}, { queue: "beta" });

      expect(await driver.clear("alpha")).toBe(1);
      expect(await driver.size("beta")).toBe(1);
    });
  });

  describe("isWatchtowerJob", () => {
    it("rejects a plain queued job", () => {
      const plain: QueuedJob = {
        id: 1n,
        jobClass: "app.jobs.sync",
        state: {},
        attempts: 0,
      };

      expect(isWatchtowerJob(plain)).toBe(false);
    });
  });
});
