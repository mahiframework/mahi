import { describe, expect, it } from "vitest";
import { resolveConfig, workerCountFor } from "../src/watchtower-config.js";
import { validateConfig } from "../src/validate-config.js";

function errorsFor(config: Parameters<typeof resolveConfig>[0]): string[] {
  return validateConfig(resolveConfig(config))
    .filter((problem) => problem.level === "error")
    .map((problem) => problem.message);
}

function warningsFor(config: Parameters<typeof resolveConfig>[0]): string[] {
  return validateConfig(resolveConfig(config))
    .filter((problem) => problem.level === "warning")
    .map((problem) => problem.message);
}

describe("resolveConfig", () => {
  it("gives an app that configures nothing one worker on the default queue", () => {
    const config = resolveConfig();

    expect(config.storage).toBe("database");
    expect(config.processes).toHaveLength(1);
    expect(config.processes[0]).toMatchObject({
      name: "default",
      queues: ["default"],
      workers: 1,
      fifo: false,
    });
  });

  it("leaves the dashboard undefined when the key is absent", () => {
    // Key presence is the switch: no key means no routes at all, which
    // is what makes an accidentally-exposed dashboard impossible rather
    // than merely unlikely.
    expect(resolveConfig({}).dashboard).toBeUndefined();
  });

  it("registers the dashboard for an empty object", () => {
    const config = resolveConfig({ dashboard: {} });

    expect(config.dashboard).toMatchObject({
      prefix: "/watchtower",
      middleware: [],
      pollSeconds: 5,
    });
  });

  it("preserves a fifo process's workers so validation can reject it", () => {
    // Clamping here would make the conflict unobservable and the error
    // impossible to raise, leaving the caller with silent single-worker
    // behaviour from a config that says four.
    const config = resolveConfig({
      processes: [{ name: "xero", queues: ["xero"], workers: 4, fifo: true }],
    });

    expect(config.processes[0]?.workers).toBe(4);
  });

  it("clamps a fifo process to one worker at the point of use", () => {
    const config = resolveConfig({
      processes: [{ name: "xero", queues: ["xero"], workers: 4, fifo: true }],
    });

    expect(workerCountFor(config.processes[0]!)).toBe(1);
  });

  it("spawns the configured count for a non-fifo process", () => {
    const config = resolveConfig({
      processes: [{ name: "default", queues: ["default"], workers: 4 }],
    });

    expect(config.processes[0]?.workers).toBe(4);
    expect(workerCountFor(config.processes[0]!)).toBe(4);
  });

  it("copies the queue list rather than aliasing the caller's array", () => {
    const queues = ["urgent", "default"];
    const config = resolveConfig({ processes: [{ name: "default", queues }] });

    queues.push("mutated");

    expect(config.processes[0]?.queues).toEqual(["urgent", "default"]);
  });

  it("defaults recording to an inline write", () => {
    // Inline despite being slower: queued needs a process draining the
    // metrics queue, and a zero-config app has none — so defaulting to
    // queued would record nothing and show an empty dashboard with no
    // error anywhere.
    expect(resolveConfig().recording).toEqual({
      enabled: true,
      queued: false,
      queue: "watchtower-metrics",
      connection: undefined,
      retentionDays: 7,
    });
  });

  it("preserves an explicitly falsy option rather than defaulting it", () => {
    // `??` not `||`: `enabled: false` and `workers: 0` are answers, and
    // `||` would quietly replace both.
    const config = resolveConfig({
      recording: { enabled: false, queued: false },
      processes: [{ name: "default", queues: ["default"], backoff: 0 }],
    });

    expect(config.recording.enabled).toBe(false);
    expect(config.recording.queued).toBe(false);
    expect(config.processes[0]?.backoff).toBe(0);
  });
});

describe("validateConfig", () => {
  it("accepts the default config", () => {
    expect(validateConfig(resolveConfig())).toEqual([]);
  });

  it("rejects two processes with the same name", () => {
    const errors = errorsFor({
      processes: [
        { name: "xero", queues: ["a"] },
        { name: "xero", queues: ["b"] },
      ],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Two processes are named "xero"');
  });

  it("rejects a process that drains no queues", () => {
    const errors = errorsFor({ processes: [{ name: "idle", queues: [] }] });

    expect(errors[0]).toContain("drains no queues");
  });

  it("rejects fifo with more than one worker", () => {
    const errors = errorsFor({
      processes: [{ name: "xero", queues: ["xero"], workers: 3, fifo: true }],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ordering is not guaranteed");
  });

  it("accepts fifo with one worker", () => {
    expect(
      errorsFor({ processes: [{ name: "xero", queues: ["xero"], workers: 1, fifo: true }] }),
    ).toEqual([]);
  });

  it("accepts fifo with workers omitted", () => {
    expect(errorsFor({ processes: [{ name: "xero", queues: ["xero"], fifo: true }] })).toEqual([]);
  });

  it("rejects a non-positive maxDeferrals", () => {
    const errors = errorsFor({
      processes: [{ name: "xero", queues: ["xero"], fifo: true, maxDeferrals: 0 }],
    });

    expect(errors[0]).toContain("refuse every cooldown");
  });

  it("rejects a non-positive retention", () => {
    const errors = errorsFor({ recording: { retentionDays: 0 } });

    expect(errors[0]).toContain("delete every row");
  });

  it("reports every problem at once, not just the first", () => {
    // A config with two mistakes should not take two deploys to fix.
    const errors = errorsFor({
      processes: [
        { name: "dup", queues: [] },
        { name: "dup", queues: ["x"], workers: 2, fifo: true },
      ],
    });

    expect(errors).toHaveLength(3);
  });

  it("warns when two processes claim the same queue", () => {
    const warnings = warningsFor({
      processes: [
        { name: "a", queues: ["shared"] },
        { name: "b", queues: ["shared"] },
      ],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("more than one process");
  });

  it("warns when recording is queued but nothing drains that queue", () => {
    // The dashboard silently stops updating otherwise, which is worse
    // than it failing: the page still renders, just with stale numbers.
    const warnings = warningsFor({
      recording: { queued: true },
      processes: [{ name: "default", queues: ["default"] }],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no process drains it");
  });

  it("does not warn about the recording queue when a process claims it", () => {
    expect(
      warningsFor({
        recording: { queued: true },
        processes: [
          { name: "default", queues: ["default"] },
          { name: "metrics", queues: ["watchtower-metrics"] },
        ],
      }),
    ).toEqual([]);
  });

  it("does not warn about the recording queue when recording is inline", () => {
    expect(
      warningsFor({
        processes: [{ name: "default", queues: ["default"] }],
      }),
    ).toEqual([]);
  });
});
