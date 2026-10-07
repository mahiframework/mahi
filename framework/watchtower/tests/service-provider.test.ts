import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_TOKEN } from "@mahiframework/core";
import type { QueueManager } from "@mahiframework/queue";
import { WatchtowerServiceProvider } from "../src/watchtower-service-provider.js";
import { WatchtowerManager } from "../src/watchtower-manager.js";
import { WatchtowerQueueDriver } from "../src/drivers/watchtower-queue-driver.js";
import { WatchtowerConfigError } from "../src/errors.js";
import { WATCHTOWER_CONNECTION, WATCHTOWER_TOKEN } from "../src/tokens.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
});

async function boot(config?: Record<string, unknown>): Promise<Harness> {
  harness = await createHarness();

  if (config !== undefined) {
    harness.app.config.set("watchtower", config);
  }

  harness.app.register(WatchtowerServiceProvider);
  await harness.app.bootstrap();

  return harness;
}

describe("WatchtowerServiceProvider", () => {
  it("binds the manager with no config at all", async () => {
    await boot();

    const manager = harness.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);

    expect(manager).toBeInstanceOf(WatchtowerManager);
    expect(manager.processes()).toHaveLength(1);
    expect(manager.processes()[0]?.name).toBe("default");
  });

  it("binds a singleton, not a transient", async () => {
    await boot();

    // Load-bearing for the gate: a second resolution producing a manager
    // with no gate registered would be an open dashboard.
    expect(harness.app.make(WATCHTOWER_TOKEN)).toBe(harness.app.make(WATCHTOWER_TOKEN));
  });

  it("does not clobber config the app already set", async () => {
    await boot({ processes: [{ name: "xero", queues: ["xero"] }] });

    const manager = harness.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);

    expect(manager.processes()).toHaveLength(1);
    expect(manager.processes()[0]?.name).toBe("xero");
  });

  it("throws on a config that describes work which cannot happen", async () => {
    await boot({ processes: [{ name: "broken", queues: [] }] });

    // At resolution rather than at first use, so a bad config fails the
    // boot rather than the first job.
    const error = await captureError(
      Promise.resolve().then(() => harness.app.make(WATCHTOWER_TOKEN)),
    );

    expect(error).toBeInstanceOf(WatchtowerConfigError);
    expect((error as WatchtowerConfigError).problems).toHaveLength(1);
  });

  it("reports every config problem in one error", async () => {
    await boot({
      processes: [
        { name: "dup", queues: [] },
        { name: "dup", queues: ["x"], workers: 2, fifo: true },
      ],
    });

    const error = (await captureError(
      Promise.resolve().then(() => harness.app.make(WATCHTOWER_TOKEN)),
    )) as WatchtowerConfigError;

    expect(error.problems).toHaveLength(3);
  });

  it("registers the watchtower queue connection", async () => {
    await boot();

    const queue = harness.app.make<QueueManager>(QUEUE_TOKEN);

    expect(queue.connection(WATCHTOWER_CONNECTION)).toBeInstanceOf(WatchtowerQueueDriver);
  });

  it("ships both migrations, named to match their filenames", async () => {
    await boot();

    const provider = harness.app
      .getProviders()
      .find(
        (candidate): candidate is WatchtowerServiceProvider =>
          candidate instanceof WatchtowerServiceProvider,
      )!;

    // The name is what lands in the `migrations` table and orders
    // execution, so a mismatch would re-run a migration an app has
    // already applied.
    expect(provider.migrationSources().map((source) => source.name)).toEqual([
      "0001_create_watchtower_tables",
      "0002_create_watchtower_jobs_table",
    ]);
  });

  it("registers both models, so a queued job can carry either", async () => {
    await boot();

    const provider = harness.app
      .getProviders()
      .find(
        (candidate): candidate is WatchtowerServiceProvider =>
          candidate instanceof WatchtowerServiceProvider,
      )!;

    expect(provider.models()).toHaveLength(2);
  });

  it("registers no routes, because no dashboard key is configured", async () => {
    await boot();

    const provider = harness.app
      .getProviders()
      .find(
        (candidate): candidate is WatchtowerServiceProvider =>
          candidate instanceof WatchtowerServiceProvider,
      )!;

    // Key presence is the switch. Asserted on the hook rather than by
    // probing a request, so "no key means no routes" is pinned even
    // before the dashboard exists.
    expect(provider.routes).toBeUndefined();
  });
});
