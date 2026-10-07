import { Manager, type Application } from "@mahiframework/core";
import { supportsAfterCommit, type PushOptions, type QueueDriver } from "./queue-driver.js";
import type { Job } from "./job.js";
import { JobRegistry } from "./job-registry.js";
import { encodeJob } from "./job-serialization.js";
import { acquireUniqueLock } from "./unique-jobs.js";
import { JOB_REGISTRY_TOKEN } from "./tokens.js";

/**
 * One connection's config. Everything here is read by the connection's
 * own factory (see `QueueServiceProvider`) except `afterCommit`, which
 * `QueueManager.dispatch()` reads directly to decide whether a dispatch
 * with no explicit `afterCommit` option should be deferred.
 */
export interface QueueConnectionConfig {
  /**
   * Defer every dispatch on this connection until the enclosing database
   * transaction commits, Laravel's `after_commit`. Off by default
   * (dispatch happens immediately), and always overridable per dispatch
   * with `{ afterCommit: false }`.
   *
   * Turning it on for a durable connection is the safe default for most
   * apps: it removes the entire class of "worker popped the job before
   * the row it references was committed" bug.
   */
  afterCommit?: boolean;
  /**
   * Default TTL (in **seconds**) for the uniqueness lock of a
   * `ShouldBeUnique` job dispatched on this connection, overridable
   * per-job with `uniqueFor()`. The lock's crash safety net, a worker
   * that dies mid-job holds the lock only this long. Defaults to 3600.
   */
  uniqueFor?: number;
  [key: string]: unknown;
}

export interface QueueConfig {
  default: string;
  connections: Record<string, QueueConnectionConfig>;
}

/** Options accepted by `QueueManager.dispatch()`. */
export interface DispatchOptions {
  delaySeconds?: number;
  connection?: string;
  /** The named queue to push onto. The connection's own default when omitted. */
  queue?: string;
  chain?: Job[];
  /**
   * Defer the push until the enclosing database transaction commits (and
   * skip it entirely if that transaction rolls back). Defaults to the
   * connection's `afterCommit` config, then to `false`.
   */
  afterCommit?: boolean;
  /**
   * Ordering hint within the target queue, higher first. Silently ignored
   * by connections that cannot honour it — see `PushOptions.priority`.
   *
   * For ordering ACROSS queues, give the worker an ordered queue list
   * instead; that works on every connection.
   */
  priority?: number;
}

/**
 * Resolves named queue connections (`"sync"`, `"database"`), synchronously,
 * exactly like `DatabaseManager`/`CacheManager`. Built-in connections are
 * registered via `extend()` by `QueueServiceProvider`.
 */
