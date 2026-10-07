import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "../src/supervisor/supervisor.js";
import { WatchtowerManager } from "../src/watchtower-manager.js";
import { resolveConfig } from "../src/watchtower-config.js";
import { WORKER_ENV } from "../src/commands/watchtower-worker.js";
import { createHarness, type Harness } from "./__fixtures__/test-app.js";

/**
 * `vi.mock("node:child_process")` with a hand-rolled killable child, the
 * pattern `serve.test.ts` established.
 *
 * `@mahiframework/process` cannot model this: it is `run()`-only,
 * buffers stdout to completion, never returns the `ChildProcess` handle
 * and collapses signal-death into exit code 1. Nothing about a
 * long-lived, signalled, restarted child is expressible through it.
 */
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.signalCode = signal ?? "SIGTERM";

    return true;
  });
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });

  return child;
}

/** Kill a fake child as the OS would: set state, then emit. */
function exitChild(child: FakeChild, code = 1): void {
  child.exitCode = code;
  child.emit("exit", code, null);
}

let harness: Harness;
let children: FakeChild[];

beforeEach(() => {
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    children.push(child);

    return child;
  });
});

afterEach(() => {
  harness?.cleanup();
  delete process.env[WORKER_ENV];
});

async function supervisorFor(config: Parameters<typeof resolveConfig>[0] = {}) {
  harness = await createHarness({ migrate: false });
  const resolved = resolveConfig(config);
  const manager = new WatchtowerManager(harness.app, resolved);

  return new Supervisor(harness.app, manager, resolved.processes);
}

