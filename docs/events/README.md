# Events

An event is a typed payload class. A listener is a class with `handle()`.
The dispatcher walks its registrations in order and awaits each match.

```ts
import { AbstractEvent } from "@mahiframework/events";

export class PostCreated extends AbstractEvent {
  constructor(public readonly post: PostTable) {
    super();
  }
}
```

```ts
import type { Listener } from "@mahiframework/events";

export class LogPostCreated implements Listener<PostCreated> {
  constructor(private app: Application) {}

  handle(event: PostCreated): void {
    this.app.logger.info("Post created", { id: event.post.id, userId: event.post.user_id });
  }
}
```

```ts
await Events.dispatch(new PostCreated(post));
```

No decorators, no marker interfaces, no reflection. Wiring is an explicit
`[EventClass, ListenerClass]` pair returned from a provider hook.

## `AbstractEvent`

```ts
export abstract class AbstractEvent {
  get eventName(): string { return this.constructor.name; }
  static suppress<T>(callback: () => T | Promise<T>, patterns?: string[]): Promise<T>;
  static isSuppressed(name?: string): boolean;
}
```

The base class carries almost nothing. Subclass it, add constructor
fields, done. There is no `dispatch()` method on the event itself and no
`broadcastAs()`. Broadcasting is opted into by implementing
`ShouldBroadcast` from [`@mahiframework/broadcasting`](../broadcasting/), which
the events package knows nothing about.

### `eventName`

An **instance getter**, defaulting to the constructor's name. It is used
for two things: wildcard listener patterns, and suppression patterns.
Neither uses the class identity, `instanceof` handles that separately.

Override it to participate in a namespace:

```ts
export class PostCreated extends AbstractEvent {
  get eventName(): string { return "model.posts.created"; }
}
```

`@mahiframework/database`'s `ModelLifecycleEvent` does exactly this, returning
`"model.{table}.{event}"`, which is what lets `Post.withoutEvents()`
suppress just that model's events via `"model.posts.*"` rather than
silencing the whole app. See [Models](../models/).

Because it's derived from `constructor.name` by default, a minifier that
mangles class names changes your event names. If you rely on wildcard
patterns in a bundled build, override `eventName` with a literal.

## `Listener`

```ts
export interface Listener<E extends AbstractEvent = AbstractEvent> {
  handle(event: E): void | Promise<void>;
}

export type ListenerClass<E extends AbstractEvent = AbstractEvent> =
  new (app: Application) => Listener<E>;
```

A listener class is constructed with the `Application` and nothing else.
That's the whole dependency-injection story, pull what you need out of
the container in the constructor, or don't declare one at all:

```ts
export class NotifyOnLike implements Listener<PostLiked> {
  async handle(event: PostLiked): Promise<void> {
    const post = await Post.find(event.like.post_id);
    if (post === undefined || post.user_id === event.like.user_id) return;
    await notify(new UserNotifiable(post.user_id), new LikeNotification(/* ... */));
  }
}
```

**A fresh instance is constructed for every dispatch.**

```ts
const listener: Listener = new registration.listenerClass(this.app);
await listener.handle(event);
```

Listeners are stateless by construction. There is no instance to
accumulate state on between dispatches, and no shared object two
concurrent dispatches could race on. Constructor work runs on every
dispatch, so keep it cheap: resolve tokens, don't do I/O.

## Registering listeners

Via a provider's `listeners()` hook, the default, and the one to use
first:

```ts
export class PostsServiceProvider extends ServiceProvider {
  listeners(): ReadonlyArray<ListenerRegistration> {
    return [
      [PostCreated, LogPostCreated],
      [PostCreated, NotifyOnReply],
      ["model.posts.*", AuditModelWrites],
    ];
  }
}
```

One event, several listeners, each with one reason to change.

`EventsServiceProvider.boot()` walks every provider's `listeners()` hook
and calls `dispatcher.listen()` for each pair. All providers are already
instantiated by then, so hook collection is order-independent, but
`boot()` itself runs sequentially in registration order, so list
`EventsServiceProvider` **before** any provider whose own `boot()`
dispatches an event and expects listeners to be wired.

A pair is either `[EventClass, ListenerClass | ListenerFn]` or
`[pattern, ListenerClass | WildcardListener]`:

