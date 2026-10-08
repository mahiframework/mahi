import { Application, CACHE_TOKEN } from "@mahiframework/core";
import { ArrayCacheStore, CacheManager } from "@mahiframework/cache";
import { MODEL_REGISTRY_TOKEN } from "@mahiframework/database";
import { describe, expect, it } from "vitest";
import { QUEUE_RESTART_KEY } from "../../src/restart-signal.js";
import { QueueWorkCommand } from "../../src/commands/queue-work.js";
import { QueueManager } from "../../src/queue-manager.js";
import { JobRegistry } from "../../src/job-registry.js";
import { Job } from "../../src/job.js";
import { ReleaseJobError } from "../../src/middleware/release-job-error.js";
import type { JobMiddleware } from "../../src/middleware/job-middleware.js";
import { QUEUE_TOKEN, JOB_REGISTRY_TOKEN } from "../../src/tokens.js";
import type { PushOptions, QueueDriver, QueuedJob } from "../../src/queue-driver.js";
import { EventDispatcher, EVENTS_TOKEN } from "@mahiframework/events";
import { JobProcessing, JobProcessed, JobFailed, JobReleased } from "../../src/job-events.js";

class HandledJob extends Job {
  static calls: unknown[] = [];
  constructor(public readonly n?: number) {
    super();
  }
  handle(): void {
    HandledJob.calls.push({ n: this.n });
  }
}

class FailingJob extends Job {
  maxAttempts = 1;
  static failedCalls = 0;
  handle(): void {
    throw new Error("kaboom");
  }
  failed(): void {
    FailingJob.failedCalls += 1;
  }
}

/** A queue of pre-seeded jobs, then `undefined` forever, no real timers/IO. */
class FakeDriver implements QueueDriver {
  popped: QueuedJob[] = [];
  deleted: QueuedJob[] = [];
  released: QueuedJob[] = [];
  releaseDelays: number[] = [];
  failed: QueuedJob[] = [];
  failErrors: Error[] = [];
  pushed: { jobClass: string; options: PushOptions }[] = [];
  /** Queue names `pop()` was asked for, in order. */
  poppedQueues: (string | undefined)[] = [];
  /** Errors to throw from the next `pop()` calls, shifted one per call. */
  popErrors: (Error | undefined)[] = [];
  private queue: QueuedJob[];

  constructor(jobs: QueuedJob[]) {
    this.queue = jobs;
  }

  async push(jobClass: string, _state: unknown, options: PushOptions = {}): Promise<void> {
    this.pushed.push({ jobClass, options });
  }

  async pop(queue?: string): Promise<QueuedJob | undefined> {
    this.poppedQueues.push(queue);

    const error = this.popErrors.shift();

    if (error) {
      throw error;
    }

    const job = this.queue.shift();

    if (job) {
      this.popped.push(job);
    }

    return job;
  }

  async release(job: QueuedJob, delaySeconds = 0): Promise<void> {
    this.released.push(job);
    this.releaseDelays.push(delaySeconds);
  }

  async delete(job: QueuedJob): Promise<void> {
    this.deleted.push(job);
  }

  async fail(job: QueuedJob, error: Error): Promise<void> {
    this.failed.push(job);
    this.failErrors.push(error);
  }
}

/**
 * A `ModelRegistry` whose models resolve but whose rows are all gone.
 * `findMany()` returns nothing, so `decodeModels()` raises
 * `ModelNotFoundError` (the default `deleteWhenMissingModels: false`
 * path). Exactly what a job holding a since-deleted model looks like.
 */
function missingModelRegistry(): any {
  return {
    resolve: () => ({
      name: "User",
      deleteWhenMissingModels: false,
      async findMany() {
        return { all: () => [] };
      },
    }),
    nameFor: () => undefined,
  };
}

function buildApp(driver: FakeDriver, registry: JobRegistry): Application {
  const app = new Application();
  const manager = new QueueManager(app, { default: "fake", connections: { fake: {} } });
  manager.extend("fake", () => driver);
  app.instance(QUEUE_TOKEN, manager);
  app.instance(JOB_REGISTRY_TOKEN, registry);

  return app;
}

