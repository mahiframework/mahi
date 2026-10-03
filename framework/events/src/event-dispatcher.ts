import { afterCommit, type Application } from "@mahiframework/core";
import {
  AbstractEvent,
  dispatchesAfterCommit,
  eventClassName,
  type EventClass,
  type EventMatcher,
} from "./event.js";
import type { Listener, ListenerClass, ListenerFn } from "./listener.js";
import { matchesPattern } from "./event-suppression.js";

interface ClassRegistration {
  kind: "class";
  eventClass: EventMatcher;
  listenerClass: ListenerClass;
}

interface ClosureRegistration {
  kind: "closure";
  eventClass: EventMatcher;
  handler: ListenerFn;
}

interface PatternRegistration {
  kind: "pattern";
  pattern: string;
  handler: WildcardListener;
}

interface PatternClassRegistration {
  kind: "pattern-class";
  pattern: string;
  listenerClass: ListenerClass;
}

interface QueuedRegistration {
  kind: "queued";
  eventClass: EventClass;
  listenerClass: ListenerClass;
}

type Registration =
  | ClassRegistration
  | ClosureRegistration
  | PatternRegistration
  | PatternClassRegistration
  | QueuedRegistration;

/**
 * A callback registered against an event-name wildcard pattern
 * (`"model.posts.*"`) rather than an event class. Receives the dispatched
 * `Event` instance, read `event.eventName` for the matched name.
 */
export type WildcardListener = (event: AbstractEvent) => void | Promise<void>;

/**
 * Payload persisted onto the queue for a `listenQueued()` registration.
 * Rehydrated by `EventDispatcher.runQueuedListener()`.
 */
export interface QueuedListenerPayload {
  id: string;
  data: object;
}

export type QueuedListenerHandler = (payload: QueuedListenerPayload) => void | Promise<void>;

interface QueuedListenerEntry {
  eventClass: EventClass;
  listenerClass: ListenerClass;
}

/**
 * A callback run after every dispatched event, regardless of its class.
 * See `EventDispatcher.afterDispatch()`.
 */
export type AfterDispatchCallback = (event: AbstractEvent) => void | Promise<void>;

function queuedListenerId(eventClass: EventMatcher, listenerClass: ListenerClass): string {
  return `${eventClassName(eventClass)}:${listenerClass.listenerName ?? listenerClass.name}`;
}

/**
 * Distinguish a `ListenerClass` (a constructor whose instances expose
 * `handle()`) from a plain `ListenerFn` closure. Both are functions, so we
 * check for a `handle` method on the prototype, present on listener
 * classes, absent on a bare arrow/function listener.
 */
function isListenerClass(candidate: ListenerClass | ListenerFn): candidate is ListenerClass {
  return typeof candidate === "function" && typeof candidate.prototype?.handle === "function";
}

export class EventDispatcher {
  private registrations: Registration[] = [];
  private afterCallbacks: AfterDispatchCallback[] = [];
  private queuedById = new Map<string, QueuedListenerEntry>();
  private queuedHandler?: QueuedListenerHandler;

  constructor(private app: Application) {}

