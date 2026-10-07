import { afterEach, describe, expect, it } from "vitest";
import { JobFailed, JobProcessed, JobProcessing, type QueuedJob } from "@mahiframework/queue";
import { WatchtowerJobRun } from "../src/models/watchtower-job-run.model.js";
import { WatchtowerJobType } from "../src/models/watchtower-job-type.model.js";
import { RunRecorder, isTerminal, type JobRunObservation } from "../src/run-recorder.js";
import { RecordJobRunListener } from "../src/listeners/record-job-run.listener.js";
import { RECORD_JOB_RUN_JOB } from "../src/jobs/record-job-run.job.js";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
  delete process.env.MAHI_WATCHTOWER_PROCESS;
  delete process.env.MAHI_WATCHTOWER_RUN_ID;
});

const DISPATCH = "018f0000-0000-7000-8000-0000000000aa";

function observation(overrides: Partial<JobRunObservation> = {}): JobRunObservation {
  return {
    jobName: "app.jobs.sync-invoice",
    className: "SyncInvoiceJob",
    dispatchId: DISPATCH,
    invocationId: null,
    process: null,
    queue: "default",
    workerRunId: null,
    status: "running",
    attempt: 1,
    startedAt: "2026-10-07T12:00:00Z",
    finishedAt: null,
    durationMs: null,
    error: null,
    ...overrides,
  };
}

describe("RunRecorder", () => {
  it("creates the job type on first sight", async () => {
    harness = await createHarness();

    await new RunRecorder(harness.app).record(observation());

    const type = await WatchtowerJobType.findByName("app.jobs.sync-invoice").first();

    expect(type?.class_name).toBe("SyncInvoiceJob");
    expect(type?.first_seen_at).toBeDefined();
  });

  it("reuses the job type on later runs", async () => {
    harness = await createHarness();
    const recorder = new RunRecorder(harness.app);

    await recorder.record(observation({ dispatchId: dispatchId(1) }));
    await recorder.record(observation({ dispatchId: dispatchId(2) }));

    expect(await WatchtowerJobType.query().count()).toBe(1);
  });

  it("backfills a class name that was unknown on first sight", async () => {
    harness = await createHarness();
    const recorder = new RunRecorder(harness.app);

    // A run observed before its class could be resolved records null; a
    // later successful one fills it in.
    await recorder.record(observation({ className: null, dispatchId: dispatchId(1) }));
    await recorder.record(observation({ className: "SyncInvoiceJob", dispatchId: dispatchId(2) }));

    expect((await WatchtowerJobType.query().first())?.class_name).toBe("SyncInvoiceJob");
  });

  it("converges on one row when the same attempt is observed twice", async () => {
    harness = await createHarness();
    const recorder = new RunRecorder(harness.app);

    await recorder.record(observation({ status: "running" }));
    await recorder.record(
      observation({
        status: "completed",
        finishedAt: "2026-10-07T12:00:01Z",
        durationMs: 842,
      }),
    );

    const runs = await WatchtowerJobRun.query().get();

    expect(runs.all()).toHaveLength(1);
    expect(runs.all()[0]?.status).toBe("completed");
    expect(runs.all()[0]?.duration_ms).toBe(842);
  });

  it("converges when completed arrives BEFORE running", async () => {
    harness = await createHarness();
    const recorder = new RunRecorder(harness.app);

    // The queued path's real failure mode: the two observations are
    // separate queue jobs and nothing sequences them.
    await recorder.record(
      observation({ status: "completed", finishedAt: "2026-10-07T12:00:01Z", durationMs: 842 }),
    );
    await recorder.record(observation({ status: "running" }));

    const runs = (await WatchtowerJobRun.query().get()).all();

    expect(runs).toHaveLength(1);
    // A terminal status is final: a late `running` must not reopen a
    // finished run and leave it permanently in progress.
    expect(runs[0]?.status).toBe("completed");
  });

  it("keeps the started_at a late running observation supplies", async () => {
    harness = await createHarness();
    const recorder = new RunRecorder(harness.app);

    await recorder.record(
      observation({ status: "failed", startedAt: null, finishedAt: "2026-10-07T12:00:05Z" }),
    );
    await recorder.record(observation({ status: "running", startedAt: "2026-10-07T12:00:00Z" }));

    const run = await WatchtowerJobRun.query().first();

    // Fields are merged, not written wholesale, so whichever half
    // arrived first is not erased.
    expect(run?.status).toBe("failed");
    expect(run?.started_at).not.toBeNull();
    expect(run?.finished_at).not.toBeNull();
  });

  it("keeps attempts at one dispatch as separate rows", async () => {
    harness = await createHarness();
    const recorder = new RunRecorder(harness.app);

    await recorder.record(observation({ attempt: 1, status: "failed" }));
    await recorder.record(observation({ attempt: 2, status: "failed" }));
    await recorder.record(observation({ attempt: 3, status: "completed" }));

    const runs = await WatchtowerJobRun.forDispatch(DISPATCH).get();

    // "Failed twice then succeeded" is one story, told by three rows.
    expect(runs.map((run) => run.status).all()).toEqual(["failed", "failed", "completed"]);
  });

  it("stores a stack trace verbatim", async () => {
    harness = await createHarness();
    const trace = "Error: boom\n    at Foo.bar (src/foo.ts:1:1)";

    await new RunRecorder(harness.app).record(
      observation({ status: "failed", error: trace, finishedAt: "2026-10-07T12:00:01Z" }),
    );

    expect((await WatchtowerJobRun.query().first())?.error).toBe(trace);
  });

  describe("prune", () => {
    it("removes runs that finished before the cutoff", async () => {
      harness = await createHarness();
      const recorder = new RunRecorder(harness.app);

      await recorder.record(
        observation({
          attempt: 1,
          status: "completed",
          startedAt: "2020-01-01T00:00:00Z",
          finishedAt: "2020-01-01T00:00:01Z",
        }),
      );
      await recorder.record(observation({ attempt: 2, status: "completed", finishedAt: nowIso() }));

      expect(await recorder.prune(7)).toBe(1);
      expect(await WatchtowerJobRun.query().count()).toBe(1);
    });

    it("leaves an unfinished run alone", async () => {
      harness = await createHarness();
      const recorder = new RunRecorder(harness.app);

      // A `finished_at` of null is a job still running; pruning it would
      // delete the row a worker is about to update.
      await recorder.record(observation({ status: "running" }));

      expect(await recorder.prune(0)).toBe(0);
      expect(await WatchtowerJobRun.query().count()).toBe(1);
    });

    it("chunks, so a large table does not become one statement", async () => {
      harness = await createHarness();
      const recorder = new RunRecorder(harness.app);

      for (let index = 1; index <= 5; index += 1) {
        await recorder.record(
          observation({
            attempt: index,
            status: "completed",
            startedAt: "2020-01-01T00:00:00Z",
            finishedAt: "2020-01-01T00:00:01Z",
          }),
        );
      }

      expect(await recorder.prune(7, 2)).toBe(5);
      expect(await WatchtowerJobRun.query().count()).toBe(0);
    });
  });
});

