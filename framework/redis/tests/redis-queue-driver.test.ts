import { afterEach, describe, expect, it } from "vitest";
import { RedisQueueDriver } from "../src/drivers/redis-queue-driver.js";
import type { RedisQueueDriverOptions } from "../src/drivers/redis-queue-driver.js";
import type { RedisConnection } from "../src/redis-connection.js";
import { REDIS_UNAVAILABLE, testConnection } from "./redis-test-helpers.js";

describe.skipIf(REDIS_UNAVAILABLE)("RedisQueueDriver (integration)", () => {
  const connections: RedisConnection[] = [];

  async function driver(
    queue = `q-${Math.random().toString(36).slice(2)}`,
    options: RedisQueueDriverOptions = {},
  ): Promise<RedisQueueDriver> {
    const connection = await testConnection();
    connections.push(connection);

    return new RedisQueueDriver(connection, queue, options);
  }

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      // Delete only this run's keys, by prefix. `FLUSHDB` empties the
      // whole logical DB, which is fine against a throwaway container and
      // destructive against the dev Redis a developer runs these against,
      // and it is exactly the "one command wipes a co-tenant" behaviour
      // `RedisCacheStore.flush()` goes out of its way not to have.
      const prefix = connection.keyPrefix();
      const keys = await connection.client().keys(`${prefix}*`);

      if (keys.length > 0) {
        await connection.client().unlink(...keys.map((key) => key.slice(prefix.length)));
      }

      await connection.disconnect();
    }
  });

  it("push()/pop() round-trips a job FIFO", async () => {
    const d = await driver();
    await d.push("SendEmail", { to: "a@example.com" });
    await d.push("SendEmail", { to: "b@example.com" });

    const first = await d.pop();
    const second = await d.pop();

    expect(first).toMatchObject({
      jobClass: "SendEmail",
      state: { to: "a@example.com" },
      attempts: 0,
    });
    expect(second).toMatchObject({ state: { to: "b@example.com" } });
    expect(await d.pop()).toBeUndefined();
  });

  it("delete() acks a reserved job so it never returns", async () => {
    const d = await driver();
    await d.push("Job", { n: 1 });
    const job = await d.pop();
    expect(job).toBeDefined();
    await d.delete(job!);
    expect(await d.pop()).toBeUndefined();
  });

  it("release() puts the job back with an incremented attempt count", async () => {
    const d = await driver();
    await d.push("Job", { n: 1 });
    const job = await d.pop();
    await d.release(job!);

    const retried = await d.pop();
    expect(retried).toMatchObject({ jobClass: "Job", attempts: 1 });
  });

  it("release() with a delay holds the job until it's due", async () => {
    const d = await driver();
    await d.push("Job", { n: 1 });
    const job = await d.pop();
    await d.release(job!, 1);

    // Not yet available.
    expect(await d.pop()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1100));
    // Now migrated into the ready list.
    expect(await d.pop()).toMatchObject({ attempts: 1 });
  });

  it("a delayed push() is not popped before its delay elapses", async () => {
    const d = await driver();
    await d.push("Job", { n: 1 }, { delaySeconds: 1 });
    expect(await d.pop()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1100));
    expect(await d.pop()).toMatchObject({ jobClass: "Job" });
  });

  it("fail() removes the job from the queue and records it", async () => {
    const d = await driver();
    await d.push("Job", { n: 1 });
    const job = await d.pop();
    await d.fail(job!, new Error("boom"));
    expect(await d.pop()).toBeUndefined();
    expect(await d.size()).toBe(0);
  });

  it("two concurrent pop()s never reserve the same job", async () => {
    const d = await driver();
    await d.push("Job", { n: 1 });

    const [a, b] = await Promise.all([d.pop(), d.pop()]);
    const popped = [a, b].filter(Boolean);
    expect(popped).toHaveLength(1);
  });

  describe("reclaiming abandoned jobs (retryAfter)", () => {
    it("does not reclaim a job still inside its visibility window", async () => {
      const d = await driver(undefined, { retryAfterSeconds: 90 });
      await d.push("Job", { n: 1 });

      // Reserved and never acked, but the worker holding it is still
      // presumed alive.
      expect(await d.pop()).toBeDefined();
      expect(await d.pop()).toBeUndefined();
    });

    it("reclaims a job whose worker died, with attempts + 1", async () => {
      // A visibility timeout of zero: the reservation is expired the
      // instant it is made, which is what a dead worker looks like
      // without the test having to wait 90 seconds.
      const d = await driver(undefined, { retryAfterSeconds: 0 });
      await d.push("Job", { n: 1 });

      const first = await d.pop();
      expect(first?.attempts).toBe(0);

      const reclaimed = await d.pop();
      expect(reclaimed?.state).toEqual({ n: 1 });
      expect(reclaimed?.attempts).toBe(1);
    });

    it("keeps incrementing attempts across repeated reclaims, so it is bounded", async () => {
      const d = await driver(undefined, { retryAfterSeconds: 0 });
      await d.push("Job", { n: 1 });

      await d.pop();
      await d.pop();
      expect((await d.pop())?.attempts).toBe(2);
    });

    it("preserves a reclaimed job's chain", async () => {
      const d = await driver(undefined, { retryAfterSeconds: 0 });
      await d.push("Job", { n: 1 }, { chain: [{ jobClass: "Next", state: { n: 2 } }] });

      await d.pop();
      expect((await d.pop())?.chain).toEqual([{ jobClass: "Next", state: { n: 2 } }]);
    });

    it("a deleted job is never reclaimed, however long it takes", async () => {
      const d = await driver(undefined, { retryAfterSeconds: 0 });
      await d.push("Job", { n: 1 });

      const job = await d.pop();
      await d.delete(job!);

      expect(await d.pop()).toBeUndefined();
    });
  });

  describe("named queues", () => {
    it("pop() only sees the queue it was asked for", async () => {
      const d = await driver();
      await d.push("Job", { n: 1 }, { queue: "emails" });
      await d.push("Job", { n: 2 }, { queue: "reports" });

      const email = await d.pop("emails");
      expect(email?.state).toEqual({ n: 1 });
      expect(email?.queue).toBe("emails");
      expect(await d.pop("emails")).toBeUndefined();
      expect((await d.pop("reports"))?.state).toEqual({ n: 2 });
    });

    it("release() puts the job back on its own queue", async () => {
      const d = await driver();
      await d.push("Job", { n: 1 }, { queue: "emails" });

      const job = await d.pop("emails");
      await d.release(job!);

      expect(await d.pop("default")).toBeUndefined();
      expect((await d.pop("emails"))?.attempts).toBe(1);
    });

    it("clear() removes ready and delayed jobs on one queue only", async () => {
      const d = await driver();
      await d.push("Job", { n: 1 }, { queue: "emails" });
      await d.push("Job", { n: 2 }, { queue: "emails", delaySeconds: 3600 });
      await d.push("Job", { n: 3 }, { queue: "reports" });

      expect(await d.clear("emails")).toBe(2);
      expect(await d.pop("emails")).toBeUndefined();
      expect(await d.pop("reports")).toBeDefined();
    });
  });

  describe("failed jobs", () => {
    it("implements the failed-job repository the queue:* commands need", async () => {
      const d = await driver();
      await d.push("Job", { n: 1 });
      const job = await d.pop();
      await d.fail(job!, new Error("boom"));

      const failed = await d.listFailed();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ id: job!.id, jobClass: "Job", connection: "redis" });
      expect(await d.findFailed(String(job!.id))).toBeDefined();
    });

    it("stores the full stack trace, not just the message", async () => {
      const d = await driver();
      await d.push("Job", {});
      const job = await d.pop();

      const error = new Error("boom");
      await d.fail(job!, error);

      const [record] = await d.listFailed();
      expect(record?.error).toBe(error.stack);
      expect(record?.error).toContain("boom");
    });

    it("retry() re-queues the job with its chain and drops the failed record", async () => {
      const d = await driver();
      await d.push("Job", { n: 1 }, { chain: [{ jobClass: "Next", state: { n: 2 } }] });
      const job = await d.pop();
      await d.fail(job!, new Error("boom"));

      expect(await d.retry(String(job!.id))).toBe(true);
      expect(await d.findFailed(String(job!.id))).toBeUndefined();

      const requeued = await d.pop();
      expect(requeued?.attempts).toBe(0);
      expect(requeued?.chain).toEqual([{ jobClass: "Next", state: { n: 2 } }]);
    });

    it("retry() returns false for an unknown id", async () => {
      const d = await driver();
      expect(await d.retry("nope")).toBe(false);
    });

    it("forget() deletes one failed job", async () => {
      const d = await driver();
      await d.push("Job", {});
      const job = await d.pop();
      await d.fail(job!, new Error("boom"));

      expect(await d.forget(String(job!.id))).toBe(true);
      expect(await d.forget(String(job!.id))).toBe(false);
      expect(await d.listFailed()).toEqual([]);
    });

    it("flush() removes everything, and flush(hours) only what is old enough", async () => {
      const d = await driver();

      for (const n of [1, 2]) {
        await d.push("Job", { n });
        const job = await d.pop();
        await d.fail(job!, new Error("boom"));
      }

      expect(await d.flush(1)).toBe(0); // nothing is an hour old yet
      expect(await d.flush()).toBe(2);
      expect(await d.listFailed()).toEqual([]);
    });

    it("sees failed jobs on a NON-default queue too", async () => {
      // A job that failed on another queue lands in that queue's failed
      // hash; the repository methods must span every queue, not just the
      // driver's default one.
      const d = await driver();
      await d.push("Job", { n: 1 }, { queue: "emails" });
      const job = await d.pop("emails");
      await d.fail(job!, new Error("boom"));

      // Visible to list/find despite being on "emails", not the default.
      const failed = await d.listFailed();
      expect(failed.map((r) => r.id)).toContain(job!.id);
      expect(await d.findFailed(String(job!.id))).toBeDefined();

      // retry() locates it across queues and re-enqueues on "emails".
      expect(await d.retry(String(job!.id))).toBe(true);
      expect(await d.findFailed(String(job!.id))).toBeUndefined();
      const requeued = await d.pop("emails");
      expect(requeued?.jobClass).toBe("Job");
    });

    it("forget() and flush() reach a non-default queue's failed jobs", async () => {
      const d = await driver();
      await d.push("Job", {}, { queue: "reports" });
      const job = await d.pop("reports");
      await d.fail(job!, new Error("boom"));

      expect(await d.forget(String(job!.id))).toBe(true);
      expect(await d.listFailed()).toEqual([]);

      // And flush() sweeps them too.
      await d.push("Job", {}, { queue: "reports" });
      const job2 = await d.pop("reports");
      await d.fail(job2!, new Error("boom"));
      expect(await d.flush()).toBe(1);
      expect(await d.listFailed()).toEqual([]);
    });
  });

  describe("key layout", () => {
    it("hash-tags every key so a Redis Cluster keeps them in one slot", async () => {
      const connection = await testConnection();
      connections.push(connection);
      const d = new RedisQueueDriver(connection, "emails");

      await d.push("Job", {});
      const job = await d.pop();
      await d.fail(job!, new Error("boom"));
      await d.push("Job", {}, { delaySeconds: 3600 });

      // Every Lua script here is multi-key; without a shared hash tag
      // they'd land in different slots and Cluster would reject them.
      const keys = await connection.client().keys("*queues*");
      expect(keys.length).toBeGreaterThan(0);

      for (const key of keys) {
        expect(key).toContain("{emails}");
      }
    });
  });

  describe("script caching", () => {
    it("recovers when the server forgets its script cache mid-run", async () => {
      const connection = await testConnection();
      connections.push(connection);
      const d = new RedisQueueDriver(connection, `q-${Math.random().toString(36).slice(2)}`);

      await d.push("Job", { n: 1 });
      expect(await d.pop()).toBeDefined();

      // What a server restart (or someone else's SCRIPT FLUSH) looks like
      // to a driver holding cached SHAs.
      await connection.client().script("FLUSH");

      await d.push("Job", { n: 2 });
      expect((await d.pop())?.state).toEqual({ n: 2 });
    });
  });
});