  /**
   * Register an inline closure listener against an event class:
   * `listen(TodoCreated, (event) => ...)`. Runs synchronously in
   * registration order like a class listener, but without the class
   * ceremony, handy for small, one-off reactions.
   *
   * Declared **before** the listener-class overload deliberately. Overloads
   * resolve in order, and a bare `(event) => ...` is checked against
   * `ListenerClass` first if that comes first, a construct signature it
   * cannot match, so inference fails and `event` silently lands as an
   * implicit `any` (or errors under `noImplicitAny`). Closure first lets
   * `E` infer from the event class, which is what makes `event.email`
   * typed at the call site.
   */
  listen<E extends AbstractEvent>(eventClass: EventMatcher<E>, handler: ListenerFn<E>): void;
  /**
   * Register a listener class against an event class. Listeners are
   * instantiated fresh (with the Application passed to their constructor)
   * each time a matching event is dispatched.
   */
  listen<E extends AbstractEvent>(
    eventClass: EventMatcher<E>,
    listenerClass: ListenerClass<E>,
  ): void;
  /**
   * Register a wildcard listener against an event-name pattern.
   * `"model.posts.*"` matches `"model.posts.created"`; a bare `"*"` matches
   * every event. Same `*`-as-wildcard syntax as `Event.suppress()`.
   *
   * Both a listener **class** and a bare callback are accepted; the class
   * form is constructed fresh per matching dispatch exactly like the
   * event-class form, so a wildcard listener can pull its own dependencies
   * out of the container. Neither form narrows `event` beyond
   * `AbstractEvent`. A pattern is a runtime string with no type-level
   * link to any event class, so there is nothing to infer from. Read
   * `event.eventName` and cast if you need the payload.
   */
  listen(pattern: string, listener: ListenerClass | WildcardListener): void;
  listen(
    eventClassOrPattern: EventMatcher | string,
    listenerOrHandler: ListenerClass | ListenerFn | WildcardListener,
  ): void {
    if (typeof eventClassOrPattern === "string") {
      if (isListenerClass(listenerOrHandler)) {
        this.registrations.push({
          kind: "pattern-class",
          pattern: eventClassOrPattern,
          listenerClass: listenerOrHandler,
        });

        return;
      }

      this.registrations.push({
        kind: "pattern",
        pattern: eventClassOrPattern,
        handler: listenerOrHandler as WildcardListener,
      });

      return;
    }

    if (isListenerClass(listenerOrHandler)) {
      this.registrations.push({
        kind: "class",
        eventClass: eventClassOrPattern,
        listenerClass: listenerOrHandler,
      });

      return;
    }

    this.registrations.push({
      kind: "closure",
      eventClass: eventClassOrPattern,
      handler: listenerOrHandler as ListenerFn,
    });
  }

  /**
   * Register a listener that is enqueued rather than run inline.
   * Requires a handler bound via `useQueuedListenerHandler()`, typically
   * installed by `@mahiframework/queue`'s `QueueServiceProvider`. Explicit
   * method (not a `ShouldQueue` marker + reflection) so the queue
   * integration stays opt-in and magic-free.
   *
   * Throws at dispatch time if no handler is bound.
   */
  listenQueued<E extends AbstractEvent>(
    eventClass: EventClass<E>,
    listenerClass: ListenerClass<E>,
  ): void {
    const id = queuedListenerId(eventClass, listenerClass);
    this.queuedById.set(id, {
      eventClass,
      listenerClass: listenerClass as ListenerClass,
    });
    this.registrations.push({
      kind: "queued",
      eventClass,
      listenerClass: listenerClass as ListenerClass,
    });
  }

  /**
   * Install the enqueue function used by `listenQueued()`. Bound by
   * `QueueServiceProvider`; tests can inject a fake to assert payload
   * shape without standing up a queue.
   */
  useQueuedListenerHandler(handler: QueuedListenerHandler): void {
    this.queuedHandler = handler;
  }

  async enqueueQueuedListener(event: AbstractEvent, listenerClass: ListenerClass): Promise<void> {
    if (!this.queuedHandler) {
      throw new Error(
        "No queued-listener handler is bound. Register QueueServiceProvider, or call EventDispatcher.useQueuedListenerHandler(), before dispatching a listenQueued() event.",
      );
    }

    const id = queuedListenerId(event.constructor as EventClass, listenerClass);
    await this.queuedHandler({
      id,
      data: { ...event },
    });
  }

  /**
   * Rehydrate a queued-listener payload and run the original listener.
   * Invoked by the `events.handle-queued-listener` job in
   * `@mahiframework/queue`.
   */
  async runQueuedListener(payload: QueuedListenerPayload): Promise<void> {
    const entry = this.queuedById.get(payload.id);

    if (!entry) {
      throw new Error(`Queued listener [${payload.id}] is not registered on this dispatcher.`);
    }

    const event = Object.assign(
      Object.create(entry.eventClass.prototype),
      payload.data,
    ) as AbstractEvent;
    const listener: Listener = new entry.listenerClass(this.app);
    await listener.handle(event);
  }

