import type { Application } from "@mahiframework/core";
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
   */
  async runIds(name: string): Promise<string[]> {
    const store = this.deferrals.store();

    if (!store) {
      return [];
    }

    return (await store.get<string[]>(`watchtower:workers:${name}`)) ?? [];
  }

  /** Publish the run ids a supervisor is currently running for a process. */
  async publishRunIds(name: string, runIds: string[], ttlSeconds: number): Promise<void> {
    await this.deferrals.store()?.put(`watchtower:workers:${name}`, runIds, ttlSeconds);
  }

  /** The application, for callers holding only the manager. */
  application(): Application {
    return this.app;
  }
}
