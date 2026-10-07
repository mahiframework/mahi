import { Facade } from "@mahiframework/facades";
import type { WatchtowerManager, WatchtowerGate } from "./watchtower-manager.js";
import type { ResolvedProcessConfig } from "./watchtower-config.js";
import type { WorkerHeartbeat } from "./deferral.js";
import type { JobRunSummary, JobTypeDetail, JobTypeSummary, WatchtowerStats } from "./stats.js";
import { WATCHTOWER_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `WatchtowerManager` singleton bound at
 * `WATCHTOWER_TOKEN`.
 *
 *   Watchtower.gate<User>((user) => user.isSuperadmin());
 *   await Watchtower.pause("xero");
 *
 * `Watchtower.instance()` comes from the `Facade` mixin and returns the
 * manager itself, for anything not surfaced here.
 *
 * Prefer constructor-injecting `WatchtowerManager` (via
 * `WATCHTOWER_TOKEN`) where that is practical; use this where threading
 * `app` through is genuinely inconvenient — which registering the gate
 * from a provider's `boot()` is.
 */
export class Watchtower extends Facade<WatchtowerManager>(() => WATCHTOWER_TOKEN) {
  /**
   * Define who may view the dashboard. Until this is called, NOBODY can.
   *
   *   Watchtower.gate<User>((user) => user.isSuperadmin());
   *
   * Call it once, from a provider's `boot()`. Calling it twice throws.
   * See `WatchtowerManager.gate()`.
   */
  static gate<TUser = unknown>(gate: WatchtowerGate<TUser>): void {
    this.instance().gate(gate);
  }

  /** Whether a gate has been registered. */
  static hasGate(): boolean {
    return this.instance().hasGate();
  }

  /** Whether `user` may view the dashboard. `false` for a guest or with no gate. */
  static allows(user: unknown): Promise<boolean> {
    return this.instance().allows(user);
  }

  /** Every configured process, in declaration order. */
  static processes(): readonly ResolvedProcessConfig[] {
    return this.instance().processes();
  }

  /** Every queue any process drains, deduplicated. */
  static queues(): string[] {
    return this.instance().queues();
  }

  /** Stop a process (or every process) reserving until resumed. */
  static pause(process?: string): Promise<boolean> {
    return this.instance().pause(process);
  }

  /** Resume a paused process (or every process). */
  static unpause(process?: string): Promise<boolean> {
    return this.instance().unpause(process);
  }

  /** Live worker heartbeats for a process. */
  static workers(process: string): Promise<WorkerHeartbeat[]> {
    return this.instance().workers(process);
  }

  /**
   * The overview: totals, process states, queue depths, job-type
   * aggregates and recent failures.
   *
   * Plain serializable data, so an app rendering its own admin UI can
   * consume this directly instead of adopting the bundled dashboard.
   */
  static stats(windowHours?: number): Promise<WatchtowerStats> {
    return this.instance().stats(windowHours);
  }

  /**
   * The overview, reused across callers for up to `ttlSeconds`.
   *
   * For a UI that polls. A full read loads every run in the window per
   * job type to compute its percentiles, so repeating it per viewer per
   * interval is the dominant cost of leaving a dashboard open; this
   * collapses them onto one read.
   *
   * `stats()` stays live deliberately — a cached read is the wrong
   * default for an operator asking what the queue is doing right now.
   */
  static cachedStats(ttlSeconds: number, windowHours?: number): Promise<WatchtowerStats> {
    return this.instance().cachedStats(ttlSeconds, windowHours);
  }

  /** Rolling aggregates per job type, busiest first. */
  static jobTypes(windowHours?: number): Promise<JobTypeSummary[]> {
    return this.instance().jobTypes(windowHours);
  }

  /** One job type with its recent runs and attempt chains. */
  static jobType(name: string, windowHours?: number): Promise<JobTypeDetail | undefined> {
    return this.instance().jobType(name, windowHours);
  }

  /** Failures across every job type, newest first. */
  static recentFailures(limit?: number): Promise<JobRunSummary[]> {
    return this.instance().recentFailures(limit);
  }
}
