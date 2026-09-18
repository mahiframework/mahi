import type { JobState } from "./job-serialization.js";

/**
 * One link of a job chain, a job to dispatch (by registered name) with
 * its persisted `state` (the serialized job-instance fields), once the job
 * it's chained behind succeeds. A chain is just an ordered array of these.
 */
export interface ChainedJob {
  jobClass: string;
  state: JobState;
}

export interface QueuedJob {
  /**
   * The driver's handle for this job, opaque to callers and passed back
   * to `ack()`/`retry()` as-is. A `bigint` snowflake on the database
   * driver, a string elsewhere.
   */
  id: string | bigint;
  jobClass: string;
  /** The serialized job-instance fields, rebuilt into a live job via `decodeJob()`. */
  state: JobState;
  /**
   * How many times this job has been attempted, **including the attempt
   * about to happen's predecessors**: 0 on the first pop, 1 after one
   * release, and incremented on reclaim too (a worker that died holding
   * the job burned an attempt). See `QueueDriver.pop()`.
   */
  attempts: number;
  /** The named queue this job was popped from, carried so a release/fail puts it back on the same one. */
  queue?: string;
  /**
   * Remaining jobs to dispatch, in order, once this job succeeds. The
   * worker pops the first link off, dispatches it (carrying the rest of
   * the chain forward), and so on until the chain is empty. `undefined`/
   * empty for an unchained job.
   */
  chain?: ChainedJob[];
}

/**
 * Options accepted by `QueueDriver.push()`. `chain` carries the remaining
 * links to run after this job succeeds (see `ChainedJob`); `queue` names
 * the logical queue to push onto (the driver's own default when omitted).
 */
export interface PushOptions {
  delaySeconds?: number;
  chain?: ChainedJob[];
  queue?: string;
}

/**
 * The operations a worker loop (and `dispatch()`) needs. `SyncQueueDriver`
 * and `DatabaseQueueDriver` are the two built-in implementations;
 * `@mahiframework/redis` adds `RedisQueueDriver`. See `docs/queues/README.md`
 * for the full design.
 */
export interface QueueDriver {
  push(jobClass: string, state: JobState, options?: PushOptions): Promise<void>;
  /**
   * Reserve the next due job on `queue` (the driver's default when
   * omitted), or `undefined` when there is nothing to do.
   *
   * Reserving is exclusive, two concurrent `pop()`s never return the
   * same job, but **not permanent**: a durable driver reclaims a job
   * whose worker stopped responding after that connection's
   * `retryAfterSeconds`, returning it with `attempts` incremented. That
   * is what makes a `kill -9` recoverable, and it is also why delivery is
   * at-least-once: a job that merely stalls past the timeout can run
   * twice. Write `handle()` to be idempotent.
   */
  pop(queue?: string): Promise<QueuedJob | undefined>;
  /** Retry later, used when a job throws but hasn't exhausted maxAttempts. */
  release(job: QueuedJob, delaySeconds?: number): Promise<void>;
  /** Success, remove the job permanently. */
  delete(job: QueuedJob): Promise<void>;
  /** Exhausted maxAttempts, move to failed_jobs (or equivalent). */
  fail(job: QueuedJob, error: Error): Promise<void>;
  /**
   * Optional, push once the enclosing database transaction commits, or
   * immediately when there is none. What `Bus.dispatch(job, { afterCommit:
   * true })` calls; drivers without a transaction to observe simply omit
   * it and the dispatch happens immediately.
   */
  pushAfterCommit?(jobClass: string, state: JobState, options?: PushOptions): Promise<void>;
  /** Optional, how many jobs are pending on a queue. Backs monitoring and `queue:clear`'s report. */
  size?(queue?: string): Promise<number>;
  /** Optional, delete every pending job on a queue without running it (`queue:clear`). Returns the count. */
  clear?(queue?: string): Promise<number>;
}

/** Narrowing guard, whether a resolved driver can defer a push until commit. */
export function supportsAfterCommit(
  driver: QueueDriver,
): driver is QueueDriver & Required<Pick<QueueDriver, "pushAfterCommit">> {
  return typeof driver.pushAfterCommit === "function";
}

/** Narrowing guard, whether a resolved driver holds pending jobs that can be counted/cleared. */
export function supportsClearing(
  driver: QueueDriver,
): driver is QueueDriver & Required<Pick<QueueDriver, "size" | "clear">> {
  return typeof driver.clear === "function" && typeof driver.size === "function";
}
