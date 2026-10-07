import { afterEach, describe, expect, it } from "vitest";
import { Tui } from "@mahiframework/tui";
import { WatchtowerCheckCommand } from "../src/commands/watchtower-check.js";
import { WatchtowerPauseCommand } from "../src/commands/watchtower-pause.js";
import { WatchtowerUnpauseCommand } from "../src/commands/watchtower-unpause.js";
import { WatchtowerPruneCommand } from "../src/commands/watchtower-prune.js";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { Watchtower } from "../src/watchtower-facade.js";
import { UnknownProcessError } from "../src/errors.js";
import { GLOBAL_PAUSE_KEY, deferralKey, pauseKey } from "../src/deferral.js";
import { RunRecorder } from "../src/run-recorder.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;
let fake: ReturnType<typeof Tui.fake>;

afterEach(() => {
  fake?.restore();
  harness?.cleanup();
  process.exitCode = 0;
});

async function boot(config: Record<string, unknown> = {}): Promise<Harness> {
  harness = await createHarness();
  harness.app.config.set("watchtower", config);
  harness.app.register(WatchtowerServiceProvider);
  await harness.app.bootstrap();
  fake = Tui.fake();

  return harness;
}

describe("watchtower:pause", () => {
  it("pauses every process", async () => {
    await boot();

    await new WatchtowerPauseCommand(harness.app).handle();

    expect(await harness.store.get(GLOBAL_PAUSE_KEY)).toBe(true);
  });

  it("pauses one named process", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"] }] });

    await new WatchtowerPauseCommand(harness.app).handle("xero");

    expect(await harness.store.get(pauseKey("xero"))).toBe(true);
    expect(await harness.store.get(GLOBAL_PAUSE_KEY)).toBeUndefined();
  });

  it("rejects a process name nothing configures", async () => {
    await boot();

    // Resolved before writing, so a typo is an error rather than a cache
    // key nothing ever reads.
    expect(
      await captureError(new WatchtowerPauseCommand(harness.app).handle("typo")),
    ).toBeInstanceOf(UnknownProcessError);
  });
});

describe("watchtower:unpause", () => {
  it("clears a pause", async () => {
    await boot();
    await new WatchtowerPauseCommand(harness.app).handle();

    await new WatchtowerUnpauseCommand(harness.app).handle();

    expect(await harness.store.get(GLOBAL_PAUSE_KEY)).toBeUndefined();
  });

  it("leaves an active cooldown alone by default", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"], fifo: true }] });
    await harness.store.put(deferralKey("xero"), Date.now() + 60_000, 60);

    await new WatchtowerUnpauseCommand(harness.app).handle("xero");

    // A cooldown exists because an upstream service asked for one.
    // Cancelling it as a side effect of resuming would resume hammering
    // the API that asked to wait.
    expect(await harness.store.get(deferralKey("xero"))).toBeDefined();
  });

  it("clears a cooldown when asked explicitly", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"], fifo: true }] });
    await harness.store.put(deferralKey("xero"), Date.now() + 60_000, 60);

    await new WatchtowerUnpauseCommand(harness.app).handle("xero", { clearCooldown: true });

    expect(await harness.store.get(deferralKey("xero"))).toBeUndefined();
  });
});

describe("watchtower:prune", () => {
  it("removes history past the configured retention", async () => {
    await boot({ recording: { retentionDays: 7 } });

    await new RunRecorder(harness.app).record({
      jobName: "app.jobs.old",
      className: "OldJob",
      dispatchId: "018f0000-0000-7000-8000-000000000001",
      invocationId: null,
      process: null,
      queue: "default",
      workerRunId: null,
      status: "completed",
      attempt: 1,
      startedAt: "2020-01-01T00:00:00Z",
      finishedAt: "2020-01-01T00:00:01Z",
      durationMs: 1000,
      error: null,
    });

    await new WatchtowerPruneCommand(harness.app).handle();

    expect(fake.output()).toContain("Pruned 1 run");
  });

  it("rejects a non-numeric --days before prompting", async () => {
    await boot();

    // Validated first, so a typo fails fast rather than prompting for a
    // run that was never going to work.
    await new WatchtowerPruneCommand(harness.app).handle({ days: "seven" });

    expect(process.exitCode).toBe(1);
    expect(fake.output()).toContain("--days must be");
  });

  it("rejects a non-positive --chunk", async () => {
    await boot();

    await new WatchtowerPruneCommand(harness.app).handle({ chunk: "0" });

    expect(process.exitCode).toBe(1);
  });
});

describe("watchtower:check", () => {
  it("passes a clean config", async () => {
    await boot({
      processes: [
        { name: "default", queues: ["default"] },
        { name: "metrics", queues: ["watchtower-metrics"] },
      ],
    });

    await new WatchtowerCheckCommand(harness.app).handle();

    expect(process.exitCode).not.toBe(1);
    expect(fake.output()).toContain("looks good");
  });

  it("errors when a dashboard is configured with no gate", async () => {
    await boot({ dashboard: {} });

    await new WatchtowerCheckCommand(harness.app).handle();

    // The single most likely mistake when installing the package, and a
    // deploy should fail on it rather than ship a 403 page.
    expect(process.exitCode).toBe(1);
    expect(fake.output()).toContain("no gate is registered");
  });

  it("passes once a gate is registered", async () => {
    await boot({ dashboard: {} });
    Watchtower.gate(() => true);

    await new WatchtowerCheckCommand(harness.app).handle();

    expect(process.exitCode).not.toBe(1);
  });

  it("errors on fifo against an in-memory cache store", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"], fifo: true }] });

    await new WatchtowerCheckCommand(harness.app).handle();

    // Fails silently otherwise, and in the worst direction: the process
    // keeps reserving through what an operator believes is a backoff.
    expect(process.exitCode).toBe(1);
    expect(fake.output()).toContain("in-memory");
  });

  it("reports queue depth for every claimed queue", async () => {
    await boot({ processes: [{ name: "default", queues: ["alpha", "beta"] }] });

    await new WatchtowerCheckCommand(harness.app).handle();

    expect(fake.output()).toContain("alpha");
    expect(fake.output()).toContain("beta");
  });

  it("warns, without failing, when nothing drains the metrics queue", async () => {
    await boot({
      recording: { queued: true },
      processes: [{ name: "default", queues: ["default"] }],
    });

    await new WatchtowerCheckCommand(harness.app).handle();

    expect(process.exitCode).not.toBe(1);
    expect(fake.output()).toContain("no process drains it");
  });
});

describe("the provider's command list", () => {
  it("registers every command exactly once", async () => {
    await boot();

    const provider = harness.app
      .getProviders()
      .find(
        (candidate): candidate is WatchtowerServiceProvider =>
          candidate instanceof WatchtowerServiceProvider,
      )!;

    const signatures = provider
      .commands()
      .map((CommandClass) => new CommandClass(harness.app).signature);

    expect(signatures).toEqual([
      "watchtower:work",
      "watchtower:worker",
      "watchtower:status",
      "watchtower:list",
      "watchtower:check",
      "watchtower:pause [process]",
      "watchtower:unpause [process]",
      "watchtower:restart",
      "watchtower:prune",
    ]);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("declares no command as dev-only", async () => {
    await boot();

    const provider = harness.app
      .getProviders()
      .find(
        (candidate): candidate is WatchtowerServiceProvider =>
          candidate instanceof WatchtowerServiceProvider,
      )!;

    // `devOnly` commands are filtered out of a compiled binary, and
    // every one of these is needed in production.
    for (const CommandClass of provider.commands()) {
      expect(CommandClass.devOnly).toBe(false);
    }
  });
});