```ts
type ListenerRegistration =
  | readonly [EventClass, ListenerClass | ListenerFn]
  | readonly [string, ListenerClass | WildcardListener];
```

The type is not generic over the event. A hook returns a heterogeneous
array covering many unrelated events, so there is no single `E` to infer.
A per-pair generic would need existential types TypeScript doesn't
have. A **closure** in a pair therefore receives `AbstractEvent`, not the
narrowed event. Use a `ListenerClass` (which declares its own
`Listener<E>`) when you want the typed payload from the hook, or register
the closure through `listen()`, where inference does work.

`listenQueued()` is the one thing the hook can't express, call the
dispatcher directly in your own `boot()`:

```ts
boot(): void {
  const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);
  dispatcher.listenQueued(PostCreated, GenerateThumbnails);
}
```

See [Providers](../providers/).

### Registering from outside a provider

`Events.listen()` registers against the current `app()`'s dispatcher, for
wiring done where there's no `app` in hand, a bootstrap script, a test
setup:

```ts
Events.listen(PostCreated, LogPostCreated);
Events.listen("model.posts.*", AuditModelWrites);
```

**Registrations are append-only for the life of the dispatcher, and there
is no `forget()`.** A `listen()` call in a module that gets imported more
than once, or on a request path, silently registers a duplicate listener
that runs on every subsequent dispatch. The `listeners()` hook runs
exactly once, at boot, which is why it stays the default. Use the facade
for one-off wiring, not as the normal way to register.

## `EventDispatcher`

| Method | Purpose |
|---|---|
| `listen(eventClass, listenerClass \| closure)` | Register a listener against an event class. |
| `listen(pattern, listenerClass \| callback)` | Register a listener against an event-**name** pattern. |
| `listenQueued(eventClass, listenerClass)` | Register a listener that is enqueued, not run inline. |
| `afterDispatch(callback)` | Run a callback after *every* dispatched event. |
| `dispatch(event)` | Dispatch. |
| `useQueuedListenerHandler(handler)` | Install the enqueue function. Bound by `QueueServiceProvider`. |
| `enqueueQueuedListener(event, listenerClass)` | Build the payload and hand it to the handler. |
| `runQueuedListener(payload)` | Rehydrate and run. Called by the queue job. |

**There is no `until()`.** No listener can halt propagation by returning a
value, and no dispatch returns a listener's result. Events are
notifications, not a request/response channel. If you need a decision, use
a [Gate](../authorization/) or a plain function call.

**There is no `subscribe()`.** No subscriber-class convention that
registers many handlers from one object. Return more pairs from
`listeners()`.

**There is no `forget()` / `forgetPushed()` / `flush()`.** Registrations
are append-only for the life of the dispatcher. For tests, build a fresh
dispatcher or use `RecordingEventDispatcher`.

**There is no `dispatchIf()` / `dispatchUnless()`.** Write the `if`.

### `listen()`: class vs. pattern

```ts
listen<E extends AbstractEvent>(eventClass: EventClass<E>, handler: ListenerFn<E>): void;
listen<E extends AbstractEvent>(eventClass: EventClass<E>, listenerClass: ListenerClass<E>): void;
listen(pattern: string, listener: ListenerClass | WildcardListener): void;
```

The overload is discriminated at runtime by `typeof eventClassOrPattern
=== "string"`, then by whether the listener has a `handle` method on its
prototype (`isListenerClass()`).

**The two first-argument forms are not interchangeable, and the
difference is the whole design.**

An **event class** matches by `instanceof` and infers `E`, so the
handler's `event` is fully typed:

```ts
listen(PostCreated, (event) => log(event.postId));   // event: PostCreated
```

A **string** matches `event.eventName` through the same wildcard matcher
as `Event.suppress()`, and cannot narrow. A pattern is a runtime string
with no type-level link to any event class, so there's nothing to infer
from and no way to prove a given listener accepts whatever ends up
matching:

```ts
listen("model.posts.*", (event) => log(event.eventName));   // event: AbstractEvent
```

This is why there is **no string form for a single concrete event**.
`listen("PostCreated", LogPostCreated)` would be strictly worse than
`listen(PostCreated, LogPostCreated)`: no type safety, no rename safety,
no inference, and it breaks under a minifier that mangles class names
(`eventName` falls back to `constructor.name`). Use the class. Use a
string only when you actually mean *a family of events matched by
name*, which is the one thing the class form can't express.

