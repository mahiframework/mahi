import type { EventMatcher } from "./event.js";
import type { ListenerClass, ListenerFn } from "./listener.js";
import type { WildcardListener } from "./event-dispatcher.js";

/**
 * One entry of a provider's `listeners()` hook: either an event class
 * paired with a listener class/closure, or an event-**name** wildcard
 * pattern paired with a listener class/callback.
 *
 * Deliberately not generic over the event type. A hook returns a
 * heterogeneous array covering many unrelated events, so there is no
 * single `E` to infer; a per-pair generic would need existential types
 * TypeScript doesn't have. The consequence is that a closure in a pair
 * gets `AbstractEvent`, not the narrowed event, use a `ListenerClass`
 * (which declares its own `Listener<E>`) when you want the typed payload
 * from the hook, or register the closure via `Events.listen()` /
 * `dispatcher.listen()`, where inference does work.
 */
export type ListenerRegistration =
  | readonly [EventMatcher, ListenerClass | ListenerFn]
  | readonly [string, ListenerClass | WildcardListener];

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Return `[EventClass, ListenerClass]` pairs to wire into the
     * EventDispatcher. Collected during the events package's own
     * ServiceProvider boot, after every provider's register() has run.
     *
     * An event-name wildcard pattern is accepted in place of the event
     * class (`["model.posts.*", AuditModelWrites]`), and a closure in
     * place of the listener class, so the hook now covers everything
     * `listen()` does, and a provider only needs to drop to a manual
     * `boot()` for `listenQueued()`.
     *
     * The pairs are `readonly`: the collector only iterates them, and
     * requiring mutable tuples would reject the natural way to write the
     * hook, `return [[TodoCreated, LogTodo]] as const`, since a `const`
     * assertion produces readonly tuples.
     */
    listeners?(): ReadonlyArray<ListenerRegistration>;
  }
}
