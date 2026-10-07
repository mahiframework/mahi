import { randomUUIDv7 } from "node:crypto";
import { QUEUE_TOKEN } from "@mahiframework/core";
import type { CommanderCommand } from "@mahiframework/cli";
import {
  QueueWorkCommand,
  type QueueDriver,
  type QueuedJob,
  type WorkOptions,
} from "@mahiframework/queue";
import {
  isWatchtowerJob,
  supportsDeferral,
  WatchtowerQueueDriver,
} from "../drivers/watchtower-queue-driver.js";
import { DeferralUnsupportedError } from "../errors.js";
import { isSharedStore } from "../deferral.js";
import { WATCHTOWER_CONNECTION, WATCHTOWER_TOKEN } from "../tokens.js";
import type { WatchtowerManager } from "../watchtower-manager.js";
import type { ResolvedProcessConfig } from "../watchtower-config.js";
import { DATABASE_TOKEN, type DatabaseManager } from "@mahiframework/database";

/** Env var marking a supervised child, so it cannot supervise itself. */
export const WORKER_ENV = "MAHI_WATCHTOWER_WORKER";

/** Env vars the recorder reads to attribute a run. */
export const PROCESS_ENV = "MAHI_WATCHTOWER_PROCESS";
export const RUN_ID_ENV = "MAHI_WATCHTOWER_RUN_ID";

/** How long a heartbeat survives without a refresh. */
const HEARTBEAT_TTL_SECONDS = 30;

/**
 * One supervised worker child.
 *
 * A `QueueWorkCommand` with a different `reserve()`, and nothing else
 * changed. That is deliberate and it is the whole design: every rule the
 * core worker enforces — a loop that never throws, an undecodable
 * payload failing rather than crashing, attempts-already-exhausted
 * failing without running, the delete→unlock→event→chain order on
 * success, `driver.fail()` before the `failed()` hook — was earned by a
 * specific failure, and reimplementing any of them here would be
 * reintroducing the bug it fixed.
 *
 * What `reserve()` adds:
 *
 * - **Queue priority.** The core worker drains one queue; a process
 *   drains a list, highest priority first, taking the first job
 *   available.
 * - **Pause and cooldown.** Declines to reserve while an operator has
 *   paused the process or an upstream rate limit is still in effect.
 * - **A heartbeat**, so `watchtower:status` can tell idle from hung
 *   without asking a supervisor whose in-memory view is wrong the moment
 *   a second one runs.
 *
 * Not `devOnly`. `ServeCommand` is, because it depends on tsx; this must
 * survive `bun build --compile`, so the compiled-binary branch of
 * `consoleWorkerArgs()` is the primary path rather than the fallback.
 *
 * Hidden from `--help`: it is an implementation detail of
 * `watchtower:work`, and an operator running it directly gets an
 * unsupervised worker that nothing will restart.
 */
export class WatchtowerWorkerCommand extends QueueWorkCommand {
  override signature = "watchtower:worker";
  override description = "Run one supervised watchtower worker (use watchtower:work instead).";

  /** This worker's identity, for heartbeats and reserved_by. */
  private runId = "";
  private processConfig?: ResolvedProcessConfig;
  private watchtower?: WatchtowerManager;
  /** A driver bound to this process's `fifo` setting and cooldown hook. */
  private processDriver?: WatchtowerQueueDriver;
  private processedCount = 0;
  private lastBeatAt = 0;

  override configure(program: CommanderCommand): void {
    super.configure(program);
    program.option("--process <name>", "The configured process this worker belongs to");
    program.option("--run-id <id>", "Supervisor-assigned run id (generated when omitted)");
  }

  override async handle(
    options: WorkOptions & { process?: string; runId?: string },
  ): Promise<void> {
    const watchtower = this.app.make<WatchtowerManager>(WATCHTOWER_TOKEN);
    const name = options.process ?? watchtower.processes()[0]?.name;

    if (name === undefined) {
      this.error("No watchtower process is configured.");
      process.exitCode = 1;

      return;
    }

    const config = watchtower.process(name);

    this.watchtower = watchtower;
    this.processConfig = config;
    this.runId = options.runId ?? randomUUIDv7();

    // Published for the recorder, which runs inside this process and has
    // no other way to know which process it belongs to. Set on `process.env`
    // rather than passed, because the listener is constructed by the
    // event dispatcher and takes only an `Application`.
    process.env[PROCESS_ENV] = config.name;
    process.env[RUN_ID_ENV] = this.runId;

    this.assertFifoIsUsable(config);
    this.processDriver = this.buildDriver(config);

    // Every `queue:work` option the process config carries, so one
    // configuration describes the fleet and nothing has to be repeated
    // on a command line.
    await super.handle({
      ...options,
      connection: WATCHTOWER_CONNECTION,
      sleep: String(config.sleep),
      memory: String(config.memory),
      ...(config.tries !== undefined ? { tries: String(config.tries) } : {}),
      ...(config.timeout !== undefined ? { timeout: String(config.timeout) } : {}),
      ...(config.backoff !== undefined ? { backoff: String(config.backoff) } : {}),
      ...(config.maxJobs !== undefined ? { maxJobs: String(config.maxJobs) } : {}),
      ...(config.maxTime !== undefined ? { maxTime: String(config.maxTime) } : {}),
    });
  }