describe("Supervisor", () => {
  it("spawns the configured number of workers", async () => {
    const supervisor = await supervisorFor({
      processes: [{ name: "default", queues: ["default"], workers: 3 }],
    });

    await supervisor.tick();

    expect(children).toHaveLength(3);
  });

  it("spawns one worker for a fifo process regardless of the count", async () => {
    const supervisor = await supervisorFor({
      processes: [{ name: "xero", queues: ["xero"], workers: 4, fifo: true }],
    });

    await supervisor.tick();

    // `workerCountFor()` clamps it. A second worker could already hold
    // the next job when the first releases, which breaks the ordering
    // `fifo` exists to promise.
    expect(children).toHaveLength(1);
  });

  it("spawns workers for every process", async () => {
    const supervisor = await supervisorFor({
      processes: [
        { name: "a", queues: ["a"], workers: 2 },
        { name: "b", queues: ["b"], workers: 1 },
      ],
    });

    await supervisor.tick();

    expect(children).toHaveLength(3);
  });

  it("passes the process name, a run id and the recursion guard", async () => {
    const supervisor = await supervisorFor({
      processes: [{ name: "xero", queues: ["xero"] }],
    });

    await supervisor.tick();

    const [, args, options] = spawnMock.mock.calls[0]!;

    expect(args).toContain("watchtower:worker");
    expect(args.some((arg: string) => arg === "--process=xero")).toBe(true);
    expect(args.some((arg: string) => arg.startsWith("--run-id="))).toBe(true);
    // Without this a child would supervise, spawning children that
    // supervise, forever.
    expect(options.env[WORKER_ENV]).toBe("1");
  });

  it("pipes output rather than inheriting it", async () => {
    const supervisor = await supervisorFor();

    await supervisor.tick();

    // Inherited output from several children interleaves into nonsense;
    // piping is what allows the `[process.n]` prefix.
    expect(spawnMock.mock.calls[0]![2].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("passes an explicit cwd, so a child resolves the same base path", async () => {
    const supervisor = await supervisorFor();

    await supervisor.tick();

    expect(spawnMock.mock.calls[0]![2].cwd).toBe(process.cwd());
  });

  it("replaces a worker that exits", async () => {
    const supervisor = await supervisorFor();

    await supervisor.tick();
    expect(children).toHaveLength(1);

    exitChild(children[0]!);
    await supervisor.tick();

    expect(children).toHaveLength(2);
  });

  it("backs off before restarting a worker that died immediately", async () => {
    const supervisor = await supervisorFor();

    await supervisor.tick();
    exitChild(children[0]!);
    await supervisor.tick();

    // One restart, then the backoff holds.
    expect(children).toHaveLength(2);

    exitChild(children[1]!);
    await supervisor.tick();

    // Still 2: the second failure doubled the delay, so this tick
    // declines to spawn. A supervisor restarting a crashed worker in a
    // tight loop is worse than one that sleeps.
    expect(children).toHaveLength(2);
  });

  it("gives up on a process that keeps crashing", async () => {
    const supervisor = await supervisorFor({
      processes: [{ name: "broken", queues: ["x"] }],
      // A wide window and a big ceiling, so this exercises the THRESHOLD
      // rather than racing the backoff. Advancing the clock to clear the
      // backoff would also age the exits out of the window.
      supervisor: {
        crashLoopThreshold: 3,
        crashLoopWindowSeconds: 3600,
        restartBackoffCeilingSeconds: 0,
      },
    });

    for (let round = 0; round < 3; round += 1) {
      await supervisor.tick();
      const child = children[children.length - 1];

      if (child) {
        exitChild(child);
      }
    }

    const spawnedBefore = children.length;
    await supervisor.tick();

    // Abandoned: a supervisor that masks a startup crash by restarting
    // forever is how a deploy looks healthy and does nothing.
    expect(children).toHaveLength(spawnedBefore);
    expect(supervisor.surrendered).toBe(true);
  });

  it("counts crashes over a window, not consecutively", async () => {
    const supervisor = await supervisorFor({
      processes: [{ name: "flaky", queues: ["x"] }],
      supervisor: {
        crashLoopThreshold: 3,
        crashLoopWindowSeconds: 3600,
        restartBackoffCeilingSeconds: 0,
      },
    });

    // Each child survives the 60s survival window before dying, so the
    // CONSECUTIVE failure count resets every time. A
    // consecutive-only rule would restart this forever.
    for (let round = 0; round < 3; round += 1) {
      await supervisor.tick();
      vi.setSystemTime(Date.now() + 61_000);
      const child = children[children.length - 1];

      if (child) {
        exitChild(child);
      }
    }

    await supervisor.tick();

    expect(supervisor.surrendered).toBe(true);
  });

  it("keeps other processes running when one is abandoned", async () => {
    const supervisor = await supervisorFor({
      processes: [
        { name: "broken", queues: ["x"] },
        { name: "healthy", queues: ["y"] },
      ],
      supervisor: {
        crashLoopThreshold: 2,
        crashLoopWindowSeconds: 3600,
        restartBackoffCeilingSeconds: 0,
      },
    });

    await supervisor.tick();

    // Only the first pool's child ever dies.
    for (let round = 0; round < 3; round += 1) {
      const broken = children.find(
        (child) => child.exitCode === null && children.indexOf(child) % 2 === 0,
      );

      if (broken) {
        exitChild(broken);
      }

      await supervisor.tick();
    }

    // Not EVERY pool, so the supervisor stays up for the healthy one.
    expect(supervisor.surrendered).toBe(false);
  });

  it("resets the backoff after a worker survives", async () => {
    const supervisor = await supervisorFor();

    await supervisor.tick();
    exitChild(children[0]!);
    await supervisor.tick();

    // The replacement survives the window, then exits. That is a routine
    // recycle (a memory ceiling, a restart signal), not a crash loop.
    vi.setSystemTime(Date.now() + 120_000);
    exitChild(children[1]!);
    await supervisor.tick();

    expect(children).toHaveLength(3);
  });
});

describe("Supervisor shutdown", () => {
  it("signals every child and waits for it", async () => {
    const supervisor = await supervisorFor({
      processes: [{ name: "default", queues: ["default"], workers: 2 }],
    });

    await supervisor.tick();

    const shutdown = supervisor.shutdown("SIGTERM");

    // Signalled, not killed: a worker stops after its in-flight job, so
    // nothing is interrupted and nothing is left reserved.
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1]!.kill).toHaveBeenCalledWith("SIGTERM");

    for (const child of children) {
      child.signalCode = null;
      exitChild(child, 0);
    }

    await shutdown;
  });

  it("kills a child that outstays the shutdown window", async () => {
    const supervisor = await supervisorFor({
      supervisor: { shutdownTimeoutSeconds: 1 },
    });

    await supervisor.tick();

    const child = children[0]!;
    child.kill.mockImplementation(() => true);

    await supervisor.shutdown("SIGTERM");

    // An orchestrator's own timeout is next, and being SIGKILLed by it
    // is worse than being SIGKILLed here where it can be logged.
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does nothing when no children were started", async () => {
    const supervisor = await supervisorFor();

    await expect(supervisor.shutdown("SIGTERM")).resolves.toBeUndefined();
  });

  it("stops reconciling once shutdown has begun", async () => {
    const supervisor = await supervisorFor();

    await supervisor.tick();
    await supervisor.shutdown("SIGTERM");

    exitChild(children[0]!);
    await supervisor.tick();

    // A tick during shutdown must not spawn a replacement for a child
    // that was deliberately stopped.
    expect(children).toHaveLength(1);
  });
});
