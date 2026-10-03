import {
  hasActiveSuppression,
  isNameSuppressed,
  runWithEventsSuppressed,
} from "./event-suppression.js";

/**
 * Base class for application events. An event is just a typed payload,
 * subclass it and add whatever properties are relevant.
 *
 *   class TodoCreated extends AbstractEvent {
 *     constructor(public readonly todoId: string) { super(); }
 *   }
 *
 * `Event.suppress()`/`Event.isSuppressed()` are static (not per-subclass).
 * See their own docstrings below. `eventName` is an instance getter,
 * override it on a subclass to participate in wildcard suppression
 * patterns under a name other than the default (its constructor name):
 *
 *   class PostCreated extends AbstractEvent {
 *     get eventName(): string { return "model.posts.created"; }
 *   }
 */
export abstract class AbstractEvent {
  /**
   * A stable, explicit name for this event class, used to key listener
   * registrations and queued-listener ids. Set it on any event that will
   * have a **queued** listener, or that could collide with a same-named
   * class in another module. `constructor.name` is neither collision-safe
   * across modules nor survives a minifier that mangles class names:
   *
   *   class OrderPlaced extends AbstractEvent {
   *     static eventName = "billing.OrderPlaced";
   *   }
   *
   * Left unset, the runtime falls back to `constructor.name`, which is fine
   * for inline (non-queued) listeners in an unminified app.
   */
  static eventName?: string;

  /**
   * This event instance's name for `Event.suppress()`/`isSuppressed()`
   * pattern matching, the class's stable `static eventName` when set,
   * otherwise the constructor's name (`"TodoCreated"`, ...).
   * `@mahiframework/database`'s `ModelLifecycleEvent` overrides this getter to
   * `"model.{table}.{event}"` (e.g. `"model.posts.created"`), so
   * `Post.withoutEvents()` can suppress just that model's events via the
   * `"model.posts.*"` pattern rather than every event in the app.
   */
  get eventName(): string {
    return (this.constructor as typeof AbstractEvent).eventName ?? this.constructor.name;
  }

  /**
   * Runs `callback` with event dispatch suppressed for every name
   * matching one of `patterns` (default `["*"]`, everything), every
   * `EventDispatcher.dispatch()` call made synchronously or via nested
   * async calls inside `callback` becomes a no-op for a matching event
   * (listeners never run), with zero call-site changes needed inside it.
   * AsyncLocalStorage-scoped (see `event-suppression.ts`), same pattern
   * `@mahiframework/database`'s `transaction()`/`Model.withoutEvents()`
   * use. Always returns a `Promise`, even for a sync callback, so callers
   * can `await` uniformly.
   *
   * Patterns are dot-segmented with `*` as a wildcard matching any run of
   * characters. `"model.posts.*"` matches `"model.posts.created"`,
   * `"model.posts.updated"`, etc.; a bare `"*"` (the default) matches
   * every event name. Nested `suppress()` calls stack (patterns
   * concatenate, they don't replace what's already active), so
   * `Model.withoutEvents()`-style helpers scoped to one model can nest
   * inside a broader `Event.suppress()` call and both stay in effect.
   *
   * Consumers that dispatch outside `EventDispatcher` entirely (e.g.
   * `@mahiframework/database`'s `ModelObserver`/`Model.on()` hooks, invoked
   * directly rather than as `Event` instances) check `isSuppressed(name)`
   * themselves at their own dispatch point, passing the equivalent
   * `"model.{table}.{event}"` name. See `Model.withoutEvents()`, which
   * delegates to this with a `"model.{table}.*"` (or `"model.*"` when
   * called on the base `Model` class) pattern.
   *
   *   await Event.suppress(async () => {
   *     await Events.dispatch(new TodoCreated(todo)); // no-op, no listeners run
   *   });
   *
   *   await Event.suppress(callback, ["model.posts.*"]); // only Post's model events
   */
  static suppress<T>(callback: () => T | Promise<T>, patterns: string[] = ["*"]): Promise<T> {
    return runWithEventsSuppressed(callback, patterns);
  }

  /**
   * With no argument: whether ANY suppression is currently active at all
   * (inside any `suppress()` call, scoped or not), the simple boolean
   * check most callers want. Pass a specific event name (e.g.
   * `"model.posts.created"`) to check whether THAT name matches an
   * active suppression pattern instead. See `suppress()`'s docstring
   * for the wildcard pattern syntax.
   */
  static isSuppressed(name?: string): boolean {
    return name === undefined ? hasActiveSuppression() : isNameSuppressed(name);
  }
}

export type EventClass<E extends AbstractEvent = AbstractEvent> = (new (...args: any[]) => E) & {
  eventName?: string;
  shouldDispatchAfterCommit?: boolean;
};

/**
 * An event class used only as a MATCHING key, which may be abstract.
 *
 * `EventClass` requires a concrete constructor because its other use is
 * construction: `dispatchesEvents` maps are instantiated as
 * `new EventClass(payload)`. `listen()` never constructs the event class
 * it is given, it only tests dispatched events against it with
 * `instanceof`, and an abstract class is a perfectly good right-hand
 * operand there.
 *
 * Insisting on a concrete constructor for a key that is never called made
 * the framework's own documented "observe everything" pattern,
 * `listen(AbstractEvent, ...)`, fail to typecheck, along with the same
 * shape over any abstract family base (`@mahiframework/auth`'s
 * `AuthEvent`, `@mahiframework/database`'s `ModelLifecycleEvent`). Those
 * are precisely the registrations an audit log wants, since enumerating
 * every subclass silently misses whichever one is added next.
 */
export type EventMatcher<E extends AbstractEvent = AbstractEvent> = (abstract new (
  ...args: any[]
) => E) & {
  eventName?: string;
  shouldDispatchAfterCommit?: boolean;
};

/**
 * Opt an event class into after-commit dispatch, Laravel's
 * `ShouldDispatchAfterCommit`. Set the **static** marker and every
 * `Events.dispatch(new OrderPlaced(...))` inside a `DB.transaction()`
 * holds its listeners until the transaction commits, and drops them
 * entirely if it rolls back. Outside a transaction it dispatches
 * immediately, so no call site changes:
 *
 *   class OrderPlaced extends AbstractEvent {
 *     static shouldDispatchAfterCommit = true;
 *     constructor(public readonly order: Order) { super(); }
 *   }
 *
 * It's a static (not a `broadcastAfterCommit()`-style instance method)
 * because, like `eventName`, it's intrinsic to the class and read at the
 * dispatch site without an instance in hand. `Events.dispatchAfterCommit()`
 * is the explicit, per-call form when you don't want to mark the class.
 */
export function dispatchesAfterCommit(event: AbstractEvent): boolean {
  return (event.constructor as EventClass).shouldDispatchAfterCommit === true;
}

/**
 * The stable registration name for an event *class*: its explicit
 * `static eventName` when declared, otherwise the class's runtime name.
 * Used to key listener registrations and queued-listener ids so they don't
 * collide across modules or break under name-mangling minifiers.
 *
 * Takes an `EventMatcher`, the wider of the two class types, because it
 * reads statics only and never constructs. An abstract family base
 * (`AuthEvent`, `ModelLifecycleEvent`) is a legitimate argument.
 */
export function eventClassName(eventClass: EventMatcher): string {
  return eventClass.eventName ?? eventClass.name;
}
