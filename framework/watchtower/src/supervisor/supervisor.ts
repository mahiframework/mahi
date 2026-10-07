import type { Application } from "@mahiframework/core";
import { workerCountFor, type ResolvedProcessConfig } from "../watchtower-config.js";
import type { WatchtowerManager } from "../watchtower-manager.js";
import { SupervisedChild } from "./supervised-child.js";

/** How long a child must survive for its backoff to reset. */
const SURVIVAL_MS = 60_000;

/** Base restart delay, doubled per consecutive failure. */
const BASE_BACKOFF_MS = 1000;

/** How often the pool is reconciled. */
const TICK_MS = 500;

/** One pool's live state. */
interface Pool {
  config: ResolvedProcessConfig;
  children: SupervisedChild[];
  /** Consecutive failures with no child surviving `SURVIVAL_MS`. */
  consecutiveFailures: number;
  /** Epoch ms before which no restart is attempted. */
  restartAfter: number;
  /** Exit timestamps inside the crash-loop window. */
  recentExits: number[];
  /** Set once the supervisor gives up on this process. */
  surrendered: boolean;
}

/**
 * Runs and restarts the configured worker processes.
 *
 * The `ServeCommand` supervise loop generalised from one child to a
 * pool, plus the three things that command deliberately does not do
 * because it is a development server:
 *
 * **Restart backoff.** `serve` restarts immediately and unconditionally,
 * which is right for a dev server you are watching and wrong here. The
 * core worker's own comment is the argument: *"a supervisor restarting a
 * crashed worker in a tight loop is strictly worse than one that sleeps
 * and retries"*.
 *
 * **Crash-loop surrender.** Past `crashLoopThreshold` restarts inside
 * the window, this process is abandoned and the others keep running. A
 * supervisor that masks a startup crash by restarting forever is how a
 * deploy looks healthy and does nothing.
 *
 * **Graceful drain.** SIGTERM is propagated to every child and their
 * exits awaited, bounded by `shutdownTimeoutSeconds`. The children stop
 * after their in-flight job, so this is the piece that makes a rolling
 * deploy not lose work.
 */
export class Supervisor {
  private readonly pools: Pool[] = [];
  private stopping = false;

  constructor(
    private readonly app: Application,
    private readonly watchtower: WatchtowerManager,
    processes: readonly ResolvedProcessConfig[],
  ) {
    this.pools = processes.map((config) => ({
      config,
      children: [],
      consecutiveFailures: 0,
      restartAfter: 0,
      recentExits: [],
      surrendered: false,
    }));
  }

  /** Whether every pool has been abandoned. */
  get surrendered(): boolean {
    return this.pools.length > 0 && this.pools.every((pool) => pool.surrendered);
  }

  /**
   * Bring every pool to strength, then keep it there until stopped.
   *
   * One tick does the whole job: a pool short of workers gets one,
   * subject to its backoff. There is no separate spawn phase, which
   * means a child that dies during startup is handled by the same code
   * as one that dies an hour in.
   */
  async run(signal: () => boolean): Promise<void> {
    while (!this.stopping && signal()) {
      await this.tick();

      if (this.surrendered) {
        this.app.logger.error(
          "watchtower: every process has been abandoned after repeated crashes; exiting.",
        );

        return;
      }

      await sleep(TICK_MS);
    }
  }

  /** One reconciliation pass. Public so a test can drive it deterministically. */
  async tick(): Promise<void> {
    for (const pool of this.pools) {
      this.reap(pool);

      if (pool.surrendered || this.stopping) {
        continue;
      }

      const wanted = workerCountFor(pool.config);

      while (pool.children.length < wanted && Date.now() >= pool.restartAfter) {
        this.spawn(pool);
      }

      await this.publish(pool);
    }
  }