Both forms accept a listener class or a bare function:

```ts
type WildcardListener = (event: AbstractEvent) => void | Promise<void>;
```

A pattern listener **class** is constructed fresh per matching dispatch
with the `Application`, exactly like the event-class form, so it can pull
its own dependencies from the container. A pattern **callback** isn't
constructed at all. Neither narrows `event` beyond `AbstractEvent`, read
`event.eventName` for the matched name and cast if you need the payload.

### Wildcard pattern semantics

```ts
export function matchesPattern(name: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(name);
}
```

The pattern is split on `*`, each literal chunk is regex-escaped, and the
pieces are rejoined with `.*`. So:

**`*` matches any run of characters, including dots.** It is *not* a
single dot-segment wildcard.

| Pattern | Matches | Also matches |
|---|---|---|
| `model.posts.*` | `model.posts.created` | `model.posts.a.b.c` |
| `model.*` | `model.posts.created` | `model.users.deleted`, `model.` |
| `*` | everything |: |
| `*.created` | `model.posts.created` | `created` is **not** matched (needs the dot) |

The match is anchored at both ends (`^...$`), so `posts` does not match
`model.posts.created`. And the whole `.` in the pattern is escaped, so a
literal `.` in a pattern matches only a literal `.` in the name.

The same function backs `Event.suppress()` patterns, so the two use
identical syntax.

### `dispatch()`: the exact order

```ts
async dispatch<E extends AbstractEvent>(event: E): Promise<void> {
  if (AbstractEvent.isSuppressed(event.eventName)) return;

  for (const registration of this.registrations) {
    if (registration.kind === "class") {
      if (event instanceof registration.eventClass) {
        const listener: Listener = new registration.listenerClass(this.app);
        await listener.handle(event);
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
```

Four things to take from that.

**1. Suppression is checked first, and it's a hard return.** Nothing runs,
not listeners, not queued listeners, not `afterDispatch` callbacks.

**2. Registrations run in one flat list, in registration order,
sequentially awaited.** There is no priority, no parallelism, and no
separate ordering between class listeners, queued listeners and wildcard
handlers, a wildcard registered before a class listener runs first. If
one listener throws, the loop stops and the error propagates to whoever
called `dispatch()`; later listeners never run.

That matters at your dispatch site. This controller:

```ts
await Events.dispatch(new PostCreated(post));
return HttpResponse.json(await new PostResource(post).toJson(), 201);
```

returns a 500 if any `PostCreated` listener throws, even though the post
was already created. If a listener's failure shouldn't fail the request,
either catch inside the listener or make it a `listenQueued()` one.

**3. Class matching is `instanceof`, not identity.** A listener registered
against a base class receives every subclass:

```ts
class ModelEvent extends AbstractEvent {}
class PostCreated extends ModelEvent {}
class PostDeleted extends ModelEvent {}

dispatcher.listen(ModelEvent, AuditEverything);   // catches both
```

That's a feature, it's how you build event hierarchies, and a trap: a
listener registered against `AbstractEvent` receives literally every event
in the application, including the queue's `JobProcessing`/`JobProcessed`/
`JobFailed`.

**4. `afterDispatch` callbacks run last, and a throwing one propagates.**

```ts
for (const callback of this.afterCallbacks) {
  await callback(event);
}
```

No `try`. A callback that throws fails the `dispatch()` call, after every
listener has already run, so the listeners' side effects happened and the
caller still sees an error. That's a deliberate choice, but it means **a
callback that shouldn't be able to fail a dispatch must catch its own
errors.** `BroadcastServiceProvider.boot()` is the canonical example: it
registers an `afterDispatch` that forwards `ShouldBroadcast` events to
websocket clients and swallows its own failures, so an unreachable socket
can't 500 a request.

### `afterDispatch()`

```ts
type AfterDispatchCallback = (event: AbstractEvent) => void | Promise<void>;
```

Runs after **every** dispatched event, regardless of class and regardless
of whether it had any listeners at all.

Deliberately general rather than a hook tailored to one consumer: it's
"run this after every dispatch", which is what cross-cutting concerns,
auditing, metrics, broadcasting, actually want, and none of them can
enumerate every event class up front the way `listen()` requires. It's
also what keeps `@mahiframework/events` free of any dependency on, or knowledge
of, broadcasting.

