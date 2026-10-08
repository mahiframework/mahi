# Broadcasting

`@mahiframework/broadcasting` pushes already-dispatched application events to
connected websocket clients, scoped to named channels.

```ts
import { AbstractEvent } from "@mahiframework/events";
import type { ShouldBroadcast } from "@mahiframework/broadcasting";

export class PostCreated extends AbstractEvent implements ShouldBroadcast {
  constructor(public readonly post: PostTable) {
    super();
  }

  broadcastChannel(): string {
    return "posts";
  }

  broadcastPayload(): unknown {
    return this.post;
  }
}
```

That's the entire opt-in. Existing `dispatcher.dispatch(new PostCreated(post))`
call sites are untouched; whether an event broadcasts is a property of the
event class.

## Read this first

The shipped `local` driver keeps its subscription table in the memory of
**one Node process**. A broadcast only ever reaches clients whose
websocket is connected to *that* process.

The moment you run two or more server processes, two instances behind a
load balancer, a `cluster`/PM2 fork setup, a rolling deploy where old and
new processes briefly overlap, a broadcast from process A **silently
never reaches** a client connected to process B. Nothing errors. Nothing
logs. The message simply doesn't arrive.

That is the worst failure mode a system can have: it works perfectly in
development (one process), works perfectly in staging (one process), and
loses an unpredictable fraction of messages in production. Nobody
notices until a user says "sometimes the feed doesn't update".

