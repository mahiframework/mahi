import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_TOKEN } from "@mahiframework/core";
import type { QueueManager } from "@mahiframework/queue";
import { Watchtower } from "../src/watchtower-facade.js";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { WatchtowerQueueDriver } from "../src/drivers/watchtower-queue-driver.js";
import { RunRecorder, type JobRunObservation } from "../src/run-recorder.js";
import { severityForAge, severityForFailureRate, severityForState } from "../src/stats.js";
import { WATCHTOWER_CONNECTION } from "../src/tokens.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

async function boot(config: Record<string, unknown> = {}): Promise<Harness> {
  harness = await createHarness();
  harness.app.config.set("watchtower", config);
  harness.app.register(WatchtowerServiceProvider);
  await harness.app.bootstrap();

  return harness;
}

function driver(): WatchtowerQueueDriver {
  return harness.app
    .make<QueueManager>(QUEUE_TOKEN)
    .connection(WATCHTOWER_CONNECTION) as WatchtowerQueueDriver;
}

let seq = 0;

function observation(overrides: Partial<JobRunObservation> = {}): JobRunObservation {
  seq += 1;

  return {
    jobName: "app.jobs.sync-invoice",
    className: "SyncInvoiceJob",
    dispatchId: `018f0000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    invocationId: null,
    process: "default",
    queue: "default",
    workerRunId: null,
    status: "completed",
    attempt: 1,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 100,
    error: null,
    ...overrides,
  };
}

describe("Watchtower.stats", () => {
  it("reports an empty system without failing", async () => {
    await boot();

    const stats = await Watchtower.stats();

    expect(stats.totals.pending).toBe(0);
    // Null, not zero: nothing is waiting, which is different from
    // something having waited no time at all.
    expect(stats.totals.oldestPendingSeconds).toBeNull();
    expect(stats.jobTypes).toEqual([]);
    expect(stats.recentFailures).toEqual([]);
  });

  it("counts pending jobs per queue", async () => {
    await boot({ processes: [{ name: "default", queues: ["alpha", "beta"] }] });

    await driver().push("app.jobs.a", {}, { queue: "alpha" });
    await driver().push("app.jobs.a", {}, { queue: "alpha" });
    await driver().push("app.jobs.b", {}, { queue: "beta" });

    const stats = await Watchtower.stats();

    expect(stats.totals.pending).toBe(3);
    expect(stats.queues.find((queue) => queue.queue === "alpha")?.pending).toBe(2);
    expect(stats.queues.find((queue) => queue.queue === "beta")?.pending).toBe(1);
  });

  it("names the process that drains each queue", async () => {
    await boot({
      processes: [
        { name: "xero", queues: ["xero"] },
        { name: "default", queues: ["default"] },
      ],
    });

    const stats = await Watchtower.stats();

    expect(stats.queues.find((queue) => queue.queue === "xero")?.claimedBy).toBe("xero");
  });

  it("reports a process with no live workers as stopped", async () => {
    await boot();

    const stats = await Watchtower.stats();

    // No supervisor running, so nothing is publishing heartbeats.
    // Normal before `watchtower:work` starts and a problem after.
    expect(stats.processes[0]?.state).toBe("stopped");
    expect(stats.processes[0]?.workersAlive).toBe(0);
    expect(stats.processes[0]?.severity).toBe("danger");
  });

  it("reports a fifo process as configured for one worker", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"], fifo: true }] });

    const stats = await Watchtower.stats();

    // Showing `0/1` next to a fifo badge must read as correct, not as
    // under-provisioned.
    expect(stats.processes[0]?.workersConfigured).toBe(1);
    expect(stats.processes[0]?.fifo).toBe(true);
  });

  it("surfaces config warnings alongside the data", async () => {
    await boot({
      recording: { queued: true },
      processes: [{ name: "default", queues: ["default"] }],
    });

    const stats = await Watchtower.stats();

    expect(stats.warnings.some((warning) => warning.includes("no process drains it"))).toBe(true);
  });

  it("aggregates completions and failures per job type", async () => {
    await boot();
    const recorder = new RunRecorder(harness.app);

    for (let index = 0; index < 3; index += 1) {
      await recorder.record(observation({ status: "completed", durationMs: 100 }));
    }

    await recorder.record(observation({ status: "failed", error: "boom" }));

    const types = await Watchtower.jobTypes();

    expect(types).toHaveLength(1);
    expect(types[0]?.completedCount).toBe(3);
    expect(types[0]?.failedCount).toBe(1);
    expect(types[0]?.failureRate).toBeCloseTo(0.25, 5);
    expect(types[0]?.severity).toBe("danger");
  });

  it("computes nearest-rank percentiles from observed durations", async () => {
    await boot();
    const recorder = new RunRecorder(harness.app);

    for (const ms of [100, 200, 300, 400, 1000]) {
      await recorder.record(observation({ status: "completed", durationMs: ms }));
    }

    const types = await Watchtower.jobTypes();

    // Nearest-rank, so both are real measurements rather than an
    // average of two.
    expect(types[0]?.p50DurationMs).toBe(300);
    expect(types[0]?.p95DurationMs).toBe(1000);
  });

  it("reports a zero failure rate when nothing has run", async () => {
    await boot();
    await new RunRecorder(harness.app).record(observation({ status: "running" }));

    const types = await Watchtower.jobTypes();

    // Neither completed nor failed, so the denominator is zero. NaN
    // would render as "NaN%".
    expect(types[0]?.failureRate).toBe(0);
    expect(types[0]?.p50DurationMs).toBeNull();
  });

  it("orders job types busiest first", async () => {
    await boot();
    const recorder = new RunRecorder(harness.app);

    await recorder.record(observation({ jobName: "app.jobs.quiet", className: "QuietJob" }));

    for (let index = 0; index < 3; index += 1) {
      await recorder.record(observation({ jobName: "app.jobs.busy", className: "BusyJob" }));
    }

    const types = await Watchtower.jobTypes();

    expect(types.map((type) => type.name)).toEqual(["app.jobs.busy", "app.jobs.quiet"]);
  });

  it("lists recent failures with the id that joins them to the logs", async () => {
    await boot();

    await new RunRecorder(harness.app).record(
      observation({
        status: "failed",
        error: "Error: boom",
        invocationId: "018f0000-0000-7000-8000-00000000cafe",
      }),
    );

    const failures = await Watchtower.recentFailures();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.jobType).toBe("app.jobs.sync-invoice");
    expect(failures[0]?.className).toBe("SyncInvoiceJob");
    // The primary debugging affordance: paste this into a log
    // aggregator and get exactly that attempt's output.
    expect(failures[0]?.invocationId).toBe("018f0000-0000-7000-8000-00000000cafe");
  });

  it("groups a job type's attempts by dispatch", async () => {
    await boot();
    const recorder = new RunRecorder(harness.app);
    const dispatchId = "018f0000-0000-7000-8000-0000000000ff";

    await recorder.record(observation({ dispatchId, attempt: 1, status: "failed" }));
    await recorder.record(observation({ dispatchId, attempt: 2, status: "failed" }));
    await recorder.record(observation({ dispatchId, attempt: 3, status: "completed" }));

    const detail = await Watchtower.jobType("app.jobs.sync-invoice");

    // "Failed twice then succeeded" is one event, told by three rows.
    expect(detail?.attemptChains).toHaveLength(1);
    expect(detail?.attemptChains[0]?.attempts.map((run) => run.attempt)).toEqual([1, 2, 3]);
  });

  it("returns undefined for a job type nothing has seen", async () => {
    await boot();

    expect(await Watchtower.jobType("app.jobs.nope")).toBeUndefined();
  });
});

describe("severity thresholds", () => {
  it("treats an absent age as healthy", () => {
    // A queue is not unhealthy for being empty.
    expect(severityForAge(null)).toBe("ok");
  });

  it("escalates with queue age", () => {
    expect(severityForAge(10)).toBe("ok");
    expect(severityForAge(600)).toBe("warn");
    expect(severityForAge(7200)).toBe("danger");
  });

  it("escalates with failure rate", () => {
    expect(severityForFailureRate(0)).toBe("ok");
    expect(severityForFailureRate(0.1)).toBe("warn");
    expect(severityForFailureRate(0.5)).toBe("danger");
  });

  it("treats a deferred process as waiting, not broken", () => {
    // A cooldown is a normal operating state: an upstream service asked
    // for it. It must read as distinct from both healthy and failing.
    expect(severityForState("deferred")).toBe("warn");
    expect(severityForState("running")).toBe("ok");
    expect(severityForState("stopped")).toBe("danger");
  });
});

function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}
