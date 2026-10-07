import { afterEach, describe, expect, it, vi } from "vitest";
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

function provider(): WatchtowerServiceProvider {
  return harness.app
    .getProviders()
    .find(
      (candidate): candidate is WatchtowerServiceProvider =>
        candidate instanceof WatchtowerServiceProvider,
    )!;
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

  it("registers no routes when no dashboard key is configured", async () => {
    await boot();

    // Key presence is the switch, so the hook must return before
    // touching the router at all — not register routes that then refuse.
    const router = { group: vi.fn() };

    provider().routes?.(router as never);

    expect(router.group).not.toHaveBeenCalled();
  });

  it("registers the dashboard group when the key is present", async () => {
    await boot({ dashboard: { prefix: "/ops/queue" } });

    const registered: Array<[string, string]> = [];
    const group = {
      middleware: vi.fn(),
      get: (path: string) => registered.push(["get", path]),
      post: (path: string) => registered.push(["post", path]),
    };
    const router = {
      group: (prefix: string, callback: (g: unknown) => void) => {
        registered.push(["prefix", prefix]);
        callback(group);
      },
    };

    provider().routes?.(router as never);

    expect(registered).toEqual([
      ["prefix", "/ops/queue"],
      // `/data` before the group root, so a root match cannot swallow it.
      ["get", "/data"],
      ["post", "/retry/{run}"],
      ["get", "/"],
    ]);
  });

  it("always appends the gate after the app's own middleware", async () => {
    const appPipe = vi.fn();
    await boot({ dashboard: { middleware: [appPipe] } });

    const group = { middleware: vi.fn(), get: vi.fn(), post: vi.fn() };

    provider().routes?.({
      group: (_prefix: string, callback: (g: unknown) => void) => callback(group),
    } as never);

    // One call, before any route — `Router.middleware()` throws if it
    // comes after one, precisely so a guard that guards nothing is a
    // boot failure.
    expect(group.middleware).toHaveBeenCalledTimes(1);

    const pipes = group.middleware.mock.calls[0]!;

    // The app establishes who the user is; the gate decides whether they
    // may look, and it is last and not removable.
    expect(pipes).toHaveLength(2);
    expect(pipes[0]).toBe(appPipe);
    expect(typeof pipes[1]).toBe("function");
  });

  it("appends the gate even when the app configures no middleware", async () => {
    await boot({ dashboard: {} });

    const group = { middleware: vi.fn(), get: vi.fn(), post: vi.fn() };

    provider().routes?.({
      group: (_prefix: string, callback: (g: unknown) => void) => callback(group),
    } as never);

    expect(group.middleware.mock.calls[0]).toHaveLength(1);
  });
});
