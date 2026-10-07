import type { Command as CommanderCommand } from "commander";
import { runInvocationScope } from "@mahiframework/core";
import { Command, trap } from "@mahiframework/cli";
import { QueueManager } from "../queue-manager.js";
import { JobRegistry } from "../job-registry.js";
import { QUEUE_TOKEN, JOB_REGISTRY_TOKEN } from "../tokens.js";
import type { QueueDriver, QueuedJob } from "../queue-driver.js";
import { decodeJob } from "../job-serialization.js";
import type { Job, JobClass } from "../job.js";
import { uniqueModeOf } from "../job.js";
import { acquireUniqueLockForState, releaseUniqueLock } from "../unique-jobs.js";
import { runJobThroughMiddleware } from "../middleware/run-job-through-middleware.js";
import { SkipJobMissingModelError } from "../model-serialization.js";
import { ReleaseJobError } from "../middleware/release-job-error.js";
import { EventDispatcher, EVENTS_TOKEN } from "@mahiframework/events";
import type { AbstractEvent } from "@mahiframework/events";
import { JobProcessing, JobProcessed, JobFailed } from "../job-events.js";
import { restartSignalledAt } from "../restart-signal.js";

/** Global-timer sleep, so vi.useFakeTimers() can drive the loop in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default backoff: `attempts * 5` seconds, where `attempts` is the 1-based
 * number of the attempt that just failed, so the first retry waits 5s,
 * the second 10s, and so on. Callers must pass the post-increment count:
 * a zero here means an immediate retry that hammers whatever downstream
 * just failed.
 */
function defaultBackoffSeconds(attempts: number): number {
  return attempts * 5;
}

/**
 * Thrown when a job's soft `timeout()` elapses before `handle()` resolves.
 * The in-flight `handle()` promise may still be running (JS can't force an
 * abort). See `Job.timeout`.
 */