export class QueueManager extends Manager<QueueDriver> {
  constructor(
    app: Application,
    private config: QueueConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /** Domain-flavored alias for `driver()`, mirroring `DatabaseManager.connection()`. */
  connection(name?: string): QueueDriver {
    return this.driver(name);
  }

  /**
   * Test-only: force a connection to resolve to `driver`, bypassing its
   * registered factory (and any previously-cached instance). Defaults to
   * the *default* connection, so a `Queue::fake()`-style helper can make
   * `dispatch()` (which uses the default connection) record into a
   * `FakeQueueDriver` with a single call. See
   * `@mahiframework/testing`'s `createTestApplication({ fakeQueue: true })`.
   */
  swap(driver: QueueDriver, name?: string): void {
    this.resolved.set(name ?? this.getDefaultDriver(), driver);
  }

  connectionConfig(name: string): QueueConnectionConfig | undefined {
    return this.config.connections[name];
  }

  /**
   * Enqueue a job INSTANCE (`dispatch(new SomeJob(...))`). The job's class
   * must be registered (via a provider's `jobs()` hook) so it can be
   * reconstructed by name in a worker process; its own fields are
   * serialized (with any live `Model` encoded to a `{ __model, __id }`
   * reference, rehydrated before `handle()` runs) into the persisted
   * state.
   *
   * Note: for the `sync` connection this resolves only once the job has
   * *finished running* (there is no separate queue state); for `database`
   * (and any future durable driver) it resolves once the job is *enqueued*,
   * not once it runs. This asymmetry is inherent to what "sync" means,
   * switching `QUEUE_CONNECTION` from `sync` to `database` changes what
   * `await` actually waits for.
   *
   * ## Dispatching inside a transaction
   *
   * `{ afterCommit: true }` (or `afterCommit: true` on the connection's
   * config) holds the push until the enclosing `DB.transaction()`
   * commits, and drops it if that transaction rolls back. Without it the
   * classic pattern
   *
   *   await DB.transaction(async () => {
   *     const order = await Order.create({ ... });
   *     await Bus.dispatch(new ChargeOrderJob(order));
   *   });
   *
   * is a race: a worker can pop the job and fail to find the order,
   * because the transaction hasn't committed yet.
   *
   * ## Unique jobs
   *
   * A job class marked `static unique` (see `ShouldBeUnique`) acquires a
   * cache lock at dispatch keyed by its name + `uniqueId()`. If an
   * identical job is already queued (or running, for `untilFinished`),
   * this returns `false` **without pushing**. The duplicate is silently
   * dropped, matching Laravel. Returns `true` for a job that was actually
   * enqueued (and for every non-unique job).
   */
  async dispatch(job: Job, options?: DispatchOptions): Promise<boolean> {
    const registry = this.app.make<JobRegistry>(JOB_REGISTRY_TOKEN);
    const driver = this.driver(options?.connection);

    const name = registry.nameFor(job);

    // Uniqueness gate: acquire the lock before doing any work. A held lock
    // means an identical job is already queued, drop this dispatch.
    const connectionName = options?.connection ?? this.getDefaultDriver();
    const uniqueForDefault = this.connectionConfig(connectionName)?.uniqueFor;
    const acquired = await acquireUniqueLock(this.app, name, job, uniqueForDefault);

    if (!acquired) {
      return false;
    }

    const state = encodeJob(this.app, job);
    // Built field by field rather than spread from `options`: the two
    // shapes differ (`chain` is encoded here, `connection`/`afterCommit`
    // are this method's own concerns), so a driver never receives a
    // dispatch-level option it has no meaning for. Anything a driver is
    // meant to see has to be listed here.
    const pushOptions: PushOptions = {
      delaySeconds: options?.delaySeconds,
      queue: options?.queue,
      priority: options?.priority,
      chain: options?.chain?.map((link) => ({
        jobClass: registry.nameFor(link),
        state: encodeJob(this.app, link),
      })),
    };

    if (this.shouldDispatchAfterCommit(job, options) && supportsAfterCommit(driver)) {
      await driver.pushAfterCommit(name, state, pushOptions);

      return true;
    }

    await driver.push(name, state, pushOptions);

    return true;
  }

  /**
   * Whether this dispatch should wait for the enclosing transaction, in
   * precedence order: the explicit per-dispatch option, then the job
   * class's own `afterCommit` default, then the connection's config.
   *
   * Explicit-beats-declarative throughout, so `{ afterCommit: false }`
   * can always opt one dispatch out of a connection-wide default (a job
   * that deliberately wants to run against uncommitted state, e.g. one
   * dispatched from a listener already running after the commit).
   */
  private shouldDispatchAfterCommit(job: Job, options?: DispatchOptions): boolean {
    if (options?.afterCommit !== undefined) {
      return options.afterCommit;
    }

    if (job.afterCommit !== undefined) {
      return job.afterCommit;
    }

    const name = options?.connection ?? this.getDefaultDriver();

    return this.connectionConfig(name)?.afterCommit ?? false;
  }

  /**
   * Dispatch an ordered chain of job INSTANCES. Each link runs only after
   * the one before it succeeds. Sugar over `dispatch()`: the first job in
   * the list is dispatched with the rest attached as its `chain`. An empty
   * list is a no-op.
   *
   *   await queue.chain([
   *     new ChargeOrderJob(order),
   *     new ShipOrderJob(order),
   *     new NotifyCustomerJob(order),
   *   ]);
   */
  async chain(jobs: Job[], options?: Omit<DispatchOptions, "chain">): Promise<void> {
    const [first, ...rest] = jobs;

    if (!first) {
      return;
    }

    await this.dispatch(first, { ...options, chain: rest });
  }
}
