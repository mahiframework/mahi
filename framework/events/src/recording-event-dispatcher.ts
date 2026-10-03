import { inTransaction, type Application } from "@mahiframework/core";
import { AbstractEvent, dispatchesAfterCommit, type EventMatcher } from "./event.js";
import { EventDispatcher } from "./event-dispatcher.js";

/** A recorded dispatch: the event, and whether it was an after-commit dispatch. */
interface RecordedEvent {
  event: AbstractEvent;
  /**
   * Whether this dispatch would have been deferred until the enclosing
   * transaction commits, i.e. it was marked (or explicitly dispatched)
   * after-commit AND a transaction was actually open. A fake records at
   * the point `dispatch()` is *called* (it doesn't really defer), so this
   * captures the intent for `assertDispatchedAfterCommit()`.
   */
  afterCommit: boolean;
}

/**
 * The event equivalent of Laravel's `Event::fake()`.
 *
 * A drop-in `EventDispatcher` subclass that **records** every `dispatch()`
 * call and then **suppresses** all real work, no `listen()` listeners run,
 * no `listenQueued()` jobs are enqueued, no `afterDispatch()` callbacks
 * (broadcasting, auditing, ...) fire. This is the crucial difference from
 * `Event.suppress()`, which *also* stops listeners but records nothing:
 * with a `RecordingEventDispatcher` a test can prove code *tried* to
 * dispatch `PostCreated` without any of its side effects happening.
 *
 * Swap it in for the real dispatcher for a test run (see
 * `@mahiframework/testing`'s `createTestApplication({ fakeEvents: true })`),
 * then assert:
 *
 *   dispatcher.assertDispatched(PostCreated);
 *   dispatcher.assertDispatched(PostCreated, (e) => e.postId === post.id);
 *   dispatcher.assertNotDispatched(PostDeleted);
 *   expect(dispatcher.dispatched(PostCreated)).toHaveLength(1);
 *
 * `registrations`/`afterCallbacks` are still recorded normally via the
 * inherited `listen()`/`afterDispatch()` (so provider boot wiring doesn't
 * throw). They simply never *run*, exactly like `Event::fake()`.
 *
 * Assertions throw a plain `Error` on failure rather than using a vitest
 * matcher, keeping this package free of any test-runner dependency.
 */
export class RecordingEventDispatcher extends EventDispatcher {
  private recorded: RecordedEvent[] = [];

  constructor(app: Application) {
    super(app);
  }

  /**
   * Record the event and return without running any listener, queued
   * listener, or afterDispatch callback. Events whose name matches an
   * active `Event.suppress()` pattern are neither recorded nor run. This
   * keeps `suppress()` meaning "as if never dispatched" even under a fake.
   *
   * An event marked `static shouldDispatchAfterCommit` is recorded as
   * after-commit *when a transaction is open*, matching how it would
   * actually behave (deferred inside a transaction, immediate outside).
   */
  override async dispatch<E extends AbstractEvent>(event: E): Promise<void> {
    if (AbstractEvent.isSuppressed(event.eventName)) {
      return;
    }

    this.recorded.push({ event, afterCommit: dispatchesAfterCommit(event) && inTransaction() });
  }

  /**
   * Record `event` as an explicit after-commit dispatch, the fake
   * counterpart of `EventDispatcher.dispatchAfterCommit()`. Marked
   * after-commit only when a transaction is actually open.
   */
  override async dispatchAfterCommit<E extends AbstractEvent>(event: E): Promise<void> {
    if (AbstractEvent.isSuppressed(event.eventName)) {
      return;
    }

    this.recorded.push({ event, afterCommit: inTransaction() });
  }

  /**
   * Every recorded event of type `eventClass`, in dispatch order (all
   * recorded events when called with no argument). Optionally filtered by
   * a predicate on the event instance.
   */
  dispatched<E extends AbstractEvent>(
    eventClass?: EventMatcher<E>,
    filter?: (event: E) => boolean,
  ): E[] {
    let matches = (
      eventClass === undefined
        ? this.recorded.map((r) => r.event)
        : this.recorded.filter((r) => r.event instanceof eventClass).map((r) => r.event)
    ) as E[];

    if (filter) {
      matches = matches.filter(filter);
    }

    return matches;
  }

  /** Whether an event of `eventClass` was dispatched (optionally matching `filter`). */
  hasDispatched<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    filter?: (event: E) => boolean,
  ): boolean {
    return this.dispatched(eventClass, filter).length > 0;
  }

  /**
   * Assert an event of `eventClass` was dispatched at least once. With a
   * `filter`, at least one matching event must exist. Throws on failure.
   */
  assertDispatched<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    filter?: (event: E) => boolean,
  ): void {
    if (!this.hasDispatched(eventClass, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected event [${eventClass.name}] to have been dispatched${detail}, but it was not. ` +
          `Dispatched events: ${this.describeDispatched()}.`,
      );
    }
  }

  /**
   * Assert an event of `eventClass` was never dispatched. With a `filter`,
   * assert no *matching* event exists. Throws on failure.
   */
  assertNotDispatched<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    filter?: (event: E) => boolean,
  ): void {
    if (this.hasDispatched(eventClass, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected event [${eventClass.name}] not to have been dispatched${detail}, but it was.`,
      );
    }
  }

  /**
   * Assert an event of `eventClass` was dispatched exactly `times` times
   * (optionally counting only events matching `filter`). Throws on
   * failure.
   *
   * The assertion `assertDispatched()` can't make: "fired once, not
   * twice" is exactly the shape of a double-dispatch bug, and
   * `assertNotDispatched()` only covers the zero case.
   */
  assertDispatchedTimes<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    times: number,
    filter?: (event: E) => boolean,
  ): void {
    const actual = this.dispatched(eventClass, filter).length;

    if (actual !== times) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected event [${eventClass.name}] to have been dispatched ${times} time(s)${detail}, ` +
          `but it was dispatched ${actual} time(s).`,
      );
    }
  }

  /**
   * Assert an event of `eventClass` was dispatched **after commit**, i.e.
   * marked `static shouldDispatchAfterCommit` (or dispatched via
   * `dispatchAfterCommit()`) while a transaction was open. Throws on
   * failure.
   *
   * The assertion that proves the classic bug this feature guards against
   * is fixed: an event dispatched inside a transaction that a listener
   * could otherwise observe before (or despite) a rollback.
   */
  assertDispatchedAfterCommit<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    filter?: (event: E) => boolean,
  ): void {
    const matches = this.recorded.filter(
      (r) => r.event instanceof eventClass && (!filter || filter(r.event as E)),
    );

    if (!matches.some((r) => r.afterCommit)) {
      throw new Error(
        `Expected event [${eventClass.name}] to have been dispatched after commit, but ` +
          (matches.length === 0
            ? "it was not dispatched at all."
            : "every dispatch of it was immediate. Mark it `static shouldDispatchAfterCommit` " +
              "or dispatch it via dispatchAfterCommit() inside a transaction."),
      );
    }
  }

  /** Assert nothing at all was dispatched. Throws on failure. */
  assertNothingDispatched(): void {
    if (this.recorded.length > 0) {
      throw new Error(
        `Expected no events to have been dispatched, but found: ${this.describeDispatched()}.`,
      );
    }
  }

  /** Discard all recorded events, handy from a `beforeEach()` for per-test isolation. */
  reset(): void {
    this.recorded = [];
  }

  private describeDispatched(): string {
    if (this.recorded.length === 0) {
      return "(none)";
    }

    return this.recorded.map((r) => r.event.constructor.name).join(", ");
  }
}
