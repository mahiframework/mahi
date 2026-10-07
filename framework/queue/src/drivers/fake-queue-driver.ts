import { afterCommit } from "@mahiframework/database";
import type { QueueDriver, QueuedJob, PushOptions, ChainedJob } from "../queue-driver.js";
import type { JobState } from "../job-serialization.js";
import type { JobClass } from "../job.js";
import type { JobRegistry } from "../job-registry.js";

/**
 * How a test names the job it's asserting on: either the registered name
 * (`"posts:log-created"`) or the class itself (`LogPostCreatedJob`).
 *
 * The class form is the one you actually want. It's what the dispatch
 * site says, it survives a rename, and a typo is a compile error rather
 * than a silently-passing `assertNotPushed()`. It requires the driver to
 * know the `JobRegistry` (to map class -> registered name); when the
 * driver was built without one, only the string form is available.
 */
export type JobIdentifier = string | JobClass;

/**
 * A record of one `push()` call captured by `FakeQueueDriver`, the job's
 * registered name, its serialized `state` (the job-instance fields, with
 * any `Model` encoded to a `{ __model, __id }` reference), the
 * `delaySeconds` it was pushed with (0 when dispatched without a delay),
 * its `priority`, and any chain attached to it.
 */
export interface PushedJob {
  jobClass: string;
  state: JobState;
  delaySeconds: number;
  chain: ChainedJob[];
  /** The named queue it was pushed onto, `"default"` unless one was given. */
  queue: string;
  /**
   * Whether the push was deferred until an enclosing transaction commits
   * (`Bus.dispatch(job, { afterCommit: true })`). The fake records the
   * push at the point it was *made*, which for a deferred dispatch is
   * after the commit, so seeing `true` here means "this really was
   * deferred and the transaction really did commit".
   */
  afterCommit: boolean;
  /**
   * The within-queue ordering hint it was pushed with, `0` by default.
   *
   * Recorded even though no built-in driver acts on it: a test asserting
   * that a dispatch asked for a priority is asserting about its own code,
   * not about the driver that would honour it, and dropping the value
   * here would make such a test pass against nothing.
   */
  priority: number;
}

/**
 * The queue equivalent of Laravel's `Queue::fake()` recording driver.
 *
 * Unlike `SyncQueueDriver` (which runs jobs immediately and *for real*,
 * side effects and all), this driver **records** every `push()` into an
 * in-memory array and never executes anything, so a test can assert
 * *what would have been dispatched* without the job's real work happening.
 * `pop()` therefore always returns `undefined` (nothing is ever worked),
 * and `release`/`delete`/`fail` are no-ops, exactly as with the sync
 * driver.
 *
 * Register it like any other connection and point the app at it for a test
 * run:
 *
 *   queueManager.extend("fake", () => new FakeQueueDriver());
 *   // QUEUE_CONNECTION=fake, or createTestApplication(..., { fakeQueue: true })
 *
 * then assert against it, by job CLASS (preferred) or registered name:
 *
 *   driver.assertPushed(LogPostCreatedJob);
 *   driver.assertPushed(LogPostCreatedJob, (job) => job.state.id === post.id);
 *   driver.assertNotPushed(SendWelcomeEmailJob);
 *   expect(driver.pushed(LogPostCreatedJob)).toHaveLength(1);
 *
 * The class form needs a `JobRegistry` (to resolve class -> registered
 * name); `createTestApplication({ fakeQueue: true })` wires it up, and
 * so does the `"fake"` connection registered by `QueueServiceProvider`.
 * Constructed bare (`new FakeQueueDriver()`), only the string form works,
 * passing a class then throws a message saying so, rather than quietly
 * matching nothing.
 *
 * Assertions throw a plain `Error` on failure (not a vitest matcher) so
 * the driver stays runner-agnostic, matching the rest of
 * `@mahiframework/testing`'s "plain functions, compose from vitest" style.
 */
export class FakeQueueDriver implements QueueDriver {
  private jobs: PushedJob[] = [];

  /**
   * Optional, and only used to resolve a `JobClass` to its registered
   * name. Kept optional so a bare `new FakeQueueDriver()` (as in the
   * queue package's own unit tests) still works with string names.
   */
  constructor(private readonly registry?: JobRegistry) {}

  /**
   * Resolve a caller-supplied identifier to the registered job name that
   * `push()` actually recorded.
   */
  private resolveName(job: JobIdentifier): string {
    if (typeof job === "string") {
      return job;
    }

    if (!this.registry) {
      throw new Error(
        `Cannot assert on job class [${job.name}]: this FakeQueueDriver was constructed ` +
          `without a JobRegistry, so it cannot map a class to its registered name. ` +
          `Pass the registered name string instead, or build the driver with a registry.`,
      );
    }

    return this.registry.nameFor(job);
  }

  async push(jobClass: string, state: JobState, options: PushOptions = {}): Promise<void> {
    this.record(jobClass, state, options, false);
  }