  /**
   * Refuse to start a `fifo` process that cannot actually be fifo.
   *
   * Both conditions fail silently otherwise, and in the same direction:
   * the process keeps reserving jobs through what an operator believes is
   * a backoff, hammering the API that asked it to wait. Refusing to start
   * is the honest outcome — the supervisor reports a dead process rather
   * than a lying one.
   */
  private assertFifoIsUsable(config: ResolvedProcessConfig): void {
    if (!config.fifo) {
      return;
    }

    const driver = this.app.make<{ connection: (n: string) => QueueDriver }>(QUEUE_TOKEN);

    if (!supportsDeferral(driver.connection(WATCHTOWER_CONNECTION))) {
      throw new DeferralUnsupportedError(
        config.name,
        this.watchtower?.configuration().storage ?? "unknown",
      );
    }

    const store = this.watchtower?.store().store();

    if (store === undefined || !isSharedStore(store)) {
      throw new DeferralUnsupportedError(config.name, "an in-memory cache store");
    }
  }

  /**
   * Build this worker's own driver instance.
   *
   * Not the one the container resolves: `fifo` and the cooldown hook are
   * properties of a PROCESS, and a container factory has no process. This
   * is where a job's `release(this, 60)` acquires its meaning — the same
   * call, bound to this process's configuration.
   */
  private buildDriver(config: ResolvedProcessConfig): WatchtowerQueueDriver {
    const database = this.app.make<DatabaseManager>(DATABASE_TOKEN);

    return new WatchtowerQueueDriver(database.driver().kysely, {
      connectionName: WATCHTOWER_CONNECTION,
      fifo: config.fifo,
      onDefer: async (seconds) => {
        await this.watchtower?.store().defer(config.name, seconds);
      },
    });
  }

  /**
   * Reserve from this process's queues, honouring pause and cooldown.
   *
   * The ONE override. Everything after a job is returned is the core
   * worker's, unchanged.
   */
  protected override async reserve(
    _driver: QueueDriver,
    sleepMs: number,
  ): Promise<QueuedJob | undefined> {
    const config = this.processConfig;
    const driver = this.processDriver;

    if (!config || !driver || !this.watchtower) {
      return undefined;
    }

    await this.beat(null);

    const wait = await this.watchtower.store().waitState(config.name);

    // Paused or cooling down: report nothing available. The caller then
    // sleeps and re-asks, which is exactly the right behaviour — the
    // worker stays up and resumes the instant the state clears.
    if (wait.paused || wait.deferredUntil !== undefined) {
      return undefined;
    }

    for (const queue of config.queues) {
      let job: QueuedJob | undefined;

      try {
        job = await driver.popFor(queue, this.runId);
      } catch (error) {
        // Same stance as the core worker: an infrastructure failure
        // pauses this worker rather than ending it. A database blipping
        // out must not take the fleet down, and a supervisor restarting
        // a crashed worker in a tight loop is worse than one that sleeps.
        this.app.logger.error("watchtower: failed to reserve a job; pausing briefly.", {
          process: config.name,
          queue,
          error,
        });

        await new Promise((resolve) => setTimeout(resolve, sleepMs));

        return undefined;
      }

      if (job !== undefined) {
        // Strict priority: the first queue with work wins, so a
        // permanently busy first queue starves the rest. That is
        // sometimes exactly right and sometimes a mistake; splitting the
        // workload across processes is the fix when it is a mistake.
        this.queue = queue;
        this.processedCount += 1;
        await this.beat(job.jobClass);

        if (this.exceededDeferrals(job, config)) {
          // Past `maxDeferrals` this job may no longer hold its process.
          // Released the ordinary way instead — it goes to the back and
          // the rest of the queue moves.
          this.app.logger.warning(
            "watchtower: a job exceeded maxDeferrals; releasing it normally.",
            { process: config.name, job: job.jobClass },
          );

          await this.ordinaryDriver().release(job, 0);

          return undefined;
        }

        return job;
      }
    }

    return undefined;
  }

  /** Whether this job has already paused its process too many times. */
  private exceededDeferrals(job: QueuedJob, config: ResolvedProcessConfig): boolean {
    if (!config.fifo || !isWatchtowerJob(job)) {
      return false;
    }

    return job.deferrals >= config.maxDeferrals;
  }

  /** A non-fifo driver, for the `maxDeferrals` fallback. */
  private ordinaryDriver(): WatchtowerQueueDriver {
    const database = this.app.make<DatabaseManager>(DATABASE_TOKEN);

    return new WatchtowerQueueDriver(database.driver().kysely, {
      connectionName: WATCHTOWER_CONNECTION,
    });
  }

  /**
   * Publish liveness, at most once per poll and not more than every few
   * seconds.
   *
   * TTL'd rather than cleared on exit, so a worker killed with `-9` ages
   * out instead of appearing alive forever. `watchtower:status` counts
   * live keys rather than asking a supervisor, because a supervisor's
   * view covers only its own host.
   */
  private async beat(jobClass: string | null): Promise<void> {
    const config = this.processConfig;

    if (!config || !this.watchtower) {
      return;
    }

    const now = Date.now();

    if (jobClass === null && now - this.lastBeatAt < 5000) {
      return;
    }

    this.lastBeatAt = now;

    try {
      await this.watchtower.store().heartbeat(
        this.runId,
        {
          runId: this.runId,
          process: config.name,
          pid: process.pid,
          startedAt: this.lastBeatAt,
          beatAt: now,
          jobClass,
          processed: this.processedCount,
        },
        HEARTBEAT_TTL_SECONDS,
      );
    } catch (error) {
      // A heartbeat is observability. It must never be the reason a
      // worker stops working.
      this.app.logger.error("watchtower: could not publish a heartbeat.", { error });
    }
  }
}