describe("isTerminal", () => {
  it("treats released as terminal", () => {
    // The attempt ended; the retry is a separate row with its own
    // number. Treating it as non-terminal would let a stale `running`
    // reopen it.
    expect(isTerminal("released")).toBe(true);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("pending")).toBe(false);
  });
});

describe("RecordJobRunListener", () => {
  async function bootWith(config: Record<string, unknown> = {}): Promise<Harness> {
    harness = await createHarness();
    harness.app.config.set("watchtower", {
      recording: { queued: false, ...(config.recording as object) },
      ...config,
    });
    harness.app.register(WatchtowerServiceProvider);
    await harness.app.bootstrap();

    return harness;
  }

  function queued(overrides: Partial<QueuedJob> = {}): QueuedJob {
    return {
      id: 1n,
      jobClass: "app.jobs.sync-invoice",
      state: {},
      attempts: 0,
      queue: "default",
      ...overrides,
    };
  }

  const fakeJob = { constructor: { name: "SyncInvoiceJob" } } as never;

  it("records a job starting and finishing", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);
    const job = queued();

    await listener.handle(new JobProcessing("watchtower", fakeJob, job));
    await listener.handle(new JobProcessed("watchtower", fakeJob, job));

    const runs = (await WatchtowerJobRun.query().get()).all();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    // Measured by the listener, because nothing in the payload carries a
    // start time.
    expect(runs[0]?.duration_ms).not.toBeNull();
  });

  it("gives both observations of one attempt the same dispatch id", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);
    const job = queued();

    await listener.handle(new JobProcessing("watchtower", fakeJob, job));
    await listener.handle(new JobProcessed("watchtower", fakeJob, job));

    // On a driver with no `dispatch_id` column the id is DERIVED from the
    // queue row, deterministically. Minting one per observation would
    // give the two events different ids and produce two rows for one
    // attempt instead of upserting onto one.
    const runs = (await WatchtowerJobRun.query().get()).all();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.dispatch_id).toBe("row:1");
  });

  it("keeps two attempts at one job as separate rows", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);

    await listener.handle(new JobProcessing("watchtower", fakeJob, queued({ attempts: 0 })));
    await listener.handle(
      new JobFailed("watchtower", fakeJob, queued({ attempts: 0 }), new Error("x")),
    );
    await listener.handle(new JobProcessing("watchtower", fakeJob, queued({ attempts: 1 })));
    await listener.handle(new JobProcessed("watchtower", fakeJob, queued({ attempts: 1 })));

    const runs = (await WatchtowerJobRun.query().orderBy("attempt", "asc").get()).all();

    expect(runs.map((run) => run.attempt)).toEqual([1, 2]);
    expect(runs.map((run) => run.status)).toEqual(["failed", "completed"]);
  });

  it("records a failure with its stack trace", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);
    const job = queued();

    await listener.handle(new JobProcessing("watchtower", fakeJob, job));
    await listener.handle(
      new JobFailed("watchtower", fakeJob, job, new Error("Xero returned 429")),
    );

    const run = await WatchtowerJobRun.query().first();

    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Xero returned 429");
  });

  it("records attempt numbers 1-based", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);

    // `queued.attempts` is 0 on the first pop, so the first attempt is 1.
    await listener.handle(new JobProcessing("watchtower", fakeJob, queued({ attempts: 0 })));

    expect((await WatchtowerJobRun.query().first())?.attempt).toBe(1);
  });

  it("NEVER records its own job, however many times it runs", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);

    // The recursion guard. Running the recorder's job fires its own
    // lifecycle events, which this listener would observe by dispatching
    // another one, forever — so the count must be stable at zero, not
    // merely small. A "one row exists" assertion would pass against a
    // broken build.
    for (let round = 0; round < 3; round += 1) {
      const job = queued({ jobClass: RECORD_JOB_RUN_JOB });
      await listener.handle(new JobProcessing("watchtower", fakeJob, job));
      await listener.handle(new JobProcessed("watchtower", fakeJob, job));
    }

    expect(await WatchtowerJobRun.query().count()).toBe(0);
    expect(await WatchtowerJobType.query().count()).toBe(0);
  });

  it("ignores framework plumbing jobs", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);

    for (const jobClass of ["events.handle-queued-listener", "mail.send-queued-mail"]) {
      await listener.handle(new JobProcessing("watchtower", fakeJob, queued({ jobClass })));
    }

    // A queued listener or mail send is not work an operator thinks of
    // as a job; recording them makes the job-type list mostly noise.
    expect(await WatchtowerJobRun.query().count()).toBe(0);
  });

  it("records nothing when recording is disabled", async () => {
    await bootWith({ recording: { enabled: false } });
    const listener = new RecordJobRunListener(harness.app);

    await listener.handle(new JobProcessing("watchtower", fakeJob, queued()));

    expect(await WatchtowerJobRun.query().count()).toBe(0);
  });

  it("attributes the process and worker from the environment", async () => {
    await bootWith();
    process.env.MAHI_WATCHTOWER_PROCESS = "xero";
    process.env.MAHI_WATCHTOWER_RUN_ID = "018f0000-0000-7000-8000-00000000bbbb";

    const listener = new RecordJobRunListener(harness.app);
    await listener.handle(new JobProcessing("watchtower", fakeJob, queued()));

    const run = await WatchtowerJobRun.query().first();

    expect(run?.process).toBe("xero");
    expect(run?.worker_run_id).toBe("018f0000-0000-7000-8000-00000000bbbb");
  });

  it("leaves process null outside a supervised worker", async () => {
    await bootWith();
    const listener = new RecordJobRunListener(harness.app);

    await listener.handle(new JobProcessing("watchtower", fakeJob, queued()));

    // Honestly null rather than guessed: a bare `queue:work` or a
    // `Bus.dispatch()` has no supervised process.
    expect((await WatchtowerJobRun.query().first())?.process).toBeNull();
  });

  it("does not throw when the write fails", async () => {
    // No migrations, so every insert fails. The listener must swallow
    // it: observability cannot be allowed to fail the thing it observes.
    harness = await createHarness({ migrate: false });
    harness.app.config.set("watchtower", { recording: { queued: false } });
    harness.app.register(WatchtowerServiceProvider);
    await harness.app.bootstrap();

    const listener = new RecordJobRunListener(harness.app);

    await expect(
      listener.handle(new JobProcessing("watchtower", fakeJob, queued())),
    ).resolves.toBeUndefined();
  });

  it("dispatches onto the recording queue, not the default one", async () => {
    harness = await createHarness();
    harness.app.config.set("watchtower", {
      recording: { queued: true, queue: "watchtower-metrics" },
    });
    harness.app.register(WatchtowerServiceProvider);
    await harness.app.bootstrap();
    harness.collectJobs();

    const pushed: Array<{ jobClass: string; queue?: string }> = [];
    // `swap()`, the manager's own test seam, so the recording dispatch
    // lands somewhere observable rather than running inline.
    harness.queue.swap(
      {
        push: async (jobClass: string, _state: unknown, options?: { queue?: string }) => {
          pushed.push({ jobClass, queue: options?.queue });
        },
        pop: async () => undefined,
        release: async () => {},
        delete: async () => {},
        fail: async () => {},
      },
      "sync",
    );

    const listener = new RecordJobRunListener(harness.app);
    await listener.handle(new JobProcessing("watchtower", fakeJob, queued()));

    // The whole reason this does not use `listenQueued()`: that path
    // dispatches with no options at all, so metrics would land on the
    // default queue alongside real work.
    expect(pushed).toEqual([{ jobClass: RECORD_JOB_RUN_JOB, queue: "watchtower-metrics" }]);
  });
});

let counter = 0;

function dispatchId(seed: number): string {
  counter += 1;

  return `018f0000-0000-7000-8000-0000000${String(seed * 100 + counter).padStart(5, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}
