import type { Application } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { StatsReader } from "./stats-reader.js";
import type { JobRunSummary, JobTypeDetail, JobTypeSummary, WatchtowerStats } from "./stats.js";
import { DeferralStore, type WorkerHeartbeat } from "./deferral.js";
import { GateAlreadyRegisteredError, UnknownProcessError } from "./errors.js";
import type { ResolvedProcessConfig, ResolvedWatchtowerConfig } from "./watchtower-config.js";

/**
 * Who may view the dashboard.
 *
 * The user is non-nullable: a guest has no identity to authorize, so
 * unlike a `Gate` ability there is no `null` arm for a callback to
 * handle. The middleware refuses an unauthenticated request before the
 * gate is reached, so a gate never has to begin with a null check.
 *
 * No rest parameters. A gate here answers exactly one question about
 * exactly one user; anything else it needs (a request, a tenant) it can
 * close over or read from the ambient context.
 */
export type WatchtowerGate<TUser = unknown> = (user: TUser) => boolean | Promise<boolean>;

/**
 * The package's service: configuration, process state, and the gate.
 *
 * Bound as a singleton at `WATCHTOWER_TOKEN`. Deliberately holds no
 * database or queue handle — it resolves those per call, so a long-lived
 * worker picks up a reconnected driver rather than caching a dead one.
 */
export class WatchtowerManager {
  private gateCallback: WatchtowerGate | null = null;
  private readonly deferrals: DeferralStore;

  constructor(
    private readonly app: Application,
    private readonly config: ResolvedWatchtowerConfig,
  ) {
    this.deferrals = new DeferralStore(app);
  }

  // ---------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------

  /**
   * Define who may view the dashboard. Until this is called, NOBODY can:
   * the default is deny-all, so installing the package and configuring
   * `dashboard` grants nothing.
   *
   *   Watchtower.gate<User>((user) => user.isSuperadmin());
   *
   * Call it from a provider's `boot()`, not `register()`: a callback
   * that resolves anything from the container would otherwise depend on
   * provider order.
   *
   * Registering twice THROWS rather than replacing. There is one answer
   * to "who may view the queue", and a silently-replacing registry would
   * make a stray second call a security change nobody reviewed — while
   * an appending one would make the answer depend on provider order.
   *
   * Deliberately not a `Gate` ability. `can("view-watchtower")` would
   * read better but would make `@mahiframework/authorization` a hard
   * dependency, and would interact with the permissions package's
   * `before()` hook: an app that happens to have a PERMISSION named
   * `view-watchtower` would grant dashboard access through a path nobody
   * audited. A dedicated gate cannot be reached by accident. An app that
   * wants it routed through the Gate writes exactly that:
   *
   *   Watchtower.gate((user) => Gate.forUser(user).allows("view-watchtower"));
   */
  gate<TUser = unknown>(gate: WatchtowerGate<TUser>): this {
    if (this.gateCallback !== null) {
      throw new GateAlreadyRegisteredError();
    }

    this.gateCallback = gate as WatchtowerGate;

    return this;
  }

  /**
   * Whether a gate has been registered.
   *
   * Public so `watchtower:check` can report its absence without
   * attempting a request.
   */
  hasGate(): boolean {
    return this.gateCallback !== null;
  }

  /**
   * Whether `user` may view the dashboard.
   *
   * `false` for a guest and `false` with no gate registered — the two
   * cases the middleware distinguishes in its log line but not in its
   * response, because the status code should not reveal which.
   */
  async allows(user: unknown): Promise<boolean> {
    if (user === null || user === undefined || this.gateCallback === null) {
      return false;
    }

    return (await this.gateCallback(user)) === true;
  }

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------

  /** The resolved config, with every default applied. */
  configuration(): ResolvedWatchtowerConfig {
    return this.config;
  }

  /** Every configured process, in declaration order. */
  processes(): readonly ResolvedProcessConfig[] {
    return this.config.processes;
  }

  /** One process by name, or throw `UnknownProcessError`. */
  process(name: string): ResolvedProcessConfig {
    const found = this.config.processes.find((candidate) => candidate.name === name);

    if (!found) {
      throw new UnknownProcessError(
        name,
        this.config.processes.map((candidate) => candidate.name),
      );
    }

    return found;
  }

  /** Every queue any process drains, deduplicated. */
  queues(): string[] {
    return [...new Set(this.config.processes.flatMap((process) => [...process.queues]))];
  }

  // ---------------------------------------------------------------------
  // Process state
  // ---------------------------------------------------------------------

  /** The cache-backed pause/defer/heartbeat store. */
  store(): DeferralStore {
    return this.deferrals;
  }

