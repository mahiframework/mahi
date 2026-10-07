import { CACHE_TOKEN, type Application } from "@mahiframework/core";
import type { CacheManager, CacheStore } from "@mahiframework/cache";

/**
 * The cache keys coordinating a process across its workers and hosts.
 *
 * Cache values rather than OS signals for the reason `queue:restart`
 * gives: a deploy has no way to enumerate the PIDs of workers spread
 * across hosts, but every one of them can read one key.
 *
 * Deferral and pause are deliberately SEPARATE keys. They differ in who
 * clears them — a deferral expires on its own TTL, a pause persists
 * until an operator lifts it — and conflating them would make
 * `watchtower:unpause` able to cancel a rate-limit cooldown, which would
 * resume hammering the API that asked for the wait.
 */
export function deferralKey(process: string): string {
  return `watchtower:defer:${process}`;
}

export function pauseKey(process: string): string {
  return `watchtower:pause:${process}`;
}

/** The key covering every process at once, written by a bare `watchtower:pause`. */
export const GLOBAL_PAUSE_KEY = "watchtower:pause";

/** A worker's liveness beacon, read by `watchtower:status`. */
export function heartbeatKey(runId: string): string {
  return `watchtower:worker:${runId}`;
}

/**
 * What a worker is waiting for, if anything.
 *
 * `paused` outranks `deferredUntil` when both are set, because a pause
 * is an operator decision and a deferral is a transient one.
 */
export interface WaitState {
  paused: boolean;
  /** Epoch ms until which this process must not reserve, or `undefined`. */
  deferredUntil: number | undefined;
}

/**
 * An in-memory cache store makes every one of these keys per-process,
 * which turns a cooldown into a no-op that LOOKS configured.
 *
 * `queue:restart` fails soft here and the schedule locker substitutes
 * lock files, but neither applies: there is no better mechanism to fall
 * back to, and the thing being configured is ordering rather than an
 * optimisation. A `fifo` process on an array store would keep reserving
 * jobs throughout what an operator believes is a backoff, hammering the
 * API that asked it to wait. That is worse than refusing to start.
 *
 * Detected by constructor name, the same check `runDueTasks()` uses, for
 * the same reason: the store is resolved from config and there is no
 * interface bit that says "shared".
 */
export function isSharedStore(store: CacheStore): boolean {
  return store.constructor?.name !== "ArrayCacheStore";
}

/**
 * Coordinates pause and deferral state through the cache.
 *
 * Every read fails soft — a cache outage must not stop a worker, and
 * "cannot tell whether we are deferred" resolves to "not deferred"
 * rather than stalling the queue. A write that fails is logged and
 * propagates, because a deferral that was not recorded is a cooldown
 * that will not happen and the caller needs to know.
 */
export class DeferralStore {
  constructor(
    private readonly app: Application,
    private readonly storeName?: string,
  ) {}

  /** The resolved store, or `undefined` when no cache is registered at all. */
  store(): CacheStore | undefined {
    if (!this.app.has(CACHE_TOKEN)) {
      return undefined;
    }

    return this.app.make<CacheManager>(CACHE_TOKEN).store(this.storeName);
  }

  /**
   * Whether this process may reserve right now, and why not if it may
   * not.
   *
   * One method rather than `isPaused()` + `deferredUntil()` because the
   * worker asks both questions on every poll and a single call keeps it
   * to one round trip per key rather than inviting two.
   */
  async waitState(process: string): Promise<WaitState> {
    const store = this.store();

    if (!store) {
      return { paused: false, deferredUntil: undefined };
    }

    try {
      const [globalPause, processPause, deferred] = await Promise.all([
        store.get<boolean>(GLOBAL_PAUSE_KEY),
        store.get<boolean>(pauseKey(process)),
        store.get<number | string>(deferralKey(process)),
      ]);

      const until = deferred === undefined || deferred === null ? NaN : Number(deferred);

      return {
        paused: globalPause === true || processPause === true,
        deferredUntil: Number.isFinite(until) && until > Date.now() ? until : undefined,
      };
    } catch (error) {
      this.app.logger.error("watchtower: could not read process wait state.", {
        process,
        error,
      });

      return { paused: false, deferredUntil: undefined };
    }
  }

  /**
   * Hold `process` off reserving for `seconds`.
   *
   * The TTL is the cooldown itself, so the key clears without anyone
   * having to remember to clear it. A crashed worker therefore cannot
   * leave a process deferred forever, which a persistent key would.
   */
  async defer(process: string, seconds: number): Promise<void> {
    const store = this.store();

    if (!store) {
      return;
    }

    // One extra second of TTL, so a reader comparing against `Date.now()`
    // at the instant the cooldown ends sees the key expire rather than
    // racing the comparison.
    await store.put(deferralKey(process), Date.now() + seconds * 1000, Math.ceil(seconds) + 1);
  }

  /** Clear a cooldown early. Used by `watchtower:unpause --force`. */
  async clearDeferral(process: string): Promise<void> {
    await this.store()?.forget(deferralKey(process));
  }

  /**
   * Stop a process (or every process) reserving until explicitly
   * resumed.
   *
   * No TTL: a pause is an operator decision and must outlive any worker
   * that might be running, which has no upper bound.
   */
  async pause(process?: string): Promise<boolean> {
    const store = this.store();

    if (!store) {
      return false;
    }

    await store.put(process === undefined ? GLOBAL_PAUSE_KEY : pauseKey(process), true);

    return true;
  }

  async unpause(process?: string): Promise<boolean> {
    const store = this.store();

    if (!store) {
      return false;
    }

    await store.forget(process === undefined ? GLOBAL_PAUSE_KEY : pauseKey(process));

    return true;
  }

  /**
   * Record that a worker is alive.
   *
   * TTL'd rather than cleared on exit, so a worker killed with `-9` ages
   * out instead of appearing alive forever. `watchtower:status` counts
   * live keys rather than asking the supervisor, because the supervisor's
   * in-memory view is wrong the moment a second one runs on another host.
   */
  async heartbeat(runId: string, payload: WorkerHeartbeat, ttlSeconds: number): Promise<void> {
    await this.store()?.put(heartbeatKey(runId), payload, ttlSeconds);
  }

  /**
   * One worker's last heartbeat, or `undefined`.
   *
   * Fails soft for the reason every read here does: a status read asks
   * this once per published run id, and an unreadable cache should cost
   * the worker count rather than the whole page.
   */
  async heartbeatFor(runId: string): Promise<WorkerHeartbeat | undefined> {
    try {
      return await this.store()?.get<WorkerHeartbeat>(heartbeatKey(runId));
    } catch (error) {
      this.app.logger.error("watchtower: could not read a worker heartbeat.", { runId, error });

      return undefined;
    }
  }
}

/** What a worker publishes about itself on each poll. */
export interface WorkerHeartbeat {
  runId: string;
  process: string;
  pid: number;
  startedAt: number;
  beatAt: number;
  /** The job it is currently working, if any. */
  jobClass: string | null;
  processed: number;
}