`local` is correct for exactly one server process. For anything
horizontally scaled, use a driver that fans out through shared
infrastructure. `@mahiframework/redis` ships one. See
[Redis](../redis/#redisbroadcastdriver), and the
[section below](#the-multi-process-fix).

## The `BroadcastDriver` contract

```ts
interface BroadcastMessage {
  channel: string;
  event: string;
  payload: unknown;
}

interface BroadcastDriver {
  broadcast(message: BroadcastMessage): Promise<void>;
}
```

One method, one-directional, fire-and-forget from the framework's point
of view. Subscription and connection management is a **driver-internal
concern**, not part of this contract.

That isn't an oversight. It's what keeps the interface honest for
drivers other than `local`. A Redis driver's broadcast side genuinely is
just "publish to a channel", with no awareness of who (if anyone) is
subscribed. Knowing about sockets is the *subscribing* process's job, and
in a multi-process deployment that isn't even the same process. Anything
socket-shaped on this interface would be `LocalBroadcastDriver`'s
implementation detail leaking into the abstraction.

`event` is the wire-level name clients match on, by default the
dispatched event's `constructor.name`, overridable per event.

## `ShouldBroadcast`

```ts
interface ShouldBroadcast {
  broadcastChannel(): string;
  broadcastEventName?(): string;
  broadcastPayload?(): unknown;
}
```

| Member | Required | Default when omitted |
|---|---|---|
| `broadcastChannel()` | yes |: |
| `broadcastEventName()` | no | the event's `constructor.name` |
| `broadcastPayload()` | no | the event instance itself, `JSON.stringify`d |

The interface lives in `@mahiframework/broadcasting`, not on `Event` in
`@mahiframework/events`, because `events` has no dependency on HTTP or
broadcasting and shouldn't gain one just to host a marker interface. That's the framework's dependency-direction rule applied to
its own packages.

### The check is structural, not `instanceof`

```ts
export function shouldBroadcast(event: unknown): event is AbstractEvent & ShouldBroadcast {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as ShouldBroadcast).broadcastChannel === "function"
  );
}
```

An event opts in by *having* a `broadcastChannel()` method. It doesn't
have to import or `implements` anything. That's what lets
`@mahiframework/notifications` define a `NotificationBroadcast` event that
broadcasts without depending on this package at all. See
[Notifications](../notifications/#broadcast).

`implements ShouldBroadcast` on your own events is still worth writing:
it costs nothing at runtime and gets you a compile error when you
misspell `broadcastChannle`.

### Resolving a message

```ts
export function broadcastMessageFor(event: AbstractEvent & ShouldBroadcast) {
  return {
    channel: event.broadcastChannel(),
    event: event.broadcastEventName?.() ?? event.constructor.name,
    payload: event.broadcastPayload?.() ?? event,
  };
}
```

**Implement `broadcastPayload()` in practice.** The default sends the
whole event instance, which means every field on it goes over the wire,
including anything you attached for listeners' benefit and never intended
a browser to see. Narrow it explicitly:

```ts
broadcastPayload(): unknown {
  return { id: this.post.id, body: this.post.body, userId: this.post.user_id };
}
```

**Implement `broadcastEventName()` if your build minifies class names.**
The default is `constructor.name`, which a minifier is free to rewrite to
`t`. Clients matching on `"PostCreated"` would then match on nothing.

## How events get forwarded

`BroadcastServiceProvider.boot()` hangs one hook on the event dispatcher:

```ts
private forwardBroadcastableEvents(broadcaster: BroadcastManager): void {
  const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);
  const logger = this.app.logger;

  dispatcher.afterDispatch((event) => {
    if (!shouldBroadcast(event)) return;

    const message = broadcastMessageFor(event);

    void broadcaster.broadcast(message).catch((error: unknown) => {
      logger.error("Failed to broadcast event", {
        event: message.event,
        channel: message.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
```

That's the entire "opt in from the event class, change nothing at the
dispatch call site" mechanism, in one place. Every dispatched event is
checked for the marker; the ones that have it are forwarded.

**Broadcasting is fire-and-forget with logged errors. It is not awaited
inside `dispatch()`.** Look at the `void` and the `.catch()`.

A websocket push is a side channel. A slow or failing broadcast must
never delay, or fail, the application logic that dispatched the event in
the first place. A `PostCreated` listener writing to the database should
not roll back because one client's socket had a bad day.

The trade-off, stated plainly: **`await dispatch(...)` returning does not
mean the broadcast has been flushed to clients.** A failed broadcast
surfaces only as a log line. If you need delivery confirmation, websockets
are the wrong layer for it.

See [Events](../events/) for `afterDispatch()` and the dispatcher in
general.

## `BroadcastManager`

```ts
class BroadcastManager extends Manager<BroadcastDriver>
```

| Method | Returns | Notes |
|---|---|---|
| `connection(name?)` | `BroadcastDriver` | Alias for `driver()`. |
| `connectionConfig(name)` | `unknown` | The raw `connections[name]` entry. |
| `broadcast(message, connectionName?)` | `Promise<void>` | Push over the named (or default) connection. |
| `injectWebSocket(server, connectionName?)` | `void` | Hand the Node server to the driver, if it wants one. |
| `getDefaultDriver()` | `string` | `config.default`. |
| `extend(name, factory)` | `this` | Register a driver. |

```ts
interface BroadcastConfig {
  default: string;
  connections: Record<string, unknown>;
}
```

Broadcasting manually, outside the event system, is a one-liner:

```ts
const broadcaster = app.make<BroadcastManager>(BROADCAST_TOKEN);
await broadcaster.broadcast({ channel: "ops", event: "Deployed", payload: { sha } });
```

### `WebSocketInjectable`

```ts
interface WebSocketInjectable {
  injectWebSocket(server: ServerType): void;
}
```

Drivers that own a websocket endpoint on the app's own HTTP server need a
hook into the running Node server, which only exists after
`@hono/node-server`'s `serve()` has returned. Implementing this interface
is what makes a driver eligible for `BroadcastManager.injectWebSocket()`.

It's optional on purpose. A Pusher/Ably-style driver has nothing to
inject; the socket connection lives elsewhere entirely. `injectWebSocket()`
checks structurally and is a **no-op** for such drivers, so an app
swapping to one doesn't have to change its entrypoint.

## `LocalBroadcastDriver`

An in-process websocket broadcaster. It mounts an upgrade endpoint onto
the app's **existing** Hono instance, not a second server on a second
port, tracks which sockets subscribed to which channels, and pushes to
the matching ones.

```ts
class LocalBroadcastDriver implements BroadcastDriver, WebSocketInjectable {
  constructor(path?: string);                    // default: "/broadcasting/socket"

  registerRoutes(hono: Hono): void;
  injectWebSocket(server: ServerType): void;
  broadcast(message: BroadcastMessage): Promise<void>;

  subscriberCount(channel: string): number;
  channels(): string[];
}
```

`DEFAULT_SOCKET_PATH` is exported as `"/broadcasting/socket"`.

### Single-process only

```ts
private subscriptions = new Map<string, Set<WSContext>>();
```

That `Map` is the whole story. It lives in this process's heap. There is
no shared state, no coordination, and no way for process A to learn that
process B has a socket subscribed to `"posts"`.

```
Process A                      Process B
  subscriptions:                 subscriptions:
    "posts" -> { ws1, ws2 }        "posts" -> { ws3 }

broadcast({channel: "posts"})  in A
  -> ws1 ✅  ws2 ✅  ws3 ❌ (never told)
```

`ws3`'s user watches a feed that never updates, while `ws1`'s works
perfectly. Load balancers make which one you get essentially random per
connection. Nothing in the logs distinguishes the two cases.

`broadcast()` also returns early when nobody local is subscribed:

```ts
const sockets = this.subscriptions.get(message.channel);
if (!sockets || sockets.size === 0) return;
```

so "no subscribers here" and "no subscribers anywhere" are indistinguishable.

### Socket bookkeeping

Two details worth knowing, because both are the kind of thing that only
shows up under real traffic:

**Dead sockets are pruned on send.** A socket can close between the last
`onClose` and the next `broadcast()`:

```ts
for (const ws of sockets) {
  if (ws.readyState !== 1) {
    this.forget(ws);
    continue;
  }
  ws.send(frame);
}
```

A dead socket must never break delivery to the live ones.

**Closed sockets are dropped from every channel.** `onClose` and `onError`
both call a private `forget(ws)` that walks every channel and removes the
socket, deleting channels that become empty. Without it the
`subscriptions` map grows forever as clients come and go, a slow memory
leak.

`subscriberCount(channel)` and `channels()` exist for inspection, mostly
in tests.

## The client protocol

The wire format is plain JSON text frames. The handshake is the websocket
upgrade; a channel's `private-`/`presence-` prefix decides whether a
subscribe is authorized (see [Channel authorization](#channel-authorization)).

### Client → server

```json
{"type":"subscribe","channel":"posts"}
{"type":"unsubscribe","channel":"posts"}
```

A `subscribe` to a `private-`/`presence-` channel may carry a signed grant
from `POST /broadcasting/auth`:

```json
{"type":"subscribe","channel":"private-orders.5","auth":"<grant>"}
```

A successful subscribe is acknowledged:

```json
{"type":"subscribed","channel":"posts"}
{"type":"unsubscribed","channel":"posts"}
```

A denied subscribe (unauthorized private/presence channel, subscription
limit reached, authorization error) gets a `subscription_error` instead:

```json
{"type":"subscription_error","channel":"private-orders.5","error":"Unauthorized."}
```

Anything else gets an error frame:

```json
{"error":"Expected {\"type\":\"subscribe\"|\"unsubscribe\",\"channel\":\"...\"}."}
```

A malformed frame is **answered, not fatal**. The connection stays open.
One bad message from a client shouldn't tear down a connection that may
have valid subscriptions on it. A frame is rejected if it isn't a string,
isn't valid JSON, isn't an object, has a `type` other than the two
literals, or has a missing/empty/non-string `channel`.

### Server → client

```json
{"channel":"posts","event":"PostCreated","payload":{"id":"427185966743560456","body":"..."}}
```

Exactly the `BroadcastMessage` fields, `JSON.stringify`d once per
broadcast and sent to every subscribed socket.

### Presence frames

A `presence-` channel adds three membership frames, carrying whatever the
channel's authorization callback returned as the member payload:

```json
{"type":"presence:here","channel":"presence-chat.general","members":[{"id":1},{"id":2}]}
{"type":"presence:joining","channel":"presence-chat.general","member":{"id":3}}
{"type":"presence:leaving","channel":"presence-chat.general","member":{"id":2}}
```

`here` goes only to the socket that just subscribed and lists the full
roster including itself; `joining`/`leaving` go to everyone else on the
channel and never echo to the member they describe.

**Ordering is guaranteed:** a subscriber receives `subscribed`, then
`presence:here`, then every later frame on that channel, in order and
exactly once. A client can therefore treat `here` as its initial state and
apply each subsequent `joining`/`leaving` as a delta, with no need to
handle a delta for a roster it hasn't seen yet.

That guarantee is not free, and the reason is worth knowing if you write a
driver. A socket is registered for fan-out *before* its `here` is sent, so
that nothing published mid-handshake is lost. With a shared roster store
the handshake spans a network round trip, which is a wide enough window for
another member's `joining` to be published inside it. Frames that land in
that window are held per socket and flushed once `here` has gone out, so
"nothing is lost" doesn't cost "nothing arrives early". A socket that
unsubscribes mid-handshake has its held frames dropped instead.

### A minimal client

```ts
const socket = new WebSocket("ws://127.0.0.1:8000/broadcasting/socket");

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "subscribe", channel: "posts" }));
});

socket.addEventListener("message", (event) => {
  const frame = JSON.parse(event.data);
  if (frame.error) return console.error(frame.error);
  if (frame.type) return;                       // subscribe/unsubscribe ack
  if (frame.event === "PostCreated") {
    prependToFeed(frame.payload);
  }
});
```

There is no bundled client library or `Echo` equivalent, but the wire
protocol and channel-name conventions mirror Laravel/Pusher closely, so a
thin client is easy to write (and `pusher-js`-style libraries port with
minor changes). Presence and private channels are supported. See the next
section.

## Channel authorization

Public channels, any name **without** a `private-` or `presence-` prefix,
behave exactly as before: any connected client may subscribe. That tier
is unchanged.

Two prefixes opt a channel into authorization:

- `private-*`: a client may subscribe only if the channel's
  authorization callback returns truthy for the connecting user.
- `presence-*`: same gate, plus membership: the callback returns the
  member info published to everyone else on the channel as
  `here`/`joining`/`leaving` frames.

A protected channel with **no** matching callback **fails closed**, an
unregistered `private-` channel denies everyone, so a typo is a locked
door, not an open one.

### Declaring who may subscribe

Register callbacks from a provider's `channels()` hook, or via the
`Broadcast` facade:

```ts
import { Broadcast, type ChannelRegistry } from "@mahiframework/broadcasting";

export class BroadcastChannelsProvider extends ServiceProvider {
  channels(broadcast: ChannelRegistry): void {
    // Private: return a boolean.
    broadcast.channel("orders.{orderId}", async (user, orderId) => {
      const order = await Order.find(orderId);
      return order?.userId === (user as User | null)?.id;
    });

    // Presence: return the member payload (or false to deny).
    broadcast.channel("presence-chat.{room}", (user) =>
      user ? { id: (user as User).id, name: (user as User).name } : false,
    );
  }
}
```

`{param}` placeholders are captured from the channel name (with its
prefix stripped) and passed to the callback after the user. The user is
whatever the app's auth guard resolved for the connecting socket, or
`null` for a guest. A guest is denied every protected channel whose
callback checks the user.

### How a client authenticates

- **Same-origin browser.** The websocket upgrade carries the session
  cookie, so the server authenticates the connection at upgrade time (via
  the `session` guard by default) and no extra step is needed, just
  subscribe to the `private-`/`presence-` channel.
- **Cross-origin SPA.** The browser won't send the cookie on the upgrade,
  so the client first `POST`s to `/broadcasting/auth` (a normal
  same-origin XHR that *does* send the cookie) with `{ "channel": "..." }`,
  receives a short-lived signed `auth` grant, and presents it on the
  subscribe frame's `auth` field. The endpoint returns `403` if the
  channel callback denies the user, `422` without a channel, and
  `{ "auth": null }` for a public channel (which needs no grant).

### Configuration

`config/broadcasting.ts` accepts an `auth` block shared by every driver:

```ts
{
  default: "local",
  connections: { local: { path: "/broadcasting/socket" } },
  auth: {
    guards: ["session", "token"],           // tried in order at upgrade
    allowedOrigins: ["https://app.example.com"], // Origin allow-list (default: allow all)
    maxSubscriptionsPerSocket: 100,
    maxFrameBytes: 65536,
    maxBufferedBytes: 1048576,
  },
}
```

`allowedOrigins` guards against cross-site websocket hijacking: a browser
whose `Origin` isn't listed is refused the upgrade, while a non-browser
client (which sends no `Origin`) is still allowed. The limits cap a single
socket's channels, inbound frame size, and unflushed outbound buffer
(a slow consumer past `maxBufferedBytes` is closed).

### Payloads are still yours to scope

Channel authorization controls *who* subscribes; `broadcastPayload()`
controls *what* they receive. The default payload is the **entire event
object**, if an event carries a full model, every subscriber gets every
column. Always implement `broadcastPayload()` to narrow the wire shape
when an event holds anything you wouldn't publish openly. The two
protections are complementary.

### Broadcasting after a transaction commits

A broadcastable event dispatched inside a `DB.transaction()` is pushed to
clients immediately by default. Mark the event class `static
broadcastAfterCommit = true` (or implement the `ShouldBroadcastAfterCommit`
marker with a truthy `broadcastAfterCommit` property) and the broadcast is
held until the transaction commits, and dropped on rollback:

```ts
class OrderShipped extends AbstractEvent implements ShouldBroadcast {
  static broadcastAfterCommit = true;
  broadcastChannel() { return "orders"; }
}
```

This defers only the websocket side channel, not the event's in-process
listeners (mark the event `shouldDispatchAfterCommit` for those). Built on
`@mahiframework/database`'s
[after-commit dispatch](../database/#after-commit-dispatch-for-events-jobs-mail--notifications).

## Wiring

Two things have to happen, in order, and they happen in two different
places.

### 1. The route is mounted during `boot()`

```ts
private registerSocketRoutes(broadcaster: BroadcastManager): void {
  const driver = broadcaster.connection();
  if (!(driver instanceof LocalBroadcastDriver)) return;

  const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
  driver.registerRoutes(kernel.raw(), kernel.websocketSupport());
}
```

`registerRoutes()` takes the kernel's **raw Hono instance**, not the
framework's `Router`. `@hono/node-ws`'s `createNodeWebSocket()` has to be
handed the same Hono instance the upgrade route is registered on, so this
is a genuine use of the `raw()` escape hatch.

The second argument is the kernel's **shared websocket helper**, and it
matters as soon as your application wants a websocket route of its own.
See [Adding your own websocket route](#adding-your-own-websocket-route).

### 2. The upgrade handler is attached after `serve()`

```ts
injectWebSocket(server: ServerType): void {
  if (!this.injector) {
    throw new Error("LocalBroadcastDriver.registerRoutes() must run before injectWebSocket().");
  }
  this.injector(server);
}
```

Node's HTTP server has to be told to handle upgrade requests, which can
only happen once `serve()` has returned a server. `listenHttpServer()`
does this for you:

```ts
const server = serve({ fetch: kernel.raw().fetch, port }, (info) => { /* ... */ });

if (app.has(BROADCAST_TOKEN)) {
  const broadcaster = app.make<unknown>(BROADCAST_TOKEN);
  if (isWebSocketInjectable(broadcaster)) {
    broadcaster.injectWebSocket(server);
  }
}
```

Both `./artisan serve` and the generated `bin/server.ts` go through
`listenHttpServer()`, so **an app using the standard entrypoints needs to
do nothing**. If you hand-roll an entrypoint with `serve()` directly, add
the injection yourself:

```ts
import { BroadcastManager, BROADCAST_TOKEN } from "@mahiframework/broadcasting";

const server = serve({ fetch: kernel.raw().fetch, port });
app.make<BroadcastManager>(BROADCAST_TOKEN).injectWebSocket(server);
```

**The symptom of forgetting it:** the upgrade route is mounted, plain
HTTP keeps working perfectly, and every websocket connection attempt
fails to complete the handshake. If websockets appear dead in an app
whose HTTP is fine, this is the first thing to check.

`injectWebSocket()` is a no-op for drivers without a socket server of
their own, so the line is safe to leave in place regardless of which
driver you're configured for. It is also **idempotent** on the shared
helper, calling it after `listenHttpServer()` already has changes
nothing, which is what makes the snippet above safe to keep.

### Adding your own websocket route

A broadcast socket is not the only thing an app might want a websocket
for, a terminal bridge, a collaborative document, a live log tail. Ask
the kernel for the helper and register as many routes as you like:

```ts
const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
const { upgradeWebSocket } = kernel.websocketSupport();

kernel.raw().get(
  "/terminals/:id/socket",
  upgradeWebSocket((c) => ({
    onOpen: (_event, ws) => ws.send("connected"),
    onMessage: (event, ws) => { /* ... */ },
  })),
);
```

> [!WARNING]
> **Never call `createNodeWebSocket()` yourself when the kernel already
> has a helper.** It is not a case of the second one quietly not
> working. It takes the process down.
>
> `injectWebSocket()` attaches an `upgrade` listener to the Node server,
> and Node calls *every* `upgrade` listener for *every* upgrade. The
> second helper therefore handles connections destined for the first,
> finds no waiter for them, and runs its reject branch, `socket.end()`
> on a socket the winning helper has already taken over. That raises
> `ERR_STREAM_WRITE_AFTER_END` on the server's `error` event, which is
> unhandled, and the process exits. It happens on the very first
> connection to *either* endpoint.
>
> `kernel.websocketSupport()` returns the one helper, memoised.
> `upgradeWebSocket` is per-route and safe to call as often as you need;
> only `injectWebSocket` is per-server, and the kernel handles it.

### Configuration

```ts
// config/broadcasting.ts
import type { BroadcastConfig } from "@mahiframework/broadcasting";

export function broadcastingConfig(): BroadcastConfig {
  return {
    default: "local",
    connections: {
      local: { path: "/broadcasting/socket" },
      redis: { path: "/broadcasting/socket" },
    },
  };
}
```

```ts
interface LocalConnectionConfig {
  path?: string;   // defaults to DEFAULT_SOCKET_PATH
}
```

`path` is the only local option. Change it and clients connect to the new
path; nothing else moves.

### Provider ordering

`BroadcastServiceProvider` resolves two tokens in its own `boot()`, so in
`config/app.ts` it must come **after both**:

- `EventsServiceProvider`: it decorates the dispatcher with
  `afterDispatch()`
- `HttpServiceProvider`: it mounts the upgrade route onto the
  already-constructed `HttpKernel`'s Hono instance, and wants the
  kernel's global middleware installed first so the socket route sits
  behind it

```ts
export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  // ...
  HttpServiceProvider,
  BroadcastServiceProvider,
  RedisServiceProvider,      // extends BROADCAST_TOKEN with "redis"
  // ...
];
```

See [Providers](../providers/).

## The multi-process fix

`BroadcastManager.extend()` is the supported extension point, and
`@mahiframework/redis` uses it:

```ts
manager.extend("redis", (app) => new RedisBroadcastDriver(/* ... */));
```

```ts
// config/broadcasting.ts
default: "redis"
```

`RedisBroadcastDriver` **extends** `LocalBroadcastDriver`, keeping the
websocket endpoint and the local `channel → sockets` map, and adds fanout:

1. `broadcast(msg)` does not touch local sockets. It `PUBLISH`es to a
   shared Redis channel.
2. Every process, **including the publisher**, runs a subscriber
   `SUBSCRIBE`d to that channel, and on each message calls the inherited
   `LocalBroadcastDriver.broadcast()` to deliver to its own sockets.

So a broadcast reaches exactly the sockets subscribed to that channel, no
matter which process they connected to. The publisher routing through
Redis to reach its own clients looks like a detour; it's what makes the
path identical everywhere and removes the "local or remote?" branch
entirely.

`instanceof LocalBroadcastDriver` still holds, so
`BroadcastServiceProvider` mounts the route and injects the server
exactly as before. **Switching from `local` to `redis` requires no
entrypoint change and no client change**. The socket path stays whatever
you configured.

Full details, including the connect-before-publish ordering requirement:
[Redis](../redis/#redisbroadcastdriver).

No fanout driver ships in this package on purpose, for the same reason
the cache, queue and storage defaults are all in-process: the framework
doesn't add an infrastructure dependency speculatively. It does, however,
document the limitation everywhere it can, in the package's `index.ts`,
in the driver's docstring, in the generated `config/broadcasting.ts`, and
here.

## Broadcasting a notification

`@mahiframework/notifications`' `BroadcastChannel` dispatches a
`NotificationBroadcast` event that structurally implements
`ShouldBroadcast`, so it flows through the same `afterDispatch()` hook
with no extra wiring:

```ts
export class InvoicePaid extends Notification {
  via(): string[] { return ["broadcast"]; }
  toBroadcast(): object { return { invoiceId: this.invoice.id }; }
}
```

The channel is `routeNotificationFor("broadcast")` when it returns a
string, otherwise the notification's class name. See
[Notifications](../notifications/#broadcast).

## Writing a driver

```ts
import { ServiceProvider, BROADCAST_TOKEN } from "@mahiframework/core";
import { BroadcastManager, type BroadcastDriver, type BroadcastMessage } from "@mahiframework/broadcasting";

export class PusherBroadcastDriver implements BroadcastDriver {
  constructor(private client: PusherClient) {}

  async broadcast(message: BroadcastMessage): Promise<void> {
    await this.client.trigger(message.channel, message.event, message.payload);
  }
}

export class PusherServiceProvider extends ServiceProvider {
  boot(): void {
    const manager = this.app.make<BroadcastManager>(BROADCAST_TOKEN);
    manager.extend("pusher", () => new PusherBroadcastDriver(
      new PusherClient(manager.connectionConfig("pusher") as PusherConfig),
    ));
  }
}
```

One method to implement. No `WebSocketInjectable`. A hosted service has
no local socket server, so `injectWebSocket()` in the app's entrypoint is
a no-op and nothing needs to change.

If your driver needs an async connection (a Redis subscriber, an
authenticated handshake), implement `Connectable` and call `connect()`
from your provider's `boot()`. `Manager.driver()` never awaits for you.
And connect **before** the server starts accepting traffic. A publish
that happens before the subscriber is up is a lost message.

## Testing

`LocalBroadcastDriver` has no container dependency, and its inspection
methods make assertions easy without a real socket:

```ts
const driver = new LocalBroadcastDriver();
expect(driver.channels()).toEqual([]);
expect(driver.subscriberCount("posts")).toBe(0);
```

For the event-forwarding path, register a fake driver and assert on what
it received:

```ts
const manager = app.make<BroadcastManager>(BROADCAST_TOKEN);
const sent: BroadcastMessage[] = [];
manager.extend("local", () => ({ async broadcast(m) { sent.push(m); } }));

await dispatcher.dispatch(new PostCreated(post));
await new Promise((r) => setImmediate(r));   // the forward is fire-and-forget

expect(sent).toEqual([{ channel: "posts", event: "PostCreated", payload: post }]);
```

Note the `setImmediate` tick. `afterDispatch` fires `void broadcaster.broadcast(...)`
without awaiting it, so a test that asserts immediately after `dispatch()`
resolves is racing the broadcast. This is the observable consequence of
the fire-and-forget design.

For the message shape alone, `broadcastMessageFor()` is a pure function:

```ts
expect(broadcastMessageFor(new PostCreated(post))).toEqual({
  channel: "posts",
  event: "PostCreated",
  payload: post,
});
```

## Gotchas

**`local` is single-process and silently lossy past one.** The headline
gotcha. Switch to `redis` before scaling horizontally, not after.

**`await dispatch()` doesn't mean "broadcast delivered".** The forward is
fire-and-forget; failures land in the log and nowhere else.

**Forgetting `injectWebSocket()` breaks websockets while HTTP keeps
working.** `listenHttpServer()` handles it; a hand-rolled `serve()`
doesn't.

**`registerRoutes()` must run before `injectWebSocket()`,** or the latter
throws. `BroadcastServiceProvider.boot()` does the first; the entrypoint
does the second. Which is why boot ordering matters.

**A second `createNodeWebSocket()` crashes the process.** Not "conflicts",
crashes, on the first connection, with an unhandled
`ERR_STREAM_WRITE_AFTER_END`. Use `kernel.websocketSupport()` for your own
websocket routes; see [Adding your own websocket
route](#adding-your-own-websocket-route).

**Public channels are open by design; protected ones fail closed.** Any
client can subscribe to any *public* (unprefixed) channel. That's the
contract. `private-`/`presence-` channels require a matching
`Broadcast.channel()` callback and deny everyone when none is registered.
See [Channel authorization](#channel-authorization).

**The default `broadcastPayload()` sends the whole event instance.**
Every field, including ones you never meant a browser to see. Channel
authorization gates *who* subscribes; it does not narrow *what* they get,
implement `broadcastPayload()` for that.

**`constructor.name` is the default event name.** A minifier that renames
classes silently breaks every client matching on the old name. Implement
`broadcastEventName()` if that's a risk.

**A `broadcast()` to a channel with no local subscribers is a silent
no-op.** With the local driver you cannot distinguish that from "nobody
anywhere is listening".

**`BroadcastServiceProvider` must come after both events and http.** Both
tokens are resolved in its own `boot()`.

## Related

- [Redis](../redis/): `RedisBroadcastDriver`, the multi-process fix
- [Events](../events/): `AbstractEvent`, `afterDispatch()`, the dispatcher
- [Notifications](../notifications/): the `broadcast` channel
- [Routing](../routing/): `Router.raw()`, the escape hatch this package uses
- [Deployment](../deployment/): what "more than one process" actually means
- [Providers](../providers/): boot ordering, `extend()`
- [Configuration](../configuration/): `config/broadcasting.ts`
