import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUIDv7 } from "node:crypto";

/**
 * The id of the single unit of work the process is currently doing: one
 * HTTP request, one queue job, one CLI command.
 *
 * It exists to make logs correlatable. A log line on its own says what
 * happened; a log line carrying an invocation id says what happened
 * *during what*, which is the difference between reading a concurrent
 * server's output and guessing at it. Every entry point writes this into
 * the `ContextRepository` (see `runInvocationScope()`), so
 * `formatLogLine()` appends it to every line without any call site
 * passing it.
 *
 * ```ts
 * Invocation.id();     // "01a11521-ebe0-71f6-bc76-199e0b807ad4"
 * Invocation.reset();  // next id() call generates a fresh one
 * ```
 *
 * ## Lazy, then stable
 *
 * The id is generated on the first `id()` call and memoized, so an
 * invocation that never logs and never asks never pays for one, and an
 * invocation that asks twice gets the same answer both times. `reset()`
 * drops it; the next `id()` generates again.
 *
 * ## A UUIDv7, deliberately
 *
 * A v7 UUID is a 48-bit millisecond timestamp followed by 74 bits of
 * entropy, which gives this the three properties an invocation id needs:
 *
 * - **time-sortable**, so ids sort chronologically in a log aggregator;
 * - **no coordination**, uniqueness comes from entropy rather than from
 *   an operator assigning a distinct node id per process. Several
 *   processes, containers or hosts generate ids concurrently with no
 *   shared state and no configuration. A scheme that derives uniqueness
 *   from a configured worker id instead produces *duplicate ids* when two
 *   processes share that config, which for the one value whose entire job
 *   is to disambiguate concurrent work is the worst possible failure;
 * - **synchronous and cheap** (~80ns), which it must be: this is read
 *   from `formatLogLine()`, and a log formatter cannot await.
 *
 * Ordering is millisecond-granular — two ids from the same millisecond
 * have no guaranteed order relative to each other. For correlating log
 * lines that is irrelevant, since the id is an identity, not a sequence.
 *
 * ## Per-invocation isolation
 *
 * Backed by `AsyncLocalStorage`, for the same reason `ContextRepository`
 * and `@mahiframework/auth`'s `auth-context.ts` are: this framework boots
 * ONE long-lived `Application` and serves every request from it, so a
 * plain static field would be shared by every request in flight. One
 * request's `reset()` would then be observed by another mid-flight, and
 * two concurrent requests would log the same invocation id — which is
 * precisely the confusion the id exists to remove.
 *
 * So `runInvocationScope()` opens a fresh holder per invocation and
 * `id()`/`reset()` act on whichever one is active. Outside any scope
 * (boot, a test, a script) they fall back to a process-global holder, so
 * the API behaves identically whether or not a scope is open and callers
 * never have to check.
 */

/** The memoized id for one invocation. Mutable so `reset()` can clear it in place. */
interface InvocationState {
  id: string | null;
}

const storage = new AsyncLocalStorage<InvocationState>();

/**
 * The process-global holder, used outside any `runInvocationScope()`.
 * Boot, a CLI script that never opens a scope, a test.
 */
const globalState: InvocationState = { id: null };

export class Invocation {
  /**
   * The id of the current invocation, generating and memoizing one on
   * first call.
   *
   * Never `null` — it generates on demand. `current()` is the variant
   * that reports absence instead.
   */
  static id(): string {
    const state = storage.getStore() ?? globalState;

    state.id ??= randomUUIDv7();

    return state.id;
  }

  /**
   * Forget the current invocation id, so the next `id()` call generates a
   * fresh one. Called at the start of each request, job and command by
   * `runInvocationScope()`.
   */
  static reset(): void {
    const state = storage.getStore() ?? globalState;
    state.id = null;
  }

  /**
   * The memoized id, WITHOUT generating one if it is absent. For callers
   * that want to annotate something with the invocation id only if the
   * invocation already has one, and must not be the reason it gets one.
   */
  static current(): string | null {
    return (storage.getStore() ?? globalState).id;
  }

  /** Whether an invocation scope is active on this call stack. */
  static hasScope(): boolean {
    return storage.getStore() !== undefined;
  }

  /**
   * Run `fn` with a fresh, isolated invocation id holder, starting empty
   * so the first `id()` inside generates a new one.
   *
   * Prefer `runInvocationScope()`, which also opens the matching
   * `Context` and container scopes and publishes the id for logging. This
   * is the lower-level primitive, for an entry point that manages those
   * itself.
   */
  static runScoped<T>(fn: () => T): T {
    return storage.run({ id: null }, fn);
  }
}