export class JobTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Job exceeded its ${seconds}s timeout.`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Thrown when a job is popped having already used up its attempts. It
 * was reclaimed one time too many after killing (or outliving) its
 * workers, so it never reached the normal "threw an exception" path that
 * would have failed it.
 */
export class MaxAttemptsExceededError extends Error {
  constructor(jobClass: string, attempts: number, maxAttempts: number) {
    super(
      `Job [${jobClass}] has been attempted ${attempts} times (max ${maxAttempts}) ` +
        `without completing. It was most likely timing out or crashing its worker.`,
    );
    this.name = "MaxAttemptsExceededError";
  }
}

/**
 * Run `work` (which invokes `handle()` through its middleware), racing it
 * against a `timeoutSeconds` timer when the job defines one. Resolves/rejects
 * from whichever settles first; the timer is always cleared.
 */
async function runWithTimeout(
  work: Promise<void>,
  timeoutSeconds: number | undefined,
): Promise<void> {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return work;
  }

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(timeoutSeconds)), timeoutSeconds * 1000);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Whether the job's `retryUntil()` deadline (if any) has already passed. */
function retryDeadlinePassed(job: { retryUntil?(): Date | number }): boolean {
  const deadline = job.retryUntil?.();

  if (deadline === undefined) {
    return false;
  }

  const at = deadline instanceof Date ? deadline.getTime() : deadline;

  return Date.now() >= at;
}

interface WorkOptions {
  connection?: string;
  queue?: string;
  sleep: string;
  once?: boolean;
  tries?: string;
  timeout?: string;
  backoff?: string;
  memory?: string;
  maxJobs?: string;
  maxTime?: string;
  stopWhenEmpty?: boolean;
}

/**
 * The long-running worker loop.
 *
 * ## Why the loop never throws
 *
 * A `queue:work` process is a daemon. Anything that escapes `handle()`
 * ends the process, and, worse, leaves whatever job was in flight
 * reserved, invisible to every other worker until its `retryAfter`
 * elapses. So every failure mode has an explicit home:
 *
 *   - a job that throws → release with backoff, or fail (`failed_jobs`);
 *   - a job whose payload can't be decoded (a referenced model was
 *     deleted) → **fail**, not crash. Rethrowing would unwind the loop
 *     and kill the process on a perfectly ordinary "somebody deleted a
 *     row" event;
 *   - a `failed()` hook or lifecycle listener that throws → logged and
 *     swallowed; it must not turn a handled failure into a dead worker;
 *   - `pop()` itself throwing (the database went away) → logged, sleep,
 *     retry. A transient outage should pause a worker, not end it.
 *
 * ## Stopping
 *
 * `SIGINT`/`SIGTERM` (the latter being what orchestrators send) stop the
 * loop after the current job. `--max-jobs`, `--max-time`, `--memory` and
 * `queue:restart` do the same, on the assumption that the process is
 * under a supervisor that will start a fresh one. Which is also how a
 * leaking job stops taking the host down with it.
 */
export class QueueWorkCommand extends Command {
  signature = "queue:work";
  description = "Process jobs from the queue until stopped (Ctrl+C or SIGTERM).";

  /** The connection this worker is draining, chained jobs stay on it. */
  private connection?: string;
  /** The named queue this worker is draining, chained jobs stay on it too. */
  private queue?: string;
  /** `--tries`, overriding each job's own `maxAttempts` when given. */
  private tries?: number;
  /** `--timeout`, the fallback soft timeout for jobs that define none. */
  private timeoutSeconds?: number;
  /** `--backoff`, the fallback release delay for jobs that define no `backoff()`. */
  private backoffSeconds?: number;

  configure(program: CommanderCommand): void {
    program.option("--connection <name>", "Queue connection to work");
    program.option("--queue <name>", "Named queue to drain (default: the connection's own)");
    program.option("--sleep <seconds>", "Seconds to sleep when no job is available", "3");
    program.option(
      "--once",
      "Process a single job (or wait once), then exit — mainly for tests/scripts",
    );
    program.option(
      "--tries <n>",
      "Attempts before a job is marked failed, overriding its maxAttempts",
    );
    program.option("--timeout <seconds>", "Soft timeout for jobs that don't define timeout()");
    program.option("--backoff <seconds>", "Retry delay for jobs that don't define backoff()");
    program.option("--memory <mb>", "Stop once the process exceeds this heap usage", "128");
    program.option("--max-jobs <n>", "Stop after processing this many jobs");
    program.option("--max-time <seconds>", "Stop after running this many seconds");
    program.option("--stop-when-empty", "Stop as soon as the queue is empty (for batch/CI runs)");
  }

  async handle(options: WorkOptions): Promise<void> {
    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const registry = this.app.make<JobRegistry>(JOB_REGISTRY_TOKEN);
    const driver = manager.connection(options.connection);

    this.connection = options.connection;
    this.queue = options.queue;
    this.tries = numeric(options.tries);
    this.timeoutSeconds = numeric(options.timeout);
    this.backoffSeconds = numeric(options.backoff);

    const sleepMs = (numeric(options.sleep) ?? 3) * 1000;
    const memoryLimitMb = numeric(options.memory) ?? 128;
    const maxJobs = numeric(options.maxJobs);
    const maxSeconds = numeric(options.maxTime);
    const deadline = maxSeconds !== undefined ? Date.now() + maxSeconds * 1000 : undefined;

    // The restart cutoff is read ONCE, at startup: a `queue:restart` that
    // lands later writes a newer timestamp, and the comparison below then
    // says "you started before the restart was requested, stop".
    const startedAt = Date.now();
    let processed = 0;

    let running = true;
    // SIGTERM is the standard graceful-shutdown signal sent by
    // containerized/orchestrated deployments (Docker/Kubernetes),
    // trapping only SIGINT would leave the worker unable to finish an
    // in-flight job cleanly before being force-killed in that setting.
    const untrap = trap(["SIGINT", "SIGTERM"], () => {
      running = false;
    });

    try {
      do {
        const job = await this.popSafely(driver, sleepMs);

        if (job === undefined) {
          if (options.once || options.stopWhenEmpty) {
            break;
          }

          await sleep(sleepMs);

          if (await this.shouldStop({ startedAt, deadline, memoryLimitMb })) {
            break;
          }

          continue;
        }

        // Each job is its own invocation: a fresh id, a fresh Context
        // overlay, a fresh container scope. This is the event that marks
        // a job being picked up, so every log line the job produces (and
        // every lifecycle event it fires) is correlatable back to it.
        //
        // The Context overlay matters independently of the id here. A
        // `queue:work` process is a daemon that can run for days, so
        // without a per-job scope anything a job adds to the context
        // accumulates in the process-global store and leaks into the log
        // lines of every job that follows it.
        await runInvocationScope(this.app, () => this.processJob(driver, registry, job));
        processed += 1;

        if (options.once) {
          break;
        }

        if (maxJobs !== undefined && processed >= maxJobs) {
          break;
        }

        if (await this.shouldStop({ startedAt, deadline, memoryLimitMb })) {
          break;
        }
      } while (running);
    } finally {
      untrap();
    }
  }

  /**
   * `pop()`, but an infrastructure failure pauses the worker instead of
   * ending it. A database blipping out for ten seconds must not take
   * every worker in the fleet down with it, and if the outage is
   * permanent, a supervisor restarting a crashed worker in a tight loop
   * is strictly worse than one that sleeps and retries.
   *
   * Returns `undefined` for both "nothing to do" and "couldn't ask",
   * which the caller treats identically: sleep, then go round again.
   */
  private async popSafely(driver: QueueDriver, sleepMs: number): Promise<QueuedJob | undefined> {
    try {
      return await driver.pop(this.queue);
    } catch (error) {
      this.app.logger.error("queue: failed to reserve a job; retrying after a pause.", { error });
      await sleep(sleepMs);

      return undefined;
    }
  }

  /**
   * Whether the loop should stop after the job it just finished: memory
   * ceiling crossed, `--max-time` elapsed, or a `queue:restart` was
   * signalled after this worker started.
   *
   * All three assume a supervisor (systemd, Kubernetes, PM2) restarts the
   * process. Stopping is how a worker picks up new code, and how a slow
   * memory leak in a job gets bounded instead of OOM-killing the host.
   */
  private async shouldStop(limits: {
    startedAt: number;
    deadline: number | undefined;
    memoryLimitMb: number;
  }): Promise<boolean> {
    if (limits.deadline !== undefined && Date.now() >= limits.deadline) {
      this.app.logger.info("queue: --max-time reached; stopping.");

      return true;
    }

    const usedMb = process.memoryUsage().heapUsed / 1024 / 1024;

    if (usedMb >= limits.memoryLimitMb) {
      this.app.logger.info("queue: memory limit reached; stopping.", {
        usedMb: Math.round(usedMb),
        limitMb: limits.memoryLimitMb,
      });

      return true;
    }

    const restartAt = await restartSignalledAt(this.app);

    if (restartAt !== undefined && restartAt > limits.startedAt) {
      this.app.logger.info("queue: restart signalled; stopping.");

      return true;
    }

    return false;
  }

  private async processJob(
    driver: QueueDriver,
    registry: JobRegistry,
    queued: QueuedJob,
  ): Promise<void> {
    let JobClass;
    try {
      JobClass = registry.resolve(queued.jobClass);
    } catch (error) {
      // Unknown job class, nothing sensible to retry; move straight to failed_jobs.
      await this.failJob(driver, queued, undefined, error as Error);

      return;
    }

    // Rebuild the live job from its persisted state, rehydrating any
    // `{ __model, __id }` fields back into live model instances. A model
    // whose class opted into `deleteWhenMissingModels` and no longer exists
    // throws `SkipJobMissingModelError`, treat that as "job completed"
    // (remove it, don't fail/retry).
    let job: Job;
    try {
      job = await decodeJob(this.app, JobClass, queued.state);
    } catch (error) {
      if (error instanceof SkipJobMissingModelError) {
        await driver.delete(queued);
        // The referenced model is gone, treat as completed and free the
        // uniqueness lock so a fresh instance can be queued. Rebuild a
        // bare instance purely to read its unique markers/`uniqueId()`.
        await this.releaseUniqueForMissing(JobClass, queued);

        return;
      }

      // Any other decode failure, most commonly a referenced model that
      // was deleted while the job sat in the queue, with the default
      // `deleteWhenMissingModels = false`, is a failure of THIS JOB, not
      // of the worker. Rethrowing here would unwind the loop and kill the
      // process, stranding the job reserved: not in failed_jobs, invisible
      // to `queue:failed`, gone.
      await this.failJob(driver, queued, undefined, error as Error);

      return;
    }

    // A job that has already burned its attempts never reaches the catch
    // block below. It was reclaimed after killing or outliving its
    // workers, so nothing ever "threw". Laravel checks this before
    // running for the same reason; without it such a job cycles between
    // reserve and reclaim forever.
    const maxAttempts = this.maxAttemptsFor(job);

    if (queued.attempts >= maxAttempts) {
      await this.failJob(
        driver,
        queued,
        job,
        new MaxAttemptsExceededError(queued.jobClass, queued.attempts, maxAttempts),
      );

      return;
    }

    // `untilProcessing`: free the uniqueness lock now that a worker has
    // started this job, so a fresh instance can be queued while it runs.
    // `untilFinished` keeps its lock until the job is deleted/failed below.
    const uniqueMode = uniqueModeOf(job);

    if (uniqueMode === "untilProcessing") {
      await releaseUniqueLock(this.app, queued.jobClass, job);
    }

    await this.fireJobEvent(new JobProcessing(this.connection, job, queued));

    try {
      await runWithTimeout(
        runJobThroughMiddleware(this.app, job),
        job.timeout?.() ?? this.timeoutSeconds,
      );
      await driver.delete(queued);

      // Success ends the job → free an `untilFinished` lock (a no-op for
      // any other mode). Not released on the `release()`/retry paths below,
      // since the job is still pending.
      if (uniqueMode === "untilFinished") {
        await releaseUniqueLock(this.app, queued.jobClass, job);
      }

      await this.fireJobEvent(new JobProcessed(this.connection, job, queued));
      await this.dispatchNextInChain(queued);
    } catch (error) {
      // A middleware asking to reschedule (rate limit hit, lock held, …).
      // Not a failure in itself, but `release()` still bumps `attempts`,
      // so a job whose lock is never free would otherwise be released
      // forever. Bounding it by the same attempt budget is what turns
      // "spins until the heat death of the universe" into "fails, loudly,
      // after N tries".
      if (error instanceof ReleaseJobError) {
        if (queued.attempts + 1 >= maxAttempts) {
          await this.failJob(driver, queued, job, error);
        } else {
          await driver.release(queued, error.delaySeconds);
        }

        return;
      }

      // A `retryUntil()` deadline that has passed sends the job straight to
      // failed_jobs even if attempts remain (matches Laravel's precedence).
      const attemptsExhausted = queued.attempts + 1 >= maxAttempts;

      if (attemptsExhausted || retryDeadlinePassed(job)) {
        await this.failJob(driver, queued, job, error as Error);
      } else {
        const attempt = queued.attempts + 1;
        const delay =
          job.backoff?.(attempt) ?? this.backoffSeconds ?? defaultBackoffSeconds(attempt);
        await driver.release(queued, delay);
      }
    }
  }

  /**
   * Record a job as failed: move it to the driver's failed store, then
   * notify (`failed()` hook, then the `JobFailed` event), in that order,
   * so the hook cannot veto the record.
   *
   * Both notifications are best-effort. A `failed()` hook that throws is
   * a bug in *one job*; letting it escape here would unwind the worker
   * loop and kill the process, which is a far worse outcome than a logged
   * error. `job` is undefined when the failure happened before the
   * instance could be built (unknown class, undecodable payload). There
   * is simply no hook to call in that case.
   */
  private async failJob(
    driver: QueueDriver,
    queued: QueuedJob,
    job: Job | undefined,
    error: Error,
  ): Promise<void> {
    await driver.fail(queued, error);

    if (job) {
      // A terminal failure ends the job → free an `untilFinished`
      // uniqueness lock (a no-op for other modes), so the same job can be
      // dispatched again after it lands in failed_jobs.
      if (uniqueModeOf(job) === "untilFinished") {
        await releaseUniqueLock(this.app, queued.jobClass, job);
      }

      try {
        await job.failed?.(error);
      } catch (hookError) {
        this.app.logger.error("queue: a job's failed() hook threw.", {
          job: queued.jobClass,
          error: hookError,
        });
      }
      await this.fireJobEvent(new JobFailed(this.connection, job, queued, error));
    }
  }

  /**
   * Free a unique job's lock when its live instance couldn't be built (a
   * referenced model was deleted). Rebuilds a bare prototype instance
   * purely so `releaseUniqueLock` can read the same markers/`uniqueId()`
   * the dispatcher locked on. Best-effort; never throws.
   */
  private async releaseUniqueForMissing(JobClass: JobClass, queued: QueuedJob): Promise<void> {
    const bare = Object.assign(Object.create(JobClass.prototype), queued.state) as Job;

    if (uniqueModeOf(bare) === undefined) {
      return;
    }

    await releaseUniqueLock(this.app, queued.jobClass, bare);
  }

  /** `--tries` when given, else the job's own `maxAttempts`. */
  private maxAttemptsFor(job: Job): number {
    return this.tries ?? job.maxAttempts;
  }

  /**
   * After a job succeeds, dispatch the next link in its chain (if any),
   * carrying the remaining links forward, so the chain advances one job at
   * a time. Uses the same connection and queue the worker is draining.
   *
   * Pushes the next link's already-serialized `state` straight onto the
   * driver rather than routing back through `QueueManager.dispatch()`.
   * The state was encoded once at the original dispatch, so re-encoding a
   * (now rehydrated) job would be wasteful and, for a link that was never
   * rebuilt here, isn't even possible.
   *
   * It does still take the uniqueness lock that `dispatch()` would have
   * (`acquireUniqueLockForState`): uniqueness applies to each link of a
   * chain independently, and a tail link that skipped the lock could
   * enqueue a duplicate of a job already queued. A held lock drops this
   * link, and, with it, the rest of the chain behind it, since the
   * remaining links ride on this push. That is the same "a duplicate is a
   * silent no-op" contract `dispatch()` has, so it is logged rather than
   * being invisible.
   */
  private async dispatchNextInChain(queued: QueuedJob): Promise<void> {
    if (!queued.chain || queued.chain.length === 0) {
      return;
    }

    const [next, ...rest] = queued.chain;

    if (!next) {
      return;
    }

    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const driver = manager.connection(this.connection);

    const registry = this.app.make<JobRegistry>(JOB_REGISTRY_TOKEN);
    let NextClass: JobClass;
    try {
      NextClass = registry.resolve(next.jobClass);
    } catch (error) {
      // An unregistered link cannot be pushed at all. Log it: the chain
      // stops here either way, and a silent stop is the worst outcome.
      this.app.logger.error(
        "queue: a chained job's class is not registered; the chain stops here.",
        {
          job: next.jobClass,
          error,
        },
      );

      return;
    }

    // Same resolution `QueueManager.dispatch()` uses: an unnamed worker is
    // draining the default connection, so that is whose `uniqueFor`
    // default applies.
    const uniqueFor = manager.connectionConfig(
      this.connection ?? manager.getDefaultDriver(),
    )?.uniqueFor;
    const acquired = await acquireUniqueLockForState(
      this.app,
      next.jobClass,
      NextClass,
      next.state,
      uniqueFor,
    );

    if (!acquired) {
      this.app.logger.info(
        "queue: a chained job was dropped because an identical unique job is already queued.",
        { job: next.jobClass },
      );

      return;
    }

    await driver.push(next.jobClass, next.state, {
      chain: rest,
      ...(queued.queue !== undefined ? { queue: queued.queue } : {}),
    });
  }

  /**
   * Dispatch a queue lifecycle event through `@mahiframework/events`, but
   * only if an events provider is registered. The queue package works
   * standalone (events is a soft dependency here), so this is a no-op when
   * `EVENTS_TOKEN` is unbound. Failures in a listener are swallowed and
   * logged: an observer crashing must never derail the worker or turn a
   * successful job into a failed one.
   */
  private async fireJobEvent(event: AbstractEvent): Promise<void> {
    if (!this.app.has(EVENTS_TOKEN)) {
      return;
    }

    try {
      const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);
      await dispatcher.dispatch(event);
    } catch (error) {
      this.app.logger.error("queue: job lifecycle listener threw", { error });
    }
  }
}

/**
 * Parse a Commander string option to a finite number, or `undefined`.
 *
 * `undefined` for garbage rather than `NaN`: every caller falls back to a
 * sensible default, so `--tries abc` behaving as "no --tries" is much
 * better than it silently making `attempts >= NaN` false forever.
 */
function numeric(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}
