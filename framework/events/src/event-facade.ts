import { Facade } from "@mahiframework/facades";
import type { AbstractEvent, EventClass, EventMatcher } from "./event.js";
import type { EventDispatcher, WildcardListener } from "./event-dispatcher.js";
import type { ListenerClass, ListenerFn } from "./listener.js";
import { EVENTS_TOKEN } from "./events-service-provider.js";

/**
 * Thin facade over the `EventDispatcher` singleton bound at `EVENTS_TOKEN`,
 * for call sites that would otherwise read
 * `app().make<EventDispatcher>(EVENTS_TOKEN).dispatch(...)`.
 *
 *   await Events.dispatch(new TodoCreated(todo));
 *
 * Prefer constructor-injecting `EventDispatcher` (via `EVENTS_TOKEN`)
 * where that's practical (e.g. inside a `ServiceProvider`/`Command`
 * that already receives `app`), use this only at call sites
 * where threading `app`/`EventDispatcher` through is genuinely
 * inconvenient, same guidance as `app()` itself.
 */
export class Events extends Facade<EventDispatcher>(() => EVENTS_TOKEN) {
  static dispatch<E extends AbstractEvent>(event: E): Promise<void> {
    return this.instance().dispatch(event);
  }

  /**
   * Dispatch `event` after the enclosing `DB.transaction()` commits (or
   * immediately when none is open), the explicit per-call form of
   * after-commit dispatch, when you don't want to mark the event class
   * with `static shouldDispatchAfterCommit`. See
   * `EventDispatcher.dispatchAfterCommit()`.
   */
  static dispatchAfterCommit<E extends AbstractEvent>(event: E): Promise<void> {
    return this.instance().dispatchAfterCommit(event);
  }

  /**
   * Register a listener, the facade form of `EventDispatcher.listen()`,
   * for wiring done outside a provider (a bootstrap script, a test setup,
   * a route file) where there's no `app` already in hand:
   *
   *   Events.listen(PostCreated, LogPostCreated);      // listener class
   *   Events.listen(PostCreated, (e) => log(e.postId)); // closure, typed
   *   Events.listen("model.posts.*", AuditModelWrites); // pattern + class
   *   Events.listen("model.posts.*", (e) => log(e.eventName)); // pattern + closure
   *
   * **Prefer a provider's `listeners()` hook** for anything permanent.
   * Registration order is dispatch order, and registrations are
   * append-only for the life of the dispatcher, so calling this from a
   * module that can be imported more than once, or from a request path,
   * silently duplicates listeners. The hook runs exactly once, at boot,
   * which is why it stays the default.
   *
   * Note the two argument forms are **not** interchangeable. An event
   * class matches by `instanceof` and infers `E`, so the handler's `event`
   * is fully typed. A string matches `event.eventName` through the same
   * wildcard matcher as `Event.suppress()`, and cannot narrow. There is
   * no type-level link from a runtime string to an event class. Use the
   * class form unless you genuinely need to match a family of events by
   * name.
   */
  static listen<E extends AbstractEvent>(eventClass: EventMatcher<E>, handler: ListenerFn<E>): void;
  static listen<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    listenerClass: ListenerClass<E>,
  ): void;
  static listen(pattern: string, listener: ListenerClass | WildcardListener): void;
  static listen(
    eventClassOrPattern: EventMatcher | string,
    listenerOrHandler: ListenerClass | ListenerFn | WildcardListener,
  ): void {
    // Cast: the overload set above is the public contract, but the
    // implementation signature's union can't be proven to line up with
    // any single `listen()` overload on the dispatcher.
    (this.instance().listen as (a: unknown, b: unknown) => void)(
      eventClassOrPattern,
      listenerOrHandler,
    );
  }

  /**
   * Register a listener that is enqueued rather than run inline, the
   * facade form of `EventDispatcher.listenQueued()`. Requires
   * `QueueServiceProvider` (or an explicit
   * `useQueuedListenerHandler()`); throws at dispatch time otherwise. No
   * pattern form: a queued listener is keyed by
   * `"{eventName}:{listenerName}"` so the worker can rehydrate the
   * original event class, which a pattern doesn't identify.
   */
  static listenQueued<E extends AbstractEvent>(
    eventClass: EventClass<E>,
    listenerClass: ListenerClass<E>,
  ): void {
    this.instance().listenQueued(eventClass, listenerClass);
  }
}