  /** Pause one process, or every process when `name` is omitted. */
  pause(name?: string): Promise<boolean> {
    if (name !== undefined) {
      this.process(name);
    }

    return this.deferrals.pause(name);
  }

  /** Resume one process, or every process when `name` is omitted. */
  unpause(name?: string): Promise<boolean> {
    if (name !== undefined) {
      this.process(name);
    }

    return this.deferrals.unpause(name);
  }

  /** Every live worker heartbeat for a process. */
  async workers(name: string): Promise<WorkerHeartbeat[]> {
    const process = this.process(name);
    const found: WorkerHeartbeat[] = [];

    // Heartbeats are keyed by run id, which is unguessable, so they
    // cannot be enumerated from the cache. The supervisor publishes the
    // ids it spawned under the process key; absent that (no supervisor
    // running, or a different host) this reports nothing rather than
    // guessing.
    for (const runId of await this.runIds(process.name)) {
      const beat = await this.deferrals.heartbeatFor(runId);

      if (beat) {
        found.push(beat);
      }
    }

    return found;
  }

  /**
   * The run ids the supervisor last published for a process.
   *
   * Stored as a list under one key rather than discovered by scanning:
   * `CacheStore` has no key-pattern search, deliberately, and a `SCAN`
   * would be Redis-specific.
   *
   * Fails soft, like every other read in `DeferralStore`: an unreadable
   * cache reports no workers rather than propagating, so one unavailable
   * number cannot take down a whole status read.
   */
  async runIds(name: string): Promise<string[]> {
    const store = this.deferrals.store();

    if (!store) {
      return [];
    }

    try {
      return (await store.get<string[]>(`watchtower:workers:${name}`)) ?? [];
    } catch (error) {
      this.app.logger.error("watchtower: could not read published worker run ids.", {
        process: name,
        error,
      });

      return [];
    }
  }

  /** Publish the run ids a supervisor is currently running for a process. */
  async publishRunIds(name: string, runIds: string[], ttlSeconds: number): Promise<void> {
    await this.deferrals.store()?.put(`watchtower:workers:${name}`, runIds, ttlSeconds);
  }

  // ---------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------

  /**
   * The read model.
   *
   * Built fresh per call rather than held, so it cannot cache a stale
   * database handle across a reconnect in a long-lived worker.
   */
  reader(): StatsReader {
    return new StatsReader(this.app, this.config, this.deferrals, (name) => this.runIds(name));
  }

  /** The overview: totals, processes, queues, job types, recent failures. */
  stats(windowHours?: number): Promise<WatchtowerStats> {
    return this.reader().stats(windowHours);
  }

  /**
   * The overview, reused for up to `ttlSeconds` across callers.
   *
   * A full read is expensive: every job type's runs in the window are
   * loaded to compute its percentiles, and the dashboard asks for all of
   * it on every poll of every open tab. Those polls are the only caller
   * that benefits, and they are the reason this exists.
   *
   * Separate from `stats()` rather than folded into it, because a cached
   * read is the wrong default for a public API: an operator running
   * `watchtower:status` straight after `watchtower:pause` must not be
   * shown the pre-pause answer. A caller opts in only where staleness is
   * already part of the contract.
   *
   * Fails soft in both directions — no cache store, or a cache that
   * errors, degrades to a live read rather than an error page. An
   * in-memory store makes this per-process rather than fleet-wide, which
   * still collapses one process's concurrent viewers to one read.
   */
  async cachedStats(ttlSeconds: number, windowHours?: number): Promise<WatchtowerStats> {
    const store = this.deferrals.store();

    if (!store || ttlSeconds <= 0) {
      return this.stats(windowHours);
    }

    const key = `watchtower:stats:${windowHours ?? "default"}`;

    try {
      // Via the lock, because a burst of viewers arriving on an expired
      // key is exactly the stampede this is meant to prevent: without it
      // the first poll after each expiry runs the full read once per tab.
      return await store.rememberViaLock(key, () => this.stats(windowHours), ttlSeconds);
    } catch (error) {
      this.app.logger.error("watchtower: could not read cached stats.", { error });

      return this.stats(windowHours);
    }
  }

  /** Rolling aggregates per job type, busiest first. */
  async jobTypes(windowHours = 24): Promise<JobTypeSummary[]> {
    return this.reader().jobTypes(DateTime.now().subHours(windowHours));
  }

  /** One job type with its recent runs and attempt chains. */
  jobType(name: string, windowHours?: number): Promise<JobTypeDetail | undefined> {
    return this.reader().jobTypeDetail(name, windowHours);
  }

  /** Failures across every job type, newest first. */
  recentFailures(limit?: number): Promise<JobRunSummary[]> {
    return this.reader().recentFailures(limit);
  }

  /** The application, for callers holding only the manager. */
  application(): Application {
    return this.app;
  }
}