describe("QueueWorkCommand", () => {
  it("processes exactly one job and stops when --once is passed with a job available", async () => {
    HandledJob.calls = [];
    const registry = new JobRegistry();
    registry.register("handled", HandledJob);

    const job: QueuedJob = { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(HandledJob.calls).toEqual([{ n: 1 }]);
    expect(driver.deleted).toEqual([job]);
  });

  it("--once with no job available returns without processing anything (no busy-loop)", async () => {
    const registry = new JobRegistry();
    const driver = new FakeDriver([]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.popped).toEqual([]);
  });

  it("releases a throwing job for retry when it hasn't exhausted maxAttempts", async () => {
    class RetryableJob extends Job {
      maxAttempts = 3;
      handle(): void {
        throw new Error("transient");
      }
    }
    const registry = new JobRegistry();
    registry.register("retryable", RetryableJob);

    const job: QueuedJob = { id: "2", jobClass: "retryable", state: {}, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.released).toEqual([job]);
    expect(driver.failed).toEqual([]);
  });

  it("moves a job to failed after exhausting maxAttempts and calls job.failed()", async () => {
    FailingJob.failedCalls = 0;
    const registry = new JobRegistry();
    registry.register("failing", FailingJob);

    // FailingJob customizes maxAttempts = 1 (an own field), so its
    // serialized state carries it, mirror what encodeJob would produce.
    const job: QueuedJob = { id: "3", jobClass: "failing", state: { maxAttempts: 1 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.failed).toEqual([job]);
    expect(FailingJob.failedCalls).toBe(1);
  });

  it("fails immediately (no crash) when the job class is not registered", async () => {
    const registry = new JobRegistry();
    const job: QueuedJob = { id: "4", jobClass: "unknown", state: {}, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.failed).toEqual([job]);
  });

  it("stops the work loop gracefully on SIGTERM, finishing the in-flight job first", async () => {
    HandledJob.calls = [];
    const registry = new JobRegistry();
    registry.register("handled", HandledJob);

    // Sending the signal from inside the first job's own handle() call
    // guarantees it's delivered strictly between "first job processed"
    // and "second job popped", with no timing race.
    class SignalingJob extends Job {
      constructor(public readonly n?: number) {
        super();
      }
      handle(): void {
        HandledJob.calls.push({ n: this.n });
        process.emit("SIGTERM");
      }
    }
    registry.register("signaling", SignalingJob);

    // Captured up front: `FakeDriver.pop()` mutates the array it's
    // constructed with via `.shift()`, so `jobs[0]`/`jobs[1]` would no
    // longer point at the original entries by the time we assert below.
    const firstJob: QueuedJob = { id: "1", jobClass: "signaling", state: { n: 1 }, attempts: 0 };
    const secondJob: QueuedJob = { id: "2", jobClass: "handled", state: { n: 2 }, attempts: 0 };
    const driver = new FakeDriver([firstJob, secondJob]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    // Not --once. The loop would otherwise keep polling forever;
    // SIGTERM (emitted by the first job itself, above) is expected to
    // stop it before the second job is popped.
    await command.handle({ connection: "fake", sleep: "0" });

    expect(HandledJob.calls).toEqual([{ n: 1 }]);
    expect(driver.deleted).toEqual([firstJob]);
    expect(driver.popped).toEqual([firstJob]);
  });

  it("stops the work loop gracefully on SIGINT", async () => {
    HandledJob.calls = [];
    const registry = new JobRegistry();
    registry.register("handled", HandledJob);

    class SignalingJob extends Job {
      constructor(public readonly n?: number) {
        super();
      }
      handle(): void {
        HandledJob.calls.push({ n: this.n });
        process.emit("SIGINT");
      }
    }
    registry.register("signaling", SignalingJob);

    const jobs: QueuedJob[] = [
      { id: "1", jobClass: "signaling", state: { n: 1 }, attempts: 0 },
      { id: "2", jobClass: "handled", state: { n: 2 }, attempts: 0 },
    ];
    const driver = new FakeDriver(jobs);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0" });

    expect(HandledJob.calls).toEqual([{ n: 1 }]);
  });

  it("releases (does not fail) a job when a middleware throws ReleaseJobError", async () => {
    class RateLimitMiddleware implements JobMiddleware {
      async handle(): Promise<void> {
        throw new ReleaseJobError(30);
      }
    }
    class GatedJob extends Job {
      static ran = 0;
      maxAttempts = 1; // would normally fail immediately on any thrown error
      middleware(): JobMiddleware[] {
        return [new RateLimitMiddleware()];
      }
      handle(): void {
        GatedJob.ran += 1;
      }
    }
    GatedJob.ran = 0;
    const registry = new JobRegistry();
    registry.register("gated", GatedJob);

    const job: QueuedJob = { id: "1", jobClass: "gated", state: {}, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(GatedJob.ran).toBe(0);
    expect(driver.released).toEqual([job]);
    expect(driver.failed).toEqual([]);
    expect(driver.deleted).toEqual([]);
  });

  it("removes its SIGINT/SIGTERM listeners once handle() resolves (no leaked listeners)", async () => {
    const registry = new JobRegistry();
    const driver = new FakeDriver([]);
    const app = buildApp(driver, registry);
    const command = new QueueWorkCommand(app);

    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  it("uses a job's backoff() override for the release delay instead of the default", async () => {
    class BackoffJob extends Job {
      maxAttempts = 3;
      backoff(attempts: number): number {
        return attempts * 100;
      }
      handle(): void {
        throw new Error("transient");
      }
    }
    const registry = new JobRegistry();
    registry.register("backoff", BackoffJob);

    // attempts=0 on the record → next attempt is 1 → 1*100 = 100s.
    const job: QueuedJob = { id: "1", jobClass: "backoff", state: {}, attempts: 0 };
    const driver = new FakeDriver([job]);
    const command = new QueueWorkCommand(buildApp(driver, registry));

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.released).toEqual([job]);
    expect(driver.releaseDelays).toEqual([100]);
  });

  it("fails a job immediately once its retryUntil() deadline has passed, even with attempts left", async () => {
    class DeadlineJob extends Job {
      maxAttempts = 5;
      retryUntil(): number {
        return Date.now() - 1000; // already past
      }
      handle(): void {
        throw new Error("nope");
      }
    }
    const registry = new JobRegistry();
    registry.register("deadline", DeadlineJob);

    const job: QueuedJob = { id: "1", jobClass: "deadline", state: {}, attempts: 0 };
    const driver = new FakeDriver([job]);
    const command = new QueueWorkCommand(buildApp(driver, registry));

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.failed).toEqual([job]);
    expect(driver.released).toEqual([]);
  });

  it("times out a slow job via its timeout() and treats it as a failure", async () => {
    class SlowJob extends Job {
      maxAttempts = 1;
      timeout(): number {
        return 0.01; // 10ms
      }
      async handle(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const registry = new JobRegistry();
    registry.register("slow", SlowJob);

    const job: QueuedJob = { id: "1", jobClass: "slow", state: { maxAttempts: 1 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const command = new QueueWorkCommand(buildApp(driver, registry));

    await command.handle({ connection: "fake", sleep: "0", once: true });

    expect(driver.failed).toEqual([job]);
    expect(driver.failErrors[0]?.name).toBe("JobTimeoutError");
  });

  it("dispatches JobProcessing/JobProcessed lifecycle events when an events provider is registered", async () => {
    HandledJob.calls = [];
    const registry = new JobRegistry();
    registry.register("handled", HandledJob);

    const job: QueuedJob = { id: "1", jobClass: "handled", state: { n: 7 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);

    const dispatcher = new EventDispatcher(app);
    const seen: string[] = [];
    dispatcher.listen("JobProcessing", (e) => {
      seen.push(`processing:${(e as JobProcessing).queued.id}`);
    });
    dispatcher.listen("JobProcessed", (e) => {
      seen.push(`processed:${(e as JobProcessed).queued.id}`);
    });
    app.instance(EVENTS_TOKEN, dispatcher);

    await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true });

    expect(seen).toEqual(["processing:1", "processed:1"]);
  });

  it("dispatches JobFailed when a job exhausts its attempts", async () => {
    FailingJob.failedCalls = 0;
    const registry = new JobRegistry();
    registry.register("failing", FailingJob);

    const job: QueuedJob = { id: "9", jobClass: "failing", state: { maxAttempts: 1 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);

    const dispatcher = new EventDispatcher(app);
    let failedEvent: JobFailed | undefined;
    dispatcher.listen("JobFailed", (e) => {
      failedEvent = e as JobFailed;
    });
    app.instance(EVENTS_TOKEN, dispatcher);

    await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true });

    expect(failedEvent?.queued.id).toBe("9");
    expect(failedEvent?.error.message).toBe("kaboom");
  });

  /**
   * Every started attempt must reach exactly one terminal event.
   * A release ends the attempt as surely as success or failure does, and
   * without an event for it a consumer that pairs
   * `JobProcessing`/terminal, run history, an in-flight gauge, counts
   * the attempt as running forever.
   */
  it("dispatches JobReleased when a middleware releases the job", async () => {
    class RateLimitMiddleware implements JobMiddleware {
      async handle(): Promise<void> {
        throw new ReleaseJobError(30);
      }
    }
    class GatedJob extends Job {
      maxAttempts = 3;
      middleware(): JobMiddleware[] {
        return [new RateLimitMiddleware()];
      }
      handle(): void {}
    }
    const registry = new JobRegistry();
    registry.register("gated", GatedJob);

    const job: QueuedJob = { id: "4", jobClass: "gated", state: { maxAttempts: 3 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);

    const dispatcher = new EventDispatcher(app);
    const seen: string[] = [];
    let released: JobReleased | undefined;
    dispatcher.listen("JobProcessing", () => void seen.push("processing"));
    dispatcher.listen("JobReleased", (e) => {
      released = e as JobReleased;
      seen.push("released");
    });
    app.instance(EVENTS_TOKEN, dispatcher);

    await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true });

    expect(seen).toEqual(["processing", "released"]);
    expect(released?.queued.id).toBe("4");
    // The delay the driver was asked for, which on a FIFO process is also
    // how long the whole process pauses.
    expect(released?.delaySeconds).toBe(30);
  });

  /**
   * The other release path: an ordinary thrown error with attempts still
   * remaining is retried by releasing, so it closes the attempt the same
   * way. `JobFailed` is reserved for the attempt that exhausts the budget.
   */
  it("dispatches JobReleased when a retryable failure is rescheduled", async () => {
    class FlakyJob extends Job {
      maxAttempts = 3;
      handle(): void {
        throw new Error("transient");
      }
      backoff(): number {
        return 12;
      }
    }
    const registry = new JobRegistry();
    registry.register("flaky", FlakyJob);

    const job: QueuedJob = { id: "5", jobClass: "flaky", state: { maxAttempts: 3 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);

    const dispatcher = new EventDispatcher(app);
    let released: JobReleased | undefined;
    let failed: JobFailed | undefined;
    dispatcher.listen("JobReleased", (e) => {
      released = e as JobReleased;
    });
    dispatcher.listen("JobFailed", (e) => {
      failed = e as JobFailed;
    });
    app.instance(EVENTS_TOKEN, dispatcher);

    await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true });

    expect(released?.queued.id).toBe("5");
    expect(released?.delaySeconds).toBe(12);
    // Attempts remain, so this is not a failure yet.
    expect(failed).toBeUndefined();
  });

  /** The attempt that exhausts the budget fails; it is not released. */
  it("dispatches JobFailed, not JobReleased, once a released job runs out of attempts", async () => {
    class GatedJob extends Job {
      maxAttempts = 3;
      middleware(): JobMiddleware[] {
        return [
          {
            async handle(): Promise<void> {
              throw new ReleaseJobError(5);
            },
          },
        ];
      }
      handle(): void {}
    }
    const registry = new JobRegistry();
    registry.register("gated-once", GatedJob);

    // Already on the last attempt, so releasing again would mean never
    // running: the release has to become a visible failure instead.
    const job: QueuedJob = {
      id: "6",
      jobClass: "gated-once",
      state: { maxAttempts: 3 },
      attempts: 2,
    };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);

    const dispatcher = new EventDispatcher(app);
    const seen: string[] = [];
    dispatcher.listen("JobReleased", () => void seen.push("released"));
    dispatcher.listen("JobFailed", () => void seen.push("failed"));
    app.instance(EVENTS_TOKEN, dispatcher);

    await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true });

    expect(seen).toEqual(["failed"]);
  });

  it("a throwing lifecycle listener does not derail the worker (job still completes)", async () => {
    HandledJob.calls = [];
    const registry = new JobRegistry();
    registry.register("handled", HandledJob);

    const job: QueuedJob = { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 };
    const driver = new FakeDriver([job]);
    const app = buildApp(driver, registry);

    const dispatcher = new EventDispatcher(app);
    dispatcher.listen("JobProcessing", () => {
      throw new Error("listener boom");
    });
    app.instance(EVENTS_TOKEN, dispatcher);

    await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true });

    expect(HandledJob.calls).toEqual([{ n: 1 }]);
    expect(driver.deleted).toEqual([job]);
  });

  describe("the worker survives everything it can", () => {
    it("fails (does not crash on) a job whose payload references a deleted model", async () => {
      // What `decodeJob` throws when a referenced row is gone and the
      // model's `deleteWhenMissingModels` is false, the DEFAULT. It must
      // not escape processJob(): that would unwind handle() and kill the
      // process, stranding the job reserved forever.
      class MissingModelJob extends Job {
        handle(): void {}
      }
      const registry = new JobRegistry();
      registry.register("missing", MissingModelJob);

      // The payload references a model row that has since been deleted.
      const job: QueuedJob = {
        id: "1",
        jobClass: "missing",
        state: { user: { __model: "user", __id: 42 } },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);
      const app = buildApp(driver, registry);
      app.instance(MODEL_REGISTRY_TOKEN, missingModelRegistry());

      await expect(
        new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true }),
      ).resolves.toBeUndefined();

      expect(driver.failed).toEqual([job]);
      expect(driver.deleted).toEqual([]);
    });

    it("keeps working after a decode failure instead of stopping the loop", async () => {
      class MissingModelJob extends Job {
        handle(): void {}
      }
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("missing", MissingModelJob);
      registry.register("handled", HandledJob);

      // Only the first job references the deleted model; the second is
      // ordinary work that must still get done.
      const bad: QueuedJob = {
        id: "1",
        jobClass: "missing",
        state: { user: { __model: "user", __id: 42 } },
        attempts: 0,
      };
      const good: QueuedJob = { id: "2", jobClass: "handled", state: { n: 2 }, attempts: 0 };
      const driver = new FakeDriver([bad, good]);
      const app = buildApp(driver, registry);
      app.instance(MODEL_REGISTRY_TOKEN, missingModelRegistry());

      await new QueueWorkCommand(app).handle({
        connection: "fake",
        sleep: "0",
        maxJobs: "2",
      });

      expect(driver.failed).toEqual([bad]);
      expect(HandledJob.calls).toEqual([{ n: 2 }]);
    });

    it("logs and pauses (does not exit) when pop() itself throws", async () => {
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const job: QueuedJob = { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 };
      const driver = new FakeDriver([job]);
      // The database went away for one poll, then came back.
      driver.popErrors = [new Error("SQLITE_BUSY: database is locked")];

      const app = buildApp(driver, registry);
      const logged: unknown[] = [];
      app.logger.error = (message: string) => {
        logged.push(message);
      };

      await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", maxJobs: "1" });

      expect(logged.some((m) => String(m).includes("failed to reserve"))).toBe(true);
      // And the job that was there all along still ran.
      expect(HandledJob.calls).toEqual([{ n: 1 }]);
    });

    it("a throwing failed() hook does not kill the worker", async () => {
      class BadHookJob extends Job {
        maxAttempts = 1;
        handle(): void {
          throw new Error("kaboom");
        }
        failed(): void {
          throw new Error("the hook is broken too");
        }
      }
      const registry = new JobRegistry();
      registry.register("bad-hook", BadHookJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "bad-hook",
        state: { maxAttempts: 1 },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);
      const app = buildApp(driver, registry);
      app.logger.error = () => {};

      await expect(
        new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0", once: true }),
      ).resolves.toBeUndefined();

      // The failure was still recorded, the broken hook only cost a log line.
      expect(driver.failed).toEqual([job]);
      expect(driver.failErrors[0]?.message).toBe("kaboom");
    });
  });

  describe("attempts are bounded on every path", () => {
    it("fails a job popped with its attempts already exhausted, without running it", async () => {
      class NeverFinishesJob extends Job {
        static ran = 0;
        maxAttempts = 3;
        handle(): void {
          NeverFinishesJob.ran += 1;
        }
      }
      NeverFinishesJob.ran = 0;
      const registry = new JobRegistry();
      registry.register("never", NeverFinishesJob);

      // Reclaimed three times after killing its workers. It never threw,
      // so nothing ever routed it to failed_jobs. Without a pre-run check
      // it cycles reserve → reclaim forever.
      const job: QueuedJob = { id: "1", jobClass: "never", state: { maxAttempts: 3 }, attempts: 3 };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
      });

      expect(NeverFinishesJob.ran).toBe(0);
      expect(driver.failed).toEqual([job]);
      expect(driver.failErrors[0]?.name).toBe("MaxAttemptsExceededError");
    });

    it("bounds a ReleaseJobError loop by maxAttempts instead of releasing forever", async () => {
      class AlwaysLockedJob extends Job {
        maxAttempts = 3;
        middleware(): JobMiddleware[] {
          return [
            {
              async handle(): Promise<void> {
                throw new ReleaseJobError(0);
              },
            },
          ];
        }
        handle(): void {}
      }
      const registry = new JobRegistry();
      registry.register("locked", AlwaysLockedJob);

      // Last attempt: releasing again would be attempt 3 of 3, i.e. never
      // running. A permanently-held lock has to become a visible failure.
      const job: QueuedJob = {
        id: "1",
        jobClass: "locked",
        state: { maxAttempts: 3 },
        attempts: 2,
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
      });

      expect(driver.released).toEqual([]);
      expect(driver.failed).toEqual([job]);
      expect(driver.failErrors[0]?.name).toBe("ReleaseJobError");
    });

    it("still releases a ReleaseJobError job while attempts remain", async () => {
      class LockedOnceJob extends Job {
        maxAttempts = 3;
        middleware(): JobMiddleware[] {
          return [
            {
              async handle(): Promise<void> {
                throw new ReleaseJobError(7);
              },
            },
          ];
        }
        handle(): void {}
      }
      const registry = new JobRegistry();
      registry.register("locked-once", LockedOnceJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "locked-once",
        state: { maxAttempts: 3 },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
      });

      expect(driver.released).toEqual([job]);
      expect(driver.releaseDelays).toEqual([7]);
      expect(driver.failed).toEqual([]);
    });

    it("--tries overrides the job's own maxAttempts", async () => {
      class RetryableJob extends Job {
        maxAttempts = 10;
        handle(): void {
          throw new Error("transient");
        }
      }
      const registry = new JobRegistry();
      registry.register("retryable", RetryableJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "retryable",
        state: { maxAttempts: 10 },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
        tries: "1",
      });

      expect(driver.failed).toEqual([job]);
      expect(driver.released).toEqual([]);
    });
  });

  describe("backoff", () => {
    it("waits before the first retry rather than retrying instantly", async () => {
      class TransientJob extends Job {
        maxAttempts = 3;
        handle(): void {
          throw new Error("transient");
        }
      }
      const registry = new JobRegistry();
      registry.register("transient", TransientJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "transient",
        state: { maxAttempts: 3 },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
      });

      // attempt 1 just failed → 1 * 5. A pre-increment count would give
      // `0 * 5`: an immediate retry that hammers whatever just failed.
      expect(driver.releaseDelays).toEqual([5]);
    });

    it("--backoff supplies a delay for jobs that define no backoff()", async () => {
      class TransientJob extends Job {
        maxAttempts = 3;
        handle(): void {
          throw new Error("transient");
        }
      }
      const registry = new JobRegistry();
      registry.register("transient", TransientJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "transient",
        state: { maxAttempts: 3 },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
        backoff: "42",
      });

      expect(driver.releaseDelays).toEqual([42]);
    });

    it("a job's own backoff() still wins over --backoff", async () => {
      class TransientJob extends Job {
        maxAttempts = 3;
        backoff(attempts: number): number {
          return attempts * 100;
        }
        handle(): void {
          throw new Error("transient");
        }
      }
      const registry = new JobRegistry();
      registry.register("transient", TransientJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "transient",
        state: { maxAttempts: 3 },
        attempts: 0,
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
        backoff: "42",
      });

      expect(driver.releaseDelays).toEqual([100]);
    });
  });

  describe("named queues and stopping conditions", () => {
    it("passes --queue through to the driver's pop()", async () => {
      const registry = new JobRegistry();
      const driver = new FakeDriver([]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
        queue: "emails",
      });

      expect(driver.poppedQueues).toEqual(["emails"]);
    });

    it("keeps a chained job on the queue the worker is draining", async () => {
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const job: QueuedJob = {
        id: "1",
        jobClass: "handled",
        state: { n: 1 },
        attempts: 0,
        queue: "emails",
        chain: [{ jobClass: "handled", state: { n: 2 } }],
      };
      const driver = new FakeDriver([job]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        once: true,
        queue: "emails",
      });

      expect(driver.pushed).toEqual([
        { jobClass: "handled", options: { chain: [], queue: "emails" } },
      ]);
    });

    it("--max-jobs stops the loop after that many jobs", async () => {
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const driver = new FakeDriver([
        { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 },
        { id: "2", jobClass: "handled", state: { n: 2 }, attempts: 0 },
        { id: "3", jobClass: "handled", state: { n: 3 }, attempts: 0 },
      ]);

      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        maxJobs: "2",
      });

      expect(HandledJob.calls).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("--stop-when-empty exits as soon as the queue drains", async () => {
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const driver = new FakeDriver([
        { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 },
      ]);

      // No --once, and a sleep that would hang forever if the loop kept
      // polling, reaching the assertion at all is the assertion.
      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        stopWhenEmpty: true,
      });

      expect(HandledJob.calls).toEqual([{ n: 1 }]);
    });

    it("--max-time stops the loop once the deadline passes", async () => {
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const driver = new FakeDriver([]);

      // Already expired the moment the loop checks.
      await new QueueWorkCommand(buildApp(driver, registry)).handle({
        connection: "fake",
        sleep: "0",
        maxTime: "0",
      });

      expect(driver.popped).toEqual([]);
    });

    it("stops after the current job once queue:restart has been signalled", async () => {
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const driver = new FakeDriver([
        { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 },
        { id: "2", jobClass: "handled", state: { n: 2 }, attempts: 0 },
      ]);
      const app = buildApp(driver, registry);

      const cache = new CacheManager(app, { default: "array", stores: { array: {} } });
      cache.extend("array", () => new ArrayCacheStore());
      app.instance(CACHE_TOKEN, cache);

      // Signalled *after* this worker would have started.
      await cache.store().put(QUEUE_RESTART_KEY, Date.now() + 60_000);

      await new QueueWorkCommand(app).handle({ connection: "fake", sleep: "0" });

      expect(HandledJob.calls).toEqual([{ n: 1 }]);
    });

    it("ignores a restart signalled before the worker started", async () => {
      HandledJob.calls = [];
      const registry = new JobRegistry();
      registry.register("handled", HandledJob);

      const driver = new FakeDriver([
        { id: "1", jobClass: "handled", state: { n: 1 }, attempts: 0 },
        { id: "2", jobClass: "handled", state: { n: 2 }, attempts: 0 },
      ]);
      const app = buildApp(driver, registry);

      const cache = new CacheManager(app, { default: "array", stores: { array: {} } });
      cache.extend("array", () => new ArrayCacheStore());
      app.instance(CACHE_TOKEN, cache);
      await cache.store().put(QUEUE_RESTART_KEY, Date.now() - 60_000);

      await new QueueWorkCommand(app).handle({
        connection: "fake",
        sleep: "0",
        maxJobs: "2",
      });

      expect(HandledJob.calls).toEqual([{ n: 1 }, { n: 2 }]);
    });
  });
});
