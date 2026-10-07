import { describe, expect, it } from "vitest";
import { FakeQueueDriver } from "../../src/drivers/fake-queue-driver.js";
import { Job } from "../../src/job.js";
import { JobRegistry } from "../../src/job-registry.js";

describe("FakeQueueDriver", () => {
  it("records pushes without executing anything, and pop() stays empty", async () => {
    const driver = new FakeQueueDriver();

    await driver.push("posts:log-created", { id: "p1" });
    await driver.push("posts:log-created", { id: "p2" }, { delaySeconds: 30 });

    expect(await driver.pop()).toBeUndefined();
    expect(driver.pushed("posts:log-created")).toEqual([
      {
        jobClass: "posts:log-created",
        state: { id: "p1" },
        delaySeconds: 0,
        chain: [],
        queue: "default",
        afterCommit: false,
        priority: 0,
      },
      {
        jobClass: "posts:log-created",
        state: { id: "p2" },
        delaySeconds: 30,
        chain: [],
        queue: "default",
        afterCommit: false,
        priority: 0,
      },
    ]);
  });

  it("pushed() with no argument returns every push in order", async () => {
    const driver = new FakeQueueDriver();
    await driver.push("a", { n: 1 });
    await driver.push("b", { n: 2 });
    expect(driver.pushed().map((j) => j.jobClass)).toEqual(["a", "b"]);
  });

  it("records the priority a push asked for, so a filter can assert on it", async () => {
    const driver = new FakeQueueDriver();

    await driver.push("invoices:sync", { id: "i1" }, { priority: 10 });
    await driver.push("invoices:sync", { id: "i2" });

    // No built-in driver acts on `priority`, but a test asserting that
    // the application asked for one is asserting about its own code.
    expect(driver.pushed("invoices:sync", (job) => job.priority === 10)).toHaveLength(1);
    expect(driver.pushed("invoices:sync").map((job) => job.priority)).toEqual([10, 0]);
  });

  it("pushed() accepts a filter predicate", async () => {
    const driver = new FakeQueueDriver();
    await driver.push("emails:send", { to: "a@x.com" });
    await driver.push("emails:send", { to: "b@x.com" });

    const matches = driver.pushed(
      "emails:send",
      (j) => (j.state as { to: string }).to === "b@x.com",
    );
    expect(matches).toHaveLength(1);
  });

  it("assertPushed passes when present, throws when absent", async () => {
    const driver = new FakeQueueDriver();
    await driver.push("posts:log-created", { id: "p1" });

    expect(() => driver.assertPushed("posts:log-created")).not.toThrow();
    expect(() =>
      driver.assertPushed("posts:log-created", (j) => (j.state as { id: string }).id === "p1"),
    ).not.toThrow();
    expect(() => driver.assertPushed("emails:send")).toThrow(/emails:send.*not/s);
    expect(() =>
      driver.assertPushed("posts:log-created", (j) => (j.state as { id: string }).id === "nope"),
    ).toThrow(/matching the given filter/);
  });

  it("assertNotPushed passes when absent, throws when present", async () => {
    const driver = new FakeQueueDriver();
    await driver.push("posts:log-created", { id: "p1" });

    expect(() => driver.assertNotPushed("emails:send")).not.toThrow();
    expect(() => driver.assertNotPushed("posts:log-created")).toThrow();
    // filter that doesn't match => not pushed (matching) => passes
    expect(() =>
      driver.assertNotPushed(
        "posts:log-created",
        (j) => (j.state as { id: string }).id === "other",
      ),
    ).not.toThrow();
  });

  it("assertNothingPushed and reset()", async () => {
    const driver = new FakeQueueDriver();
    expect(() => driver.assertNothingPushed()).not.toThrow();

    await driver.push("a", { n: 1 });
    expect(() => driver.assertNothingPushed()).toThrow();

    driver.reset();
    expect(() => driver.assertNothingPushed()).not.toThrow();
    expect(driver.pushed()).toEqual([]);
  });

  it("release/delete/fail are no-ops", async () => {
    const driver = new FakeQueueDriver();
    const job = { id: "x", jobClass: "a", state: {}, attempts: 0 };
    await expect(driver.release(job)).resolves.toBeUndefined();
    await expect(driver.delete(job)).resolves.toBeUndefined();
    await expect(driver.fail(job, new Error("boom"))).resolves.toBeUndefined();
  });

  describe("assertPushedTimes", () => {
    it("passes on the exact count and throws otherwise", async () => {
      const driver = new FakeQueueDriver();
      await driver.push("posts:log-created", { id: "p1" });
      await driver.push("posts:log-created", { id: "p2" });

      expect(() => driver.assertPushedTimes("posts:log-created", 2)).not.toThrow();
      expect(() => driver.assertPushedTimes("posts:log-created", 1)).toThrow(
        /pushed 1 time\(s\), but it was pushed 2 time\(s\)/,
      );
    });

    it("counts zero for a job never pushed", async () => {
      const driver = new FakeQueueDriver();
      expect(() => driver.assertPushedTimes("emails:send", 0)).not.toThrow();
    });

    it("honours a filter", async () => {
      const driver = new FakeQueueDriver();
      await driver.push("emails:send", { to: "a@x.com" });
      await driver.push("emails:send", { to: "b@x.com" });

      expect(() =>
        driver.assertPushedTimes(
          "emails:send",
          1,
          (j) => (j.state as { to: string }).to === "a@x.com",
        ),
      ).not.toThrow();
    });
  });

  /**
   * Asserting by job CLASS rather than by its registered name string,
   * the form that survives a rename and turns a typo into a compile
   * error instead of a silently-passing assertNotPushed().
   */
  describe("asserting by job class", () => {
    class LogPostCreatedJob extends Job {
      handle(): void {}
    }
    class NeverDispatchedJob extends Job {
      handle(): void {}
    }

    function driverWithRegistry(): FakeQueueDriver {
      const registry = new JobRegistry();
      registry.register("posts:log-created", LogPostCreatedJob);
      registry.register("posts:never", NeverDispatchedJob);

      return new FakeQueueDriver(registry);
    }

    it("resolves a class to its registered name for pushed()/assertPushed()", async () => {
      const driver = driverWithRegistry();
      await driver.push("posts:log-created", { id: "p1" });

      expect(driver.pushed(LogPostCreatedJob)).toHaveLength(1);
      expect(() => driver.assertPushed(LogPostCreatedJob)).not.toThrow();
      expect(() => driver.assertNotPushed(NeverDispatchedJob)).not.toThrow();
      expect(() => driver.assertPushedTimes(LogPostCreatedJob, 1)).not.toThrow();
    });

    it("reports the registered name in failure messages", async () => {
      const driver = driverWithRegistry();

      expect(() => driver.assertPushed(LogPostCreatedJob)).toThrow(/posts:log-created/);
    });

    it("class and name forms are interchangeable", async () => {
      const driver = driverWithRegistry();
      await driver.push("posts:log-created", { id: "p1" });

      expect(driver.pushed(LogPostCreatedJob)).toEqual(driver.pushed("posts:log-created"));
    });

    it("explains itself when the driver has no registry rather than matching nothing", async () => {
      const driver = new FakeQueueDriver();
      await driver.push("posts:log-created", { id: "p1" });

      // The dangerous silent failure would be assertNotPushed(SomeClass)
      // passing simply because the class couldn't be resolved.
      expect(() => driver.assertNotPushed(LogPostCreatedJob)).toThrow(/without a JobRegistry/);
    });

    it("still throws JobRegistry's own error for an unregistered class", async () => {
      const driver = driverWithRegistry();
      class UnregisteredJob extends Job {
        handle(): void {}
      }

      expect(() => driver.assertPushed(UnregisteredJob)).toThrow(/not registered/);
    });
  });
});