  /**
   * Register a callback run after *every* dispatched event, regardless of
   * its class, and regardless of whether it had any listeners at all.
   *
   * This is deliberately a general capability rather than a hook tailored
   * to any one consumer: it's "run this after every dispatch," which is
   * useful for cross-cutting concerns (auditing, metrics, broadcasting)
   * that don't want to enumerate every event class up front the way
   * `listen()` requires. `@mahiframework/broadcasting` uses it to forward
   * events implementing its own `ShouldBroadcast` marker interface to
   * connected websocket clients, which is what keeps this package free of
   * any dependency on (or knowledge of) broadcasting.
   *
   * Callbacks run sequentially after all listeners, in registration order,
   * and are awaited, so a callback that throws propagates to the
   * `dispatch()` caller. A callback that shouldn't be able to fail a
   * dispatch is responsible for catching its own errors (see
   * `BroadcastServiceProvider.boot()` for the canonical example).
   */
  afterDispatch(callback: AfterDispatchCallback): void {
    this.afterCallbacks.push(callback);
  }

  /**
   * Dispatch an event to every listener registered against its class
   * (and every wildcard listener whose pattern matches `event.eventName`).
   * Listeners run sequentially, in registration order, and are awaited.
   *
   * No-ops entirely, no listeners run, when `event.eventName` matches
   * an active `Event.suppress()` pattern (default pattern `["*"]`
   *
   * matches every event). See `event.ts`'s `Event.suppress()` docstring.
   * Any `afterDispatch()` callbacks then run, also sequentially and
   * awaited, after the last listener has finished.
   *
   * ## After-commit dispatch
   *
   * An event class marked `static shouldDispatchAfterCommit = true` (see
   * `dispatchesAfterCommit()`), dispatched inside a `DB.transaction()`,
   * has its listeners held until the transaction commits, and dropped
   * entirely if it rolls back. Outside a transaction, or unmarked, it
   * dispatches immediately as before. `dispatchAfterCommit()` is the
   * explicit per-call form.
   *
   * The suppression check runs at dispatch time (not deferred), so an
   * event dispatched inside `Event.suppress()` is a no-op regardless of
   * the after-commit marker, matching the "as if never dispatched"
   * contract.
   */
  async dispatch<E extends AbstractEvent>(event: E): Promise<void> {
    if (AbstractEvent.isSuppressed(event.eventName)) {
      return;
    }

    if (dispatchesAfterCommit(event)) {
      await afterCommit(() => this.deliver(event));

      return;
    }

    await this.deliver(event);
  }

  /**
   * Dispatch `event` after the enclosing `DB.transaction()` commits
   * (immediately when none is open), regardless of whether the event
   * class carries the `static shouldDispatchAfterCommit` marker, the
   * explicit, per-call form of after-commit dispatch. Still a no-op when
   * the event is suppressed.
   */
  async dispatchAfterCommit<E extends AbstractEvent>(event: E): Promise<void> {
    if (AbstractEvent.isSuppressed(event.eventName)) {
      return;
    }

    await afterCommit(() => this.deliver(event));
  }

  /**
   * Run `event` through every matching listener and then every
   * `afterDispatch()` callback, the actual delivery, split out so both
   * the immediate and the after-commit-deferred paths share it. The
   * suppression gate is checked by the callers before deferring, so an
   * event whose transaction commits is delivered even if a *later*
   * `suppress()` scope has since ended (the decision was made at dispatch
   * time).
   */
  private async deliver<E extends AbstractEvent>(event: E): Promise<void> {
    for (const registration of this.registrations) {
      if (registration.kind === "class") {
        if (event instanceof registration.eventClass) {
          const listener: Listener = new registration.listenerClass(this.app);
          await listener.handle(event);
        }
      } else if (registration.kind === "closure") {
        if (event instanceof registration.eventClass) {
          await registration.handler(event);
        }
      } else if (registration.kind === "queued") {
        if (event instanceof registration.eventClass) {
          await this.enqueueQueuedListener(event, registration.listenerClass);
        }
      } else if (registration.kind === "pattern-class") {
        if (matchesPattern(event.eventName, registration.pattern)) {
          const listener: Listener = new registration.listenerClass(this.app);
          await listener.handle(event);
        }
      } else if (matchesPattern(event.eventName, registration.pattern)) {
        await registration.handler(event);
      }
    }

    for (const callback of this.afterCallbacks) {
      await callback(event);
    }
  }
}