  /**
   * Defers the recording until the enclosing transaction commits, exactly
   * as a durable driver defers the real push, so a test can assert that
   * a rolled-back transaction pushed nothing, which is the entire point
   * of `afterCommit`. Runs immediately outside a transaction.
   */
  async pushAfterCommit(
    jobClass: string,
    state: JobState,
    options: PushOptions = {},
  ): Promise<void> {
    await afterCommit(() => {
      this.record(jobClass, state, options, true);
    });
  }

  private record(
    jobClass: string,
    state: JobState,
    options: PushOptions,
    afterCommitFlag: boolean,
  ): void {
    this.jobs.push({
      jobClass,
      state,
      delaySeconds: options.delaySeconds ?? 0,
      chain: options.chain ?? [],
      queue: options.queue ?? "default",
      afterCommit: afterCommitFlag,
      priority: options.priority ?? 0,
    });
  }

  async pop(): Promise<QueuedJob | undefined> {
    return undefined;
  }

  // The parameters are declared (and ignored) rather than omitted: dropping
  // them satisfies `QueueDriver` structurally, but callers holding the
  // concrete class, the normal way a fake is used in a test, would then
  // get "Expected 0 arguments" for the very calls the interface mandates.
  async release(_job: QueuedJob, _delaySeconds?: number): Promise<void> {
    // No-op: a fake never works jobs, so nothing is ever released.
  }

  async delete(_job: QueuedJob): Promise<void> {
    // No-op. See release().
  }

  async fail(_job: QueuedJob, _error: Error): Promise<void> {
    // No-op. See release().
  }

  /**
   * Every recorded push of `job` (a job class or its registered name), in
   * dispatch order, all pushes when called with no argument. Optionally
   * filtered by a predicate on the recorded
   * `{ jobClass, state, delaySeconds }` tuple.
   */
  pushed(job?: JobIdentifier, filter?: (job: PushedJob) => boolean): PushedJob[] {
    if (job === undefined) {
      return filter ? this.jobs.filter(filter) : this.jobs;
    }

    const name = this.resolveName(job);
    let matches = this.jobs.filter((j) => j.jobClass === name);

    if (filter) {
      matches = matches.filter(filter);
    }

    return matches;
  }

  /** Whether `job` was pushed at least once (optionally matching `filter`). */
  hasPushed(job: JobIdentifier, filter?: (job: PushedJob) => boolean): boolean {
    return this.pushed(job, filter).length > 0;
  }

  /**
   * Assert `job` was pushed at least once. With a `filter`, at least
   * one matching push must exist. Throws on failure.
   */
  assertPushed(job: JobIdentifier, filter?: (job: PushedJob) => boolean): void {
    if (!this.hasPushed(job, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected job [${this.resolveName(job)}] to have been pushed${detail}, but it was not. ` +
          `Pushed jobs: ${this.describePushed()}.`,
      );
    }
  }

  /**
   * Assert `job` was never pushed. With a `filter`, assert no
   * *matching* push exists (other pushes of the same class are fine).
   * Throws on failure.
   */
  assertNotPushed(job: JobIdentifier, filter?: (job: PushedJob) => boolean): void {
    if (this.hasPushed(job, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected job [${this.resolveName(job)}] not to have been pushed${detail}, but it was.`,
      );
    }
  }

  /**
   * Assert `job` was pushed exactly `times` times (optionally counting
   * only pushes matching `filter`). Throws on failure.
   *
   * The assertion `assertPushed()` can't make: "this ran once, not twice"
   * is exactly the shape of a duplicate-dispatch bug.
   */
  assertPushedTimes(job: JobIdentifier, times: number, filter?: (job: PushedJob) => boolean): void {
    const actual = this.pushed(job, filter).length;

    if (actual !== times) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected job [${this.resolveName(job)}] to have been pushed ${times} time(s)${detail}, ` +
          `but it was pushed ${actual} time(s).`,
      );
    }
  }

  /**
   * Assert `job` was pushed **after a transaction committed**, i.e.
   * dispatched with `{ afterCommit: true }` (or a connection configured
   * `afterCommit: true`) and the transaction did commit.
   *
   * The assertion that catches the classic bug this feature exists for:
   * a job dispatched inside a transaction that a worker can pop before
   * the rows it references are committed. Throws on failure.
   */
  assertPushedAfterCommit(job: JobIdentifier, filter?: (job: PushedJob) => boolean): void {
    const matches = this.pushed(job, filter);

    if (!matches.some((j) => j.afterCommit)) {
      throw new Error(
        `Expected job [${this.resolveName(job)}] to have been pushed after commit, but ` +
          (matches.length === 0
            ? "it was not pushed at all."
            : "every push of it was immediate. Dispatch it with { afterCommit: true }."),
      );
    }
  }

  /** Assert nothing at all was pushed. Throws on failure. */
  assertNothingPushed(): void {
    if (this.jobs.length > 0) {
      throw new Error(`Expected no jobs to have been pushed, but found: ${this.describePushed()}.`);
    }
  }

  /** Discard all recorded pushes, handy from a `beforeEach()` for per-test isolation. */
  reset(): void {
    this.jobs = [];
  }

  private describePushed(): string {
    if (this.jobs.length === 0) {
      return "(none)";
    }

    return this.jobs.map((j) => j.jobClass).join(", ");
  }
}