  /**
   * Remove dead children and decide whether to back off or give up.
   *
   * A child that survived `SURVIVAL_MS` resets the backoff: it did its
   * job and something killed it later (a memory ceiling, a
   * `watchtower:restart`, an OOM), which is a routine recycle rather than
   * a crash loop.
   */
  private reap(pool: Pool): void {
    const dead = pool.children.filter((child) => !child.running);

    if (dead.length === 0) {
      return;
    }

    pool.children = pool.children.filter((child) => child.running);
    const now = Date.now();

    for (const child of dead) {
      const survived = child.uptimeMs >= SURVIVAL_MS;

      pool.recentExits.push(now);

      if (survived) {
        pool.consecutiveFailures = 0;
        pool.restartAfter = 0;
        this.app.logger.info(
          `watchtower: ${child.label} exited after ${Math.round(child.uptimeMs / 1000)}s; restarting.`,
        );

        continue;
      }

      pool.consecutiveFailures += 1;

      // Exponential, capped, and ZERO for the first failure. The first
      // restart is immediate because the overwhelmingly common cause is
      // a one-off — an OOM, a dropped connection, a deploy racing a
      // worker — and making every such blip cost a second of lost
      // throughput would be a worse default than retrying once eagerly.
      // Backoff is for the second failure onward, which is where a real
      // crash loop announces itself.
      //
      // The cap matters more than the growth rate: an unreachable
      // database should be retried every minute forever, not every three
      // hours.
      const ceiling =
        this.watchtower.configuration().supervisor.restartBackoffCeilingSeconds * 1000;
      const delay =
        pool.consecutiveFailures === 1
          ? 0
          : Math.min(BASE_BACKOFF_MS * 2 ** (pool.consecutiveFailures - 2), ceiling);

      pool.restartAfter = now + delay;

      this.app.logger.warning(
        `watchtower: ${child.label} exited after ${child.uptimeMs}ms ` +
          `(code ${child.exitCode ?? "signal"}); ` +
          (delay === 0 ? "restarting now." : `retrying in ${delay}ms.`),
      );
    }

    this.checkCrashLoop(pool, now);
  }

  /**
   * Give up on a process that cannot stay up.
   *
   * Counted over a window rather than consecutively, so a process that
   * crashes, survives 61 seconds, then crashes again — repeatedly — is
   * still caught. Consecutive-only counting would reset every time and
   * restart it forever.
   */
  private checkCrashLoop(pool: Pool, now: number): void {
    const { crashLoopThreshold, crashLoopWindowSeconds } =
      this.watchtower.configuration().supervisor;

    const windowStart = now - crashLoopWindowSeconds * 1000;
    pool.recentExits = pool.recentExits.filter((at) => at >= windowStart);

    if (pool.recentExits.length < crashLoopThreshold) {
      return;
    }

    pool.surrendered = true;

    this.app.logger.error(
      `watchtower: "${pool.config.name}" exited ${pool.recentExits.length} times in ` +
        `${crashLoopWindowSeconds}s; giving up on it. Other processes keep running.`,
    );
  }

  private spawn(pool: Pool): void {
    const index = pool.children.length + 1;
    const child = new SupervisedChild(pool.config.name, index, this.app.logger);

    child.start();
    pool.children.push(child);

    this.app.logger.info(`watchtower: started ${child.label}.`);
  }

  /**
   * Publish this pool's run ids, so `watchtower:status` can find the
   * heartbeats.
   *
   * A heartbeat is keyed by an unguessable run id and `CacheStore` has no
   * key-pattern search, so the ids have to be discoverable somewhere. TTL
   * is three ticks' worth, so a dead supervisor's list ages out rather
   * than reporting phantom workers forever.
   */
  private async publish(pool: Pool): Promise<void> {
    try {
      await this.watchtower.publishRunIds(
        pool.config.name,
        pool.children.map((child) => child.runId),
        30,
      );
    } catch (error) {
      this.app.logger.error("watchtower: could not publish worker ids.", { error });
    }
  }

  /**
   * Stop every child, then wait for them.
   *
   * The signal is propagated rather than the children killed, because a
   * worker stops after its in-flight job — so nothing is interrupted and
   * nothing is left reserved. Past the shutdown window the survivors are
   * killed, because an orchestrator's own timeout is next and being
   * SIGKILLed by it is strictly worse than being SIGKILLed here where it
   * can be logged.
   */
  async shutdown(signal: NodeJS.Signals): Promise<void> {
    this.stopping = true;

    const children = this.pools.flatMap((pool) => pool.children);

    if (children.length === 0) {
      return;
    }

    for (const child of children) {
      child.signal(signal);
    }

    const timeoutSeconds = this.watchtower.configuration().supervisor.shutdownTimeoutSeconds;

    const drained = await Promise.race([
      Promise.all(children.map((child) => child.whenExited())).then(() => true),
      sleep(timeoutSeconds * 1000).then(() => false),
    ]);

    if (drained) {
      this.app.logger.info("watchtower: every worker finished its job and exited.");

      return;
    }

    const stragglers = children.filter((child) => child.running);

    this.app.logger.warning(
      `watchtower: ${stragglers.length} worker(s) did not exit within ${timeoutSeconds}s; killing.`,
    );

    for (const child of stragglers) {
      child.kill();
    }
  }
}

/** Global-timer sleep, so `vi.useFakeTimers()` can drive the loop in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