```ts
dispatcher.afterDispatch(async (event) => {
  try {
    await metrics.increment(`events.${event.eventName}`);
  } catch { /* never fail a dispatch */ }
});
```

## After-commit dispatch

An event dispatched inside a `DB.transaction()` fires immediately by
default, so a listener runs even if the transaction later rolls back.
Mark the event class `static shouldDispatchAfterCommit` and its listeners
are held until the transaction commits (and dropped entirely on rollback);
outside a transaction it dispatches immediately, so nothing at the call
site changes:

```ts
class OrderPlaced extends AbstractEvent {
  static shouldDispatchAfterCommit = true;
  constructor(public readonly order: Order) { super(); }
}

await DB.transaction(async () => {
  const order = await Order.create({ ... });
  await Events.dispatch(new OrderPlaced(order));   // listeners run after commit
});
```

`Events.dispatchAfterCommit(event)` (and
`dispatcher.dispatchAfterCommit(event)`) is the explicit per-call form for
an event you don't want to mark. This builds on `@mahiframework/database`'s
`afterCommit()`. See
[Database → After-commit dispatch](../database/#after-commit-dispatch-for-events-jobs-mail--notifications).
A suppressed event stays suppressed regardless of the marker: the
`suppress()` check runs at dispatch time, so it is never recorded or
deferred.

## Suppression

```ts
await AbstractEvent.suppress(async () => {
  await Events.dispatch(new PostCreated(post));   // no-op, no listeners run
});

await AbstractEvent.suppress(callback, ["model.posts.*"]);
```

`suppress(callback, patterns = ["*"])` runs `callback` with dispatch
suppressed for every event name matching one of `patterns`. Default is
`["*"]`, everything.

Scoped via `AsyncLocalStorage`, the same mechanism
`@mahiframework/database`'s `transaction()` uses. So it covers every
`dispatch()` made synchronously **or through nested async calls** inside
the callback, with zero call-site changes. `EventDispatcher.dispatch()`
checks the store itself, so *every* dispatch is covered, not only the
ones a particular caller remembered to guard.

Always returns a `Promise`, even for a synchronous callback, so callers
can `await` uniformly.

### Patterns stack

```ts
const current = storage.getStore() ?? [];
return storage.run([...current, ...patterns], callback);
```

Nested `suppress()` calls **concatenate**, they don't replace. So an inner
`suppress(inner, ["model.comments.*"])` nested inside an outer
`suppress(outer, ["model.posts.*"])` has **both** active inside `inner`,
a model-scoped `withoutEvents()` helper nests correctly inside a broader
suppression rather than accidentally narrowing it.

There is no way to *un*-suppress from inside a suppressed scope. That's
intentional.

### `isSuppressed()`

```ts
AbstractEvent.isSuppressed()                        // is ANY suppression active?
AbstractEvent.isSuppressed("model.posts.created")   // does THIS name match one?
```

The no-argument form is `hasActiveSuppression()`; the named form runs the
patterns. Consumers that dispatch outside `EventDispatcher` entirely,
`@mahiframework/database`'s `ModelObserver`/`Model.on()` hooks, which are direct
calls rather than `Event` instances, check this themselves at their own
dispatch point, passing the equivalent `"model.{table}.{event}"` name.

`hasActiveSuppression`, `isNameSuppressed` and `matchesPattern` are also
exported directly if you're building something similar.

## Queued listeners

```ts
dispatcher.listenQueued(PostCreated, GenerateThumbnails);
```

The listener is **enqueued** instead of run inline. Explicit method rather
than a `ShouldQueue` marker interface plus reflection, so the queue
integration stays opt-in and magic-free.

### How it works

`listenQueued()` records the registration under an id and stores it in a
lookup map. When a matching event is dispatched:

```ts
async enqueueQueuedListener(event: AbstractEvent, listenerClass: ListenerClass): Promise<void> {
  if (!this.queuedHandler) {
    throw new Error("No queued-listener handler is bound. ...");
  }
  const id = queuedListenerId(event.constructor as EventClass, listenerClass);
  await this.queuedHandler({ id, data: { ...event } });
}
```

The payload is:

```ts
interface QueuedListenerPayload {
  id: string;     // `${EventClass.name}:${ListenerClass.name}`
  data: object;   // { ...event } — own enumerable fields
}
```

`QueueServiceProvider.boot()` installs the handler, which dispatches the
built-in `HandleQueuedListener` job (registered as
`events.handle-queued-listener`). On the worker, that job calls
`runQueuedListener(payload)`, which rebuilds the event and runs the
listener:

```ts
const event = Object.assign(Object.create(entry.eventClass.prototype), payload.data);
const listener: Listener = new entry.listenerClass(this.app);
await listener.handle(event);
```

### What that implies

**The id is `"{EventClassName}:{ListenerClassName}"`.** Both are runtime
class names, so a minifier that mangles them breaks the mapping between an
already-enqueued payload and its registration. It also means renaming
either class orphans in-flight payloads:

```
Queued listener [PostCreated:GenerateThumbnails] is not registered on this dispatcher.
```

**The payload is `{ ...event }`, own enumerable fields only.** Anything
on the prototype (getters, methods, an overridden `eventName`) is not
serialized; it comes back from the prototype on rebuild, which is
generally what you want. Anything not JSON-round-trippable is not
preserved: a `Date` field comes back as a string, a `Model` field comes
back as whatever `JSON.stringify` made of it. **Model references are not
specially encoded here** the way they are for job fields, a queued
listener's event should carry plain data (an id, a row) rather than a live
model. See [Queues](../queues/#model-serialization).

**The event's constructor never re-runs.** `Object.create` + `Object.assign`,
same as a job rebuild. Compute into fields.

**Dispatching a `listenQueued()` event with no handler bound throws:**

```
No queued-listener handler is bound. Register QueueServiceProvider, or call
EventDispatcher.useQueuedListenerHandler(), before dispatching a listenQueued() event.
```

Thrown at **dispatch** time, from inside the registration loop, so it
also aborts every listener registered after it. Register
`QueueServiceProvider`, or install a handler yourself:

```ts
dispatcher.useQueuedListenerHandler(async (payload) => { recorded.push(payload); });
```

which is the intended way to assert on payload shape without standing up
a queue.

**Queued listeners still go through the normal registration loop.** The
`await` is the enqueue, not the run, so a durable queue connection means
`dispatch()` resolves once the job is written, and the listener runs
later. Under the `sync` connection it runs immediately, inline, exactly
like a normal listener but with a serialize/rebuild round-trip in between.

## Testing

`RecordingEventDispatcher` is a drop-in `EventDispatcher` subclass that
records every `dispatch()` and then does nothing:

```ts
override async dispatch<E extends AbstractEvent>(event: E): Promise<void> {
  if (AbstractEvent.isSuppressed(event.eventName)) return;
  this.recorded.push(event);
}
```

No listeners run, no `listenQueued()` jobs are enqueued, no
`afterDispatch()` callbacks fire.

**That's the difference from `Event.suppress()`**, which also stops
listeners but records nothing. With the recorder a test can prove code
*tried* to dispatch `PostCreated` while none of its side effects happened.

Note the suppression check is preserved: an event suppressed by an active
`Event.suppress()` is neither recorded nor run, so `suppress()` keeps
meaning "as if never dispatched" even under a fake.

```ts
const { events } = await createTestApplication(bootstrap, { fakeEvents: true });

await request("POST", "/posts", { body: "hello" });

events.assertDispatched(PostCreated);
events.assertDispatched(PostCreated, (e) => e.post.body === "hello");
events.assertNotDispatched(PostDeleted);
events.assertDispatchedTimes(PostCreated, 1);
```

| Method | Purpose |
|---|---|
| `dispatched(eventClass?, filter?)` | Matching events in dispatch order. All of them with no argument. |
| `hasDispatched(eventClass, filter?)` | Boolean. |
| `assertDispatched(eventClass, filter?)` | At least once. |
| `assertNotDispatched(eventClass, filter?)` | Never: with a filter, no *matching* event. |
| `assertDispatchedTimes(eventClass, times, filter?)` | Exactly `times`. |
| `assertNothingDispatched()` | Nothing at all. |
| `reset()` | Discard recordings: for a `beforeEach()`. |

Matching is `instanceof`, so `dispatched(ModelEvent)` returns every
subclass instance too.

`assertDispatchedTimes` is the one `assertDispatched()` can't make:
"fired once, not twice" is exactly the shape of a double-dispatch bug, and
`assertNotDispatched()` only covers zero.

`listen()`/`afterDispatch()` still record normally on the inherited
methods, so provider boot wiring doesn't throw, the registrations simply
never run.

`createTestApplication({ fakeEvents: true })` replaces the container
singleton, so every fresh `make(EVENTS_TOKEN)`, model lifecycle events,
the `Events` facade, resolves the recorder. Assertions throw plain
`Error`s, not vitest matchers.

## The `Events` facade

```ts
export class Events extends Facade<EventDispatcher>(() => EVENTS_TOKEN) {
  static dispatch(event): Promise<void>;
  static dispatchAfterCommit(event): Promise<void>;
  static listen(eventClassOrPattern, listener): void;
  static listenQueued(eventClass, listenerClass): void;
}
```

Every static re-resolves `app()` on each call. Nothing is cached on the
facade, so a test that swaps in a fresh `Application` (or
`RecordingEventDispatcher`) is picked up automatically.

`afterDispatch()` is deliberately **not** on the facade: it's a
framework-integration hook (broadcasting uses it), not an application
API, and it only makes sense during boot where you already have `app`.

Prefer injecting `EventDispatcher` via `EVENTS_TOKEN` where practical,
and prefer the `listeners()` hook over `Events.listen()` for permanent
wiring. See [Registering from outside a
provider](#registering-from-outside-a-provider) for why. Use the facade
at call sites where threading `app` through is genuinely
inconvenient, a controller mid-handler, typically:

```ts
await Events.dispatch(new PostCreated(post));
await Bus.dispatch(new LogPostCreatedJob(post));
```

## Gotchas

**A throwing listener fails the dispatch and skips every later listener.**
Sequential and awaited, no isolation. Catch inside the listener, or queue
it.

**A throwing `afterDispatch` callback fails the dispatch too**, after every
listener has already run. Callbacks must catch their own errors.

**`instanceof` matching means base-class listeners catch subclasses**,
including a listener on `AbstractEvent`, which catches everything in the
app. **The base class may be abstract**, which is what makes the useful
version of this work: `listen(AuthEvent, ...)` observes every
authentication event, and `listen(ModelLifecycleEvent, ...)` every model
write. `listen()` only ever tests dispatched events against the class with
`instanceof`, so it accepts an `EventMatcher` (possibly abstract) rather
than the `EventClass` (necessarily concrete) that `dispatchesEvents` maps
need, since those are instantiated.

Prefer a family base to enumerating subclasses. An explicit list silently
misses whichever subclass is added next, which for an audit log is the
failure mode that matters.

**`*` in a pattern matches dots.** `model.*` matches
`model.posts.created`, not just `model.posts`.

**A pattern never narrows the event type.** Both the class and callback
forms of a pattern listener get `AbstractEvent`. Use an event class when
you want a typed payload.

**`Events.listen()` on a re-imported module or a request path duplicates
listeners.** Registrations are append-only and there's no `forget()`.
Register in a provider's `listeners()` hook, which runs once.

**`eventName` defaults to `constructor.name`**, so minification changes it.
Override with a literal if you depend on patterns in a bundled build.

**Suppression patterns stack and can't be undone** from inside a scope.

**Queued-listener ids are built from class names** and are not stable
across renames or minification.

**A queued listener's payload is `{ ...event }`**, no model encoding, no
`Date` preservation.

**`listenQueued()` without a bound handler throws at dispatch**, aborting
the rest of the registration loop.

**Listeners are constructed fresh per dispatch.** Don't put expensive work
in a constructor.

**`EventsServiceProvider` must be booted before providers that dispatch
during their own `boot()`.**

## Related

- [Providers](../providers/): the `listeners()` hook and boot ordering
- [Queues](../queues/): `listenQueued()`, and the queue's own lifecycle events
- [Broadcasting](../broadcasting/): `ShouldBroadcast`, via `afterDispatch()`
- [Models](../models/): `dispatchesEvents`, `withoutEvents()`, `model.{table}.{event}` names
- [Testing](../testing/): `createTestApplication({ fakeEvents: true })`
- [Container](../container/): `EVENTS_TOKEN`
