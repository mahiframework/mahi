# Notifications

A notification is one message that may go out over several channels at
once, an email *and* a row in a table *and* a websocket push, from a
single class.

```ts
import { Notification } from "@mahiframework/notifications";

export class InvoicePaid extends Notification {
  constructor(private invoice: Invoice) {
    super();
  }

  via(): string[] {
    return ["mail", "database"];
  }

  toMail(): Mailable {
    return new InvoicePaidMailable(this.invoice);
  }

  toDatabase(): object {
    return { invoiceId: this.invoice.id, amount: this.invoice.total };
  }
}
```

```ts
await notify(user, new InvoicePaid(invoice));
```

Three channels ship: `mail`, `database`, `broadcast`.

## The `Notification` base class

```ts
abstract class Notification {
  id?: string;
  locale?: string;

  abstract via(notifiable: NotificationRoutable): string[];

  toMail?(notifiable: NotificationRoutable): Mailable;
  toDatabase?(notifiable: NotificationRoutable): object;
  toBroadcast?(notifiable: NotificationRoutable): object;
}
```

`via()` is the only required member. It returns channel names, each of
which is resolved through `ChannelManager`.

**The `toXxx()` methods are optional TypeScript methods, not
`method_exists()` reflection.** Laravel discovers `toMail` by asking the
runtime whether the method exists; here it's an optional method on the
class, and each channel checks `if (!notification.toX) return;` before
calling it. The consequence is that "does this notification support the
mail channel?" is a compile-time question your editor can answer, and a
typo in `toMial` is a missing method rather than a silently skipped
channel. There is no central registry of channel method names, a plugin
channel invents its own optional `toXxx()` by the same convention.

### `via()` receives the notifiable

```ts
via(notifiable: NotificationRoutable): string[] {
  const channels = ["database"];
  if (notifiable instanceof User && notifiable.emailNotifications) {
    channels.push("mail");
  }
  return channels;
}
```

Channels can vary per recipient, email only the people who opted in,
broadcast only to connected users. Laravel's `via()` gets the notifiable
too; the difference here is that there is no
`routeNotificationFor{Studly}` string-to-method reflection anywhere.
Routing is the notifiable's own explicit method.

### `id` and `locale`

`id` is a stable identifier for this notification instance. `DatabaseChannel`
uses it as the row's primary key, defaulting to a fresh `randomUUID()` at
persist time when unset. Set it explicitly when you need a caller-chosen
id, for example a time-sortable UUID v7, so the persisted rows page
chronologically:

```ts
import { randomUUIDv7 } from "node:crypto";

const notification = new LikeNotification(like.user_id, post.id);
notification.id = randomUUIDv7();
await notify(new UserNotifiable(post.user_id), notification);
```

The reason is concrete: a notifications list paginated with
`cursorPaginate({ column: "id" })` needs `id` to sort in creation order.
A v4 UUID, being pure entropy, doesn't.

`locale` is a hint a channel *may* honour when rendering. Nothing in the
framework reads it; it exists so a custom channel has a conventional place
to look.

## `NotificationRoutable`

```ts
interface NotificationRoutable {
  routeNotificationFor(channel: string): unknown;
}
```

One method. That's the whole "notifiable" contract, the TypeScript
equivalent of Laravel's `Notifiable` trait, minus the magic.

Laravel drives per-channel routing through
`routeNotificationForMail()`, `routeNotificationForSlack()`,
`routeNotificationForNexmo()`, a string-reflection lookup that builds a
method name from a channel name at runtime. That pattern is rejected
here. A notifiable implements **one** method with a plain `switch`, so
"where does channel X deliver to?" is ordinary, greppable, type-checked
code:

```ts
interface UserAttributes {
  id: string;
  email: string;
}

class User extends Model<UserAttributes>()({ table: "users", primaryKey: "id" })
  implements NotificationRoutable
{
  routeNotificationFor(channel: string): unknown {
    switch (channel) {
      case "mail":      return this.email;
      case "database":  return this.id;
      case "broadcast": return `users.${this.id}`;
      default:          return null;
    }
  }
}
```

Returning `null`/`undefined` means "no route for that channel". A channel
is free to skip delivery in that case.

### When the recipient isn't a model

Sometimes there is no model instance to put `routeNotificationFor()` on.
You hold only an id (from a foreign key, a job payload, a webhook), and
loading the row just to notify it would be a wasted query. A tiny adapter
closes the gap:

```ts
import type { NotificationRoutable } from "@mahiframework/notifications";

export class UserNotifiable implements NotificationRoutable {
  /** Read by DatabaseChannel as the row's `notifiable_type`. */
  static table = "users";

  constructor(private userId: string) {}

  routeNotificationFor(channel: string): unknown {
    switch (channel) {
      case "database": return this.userId;
      default:         return null;
    }
  }
}
```

```ts
await notify(new UserNotifiable(post.user_id), new LikeNotification(...));
```

An adapter like this has no `morphAlias()`, so `DatabaseChannel` falls
back to its static `table` for `notifiable_type`. See
[below](#the-database-channel).

A model can implement `NotificationRoutable` directly instead, which is
usually simpler:

```ts
interface UserAttributes {
  id: string;
  email: string;
}

export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  morphName: "User",
}) implements NotificationRoutable {
  routeNotificationFor(channel: string): unknown {
    switch (channel) {
      case "database": return this.id;
      case "mail":     return this.email;
      default:         return null;
    }
  }
}
```

Then `notifiable_type` comes from `morphAlias()` and agrees with every
other polymorphic column pointing at that table. Which is what lets a
`Notification` declare a real `morphTo` for `notifiable`.

## `AnonymousNotifiable`

For notifying an address you hold directly, with no persisted recipient
behind it, Laravel's `Notification::route(...)->notify(...)`.

```ts
import { AnonymousNotifiable, notify } from "@mahiframework/notifications";

await notify(
  new AnonymousNotifiable().route("mail", "ops@example.com"),
  new ServerDown(),
);
```

`route(channel, target)` returns `this`, so it chains:

```ts
new AnonymousNotifiable()
  .route("mail", "ops@example.com")
  .route("broadcast", "ops-alerts");
```

**`route("database", ...)` throws.**

```
The database channel does not support anonymous notifiables.
```

The database channel needs a persisted `notifiable_type` +
`notifiable_id` pair, which an anonymous target by definition doesn't
have. Rather than writing a row keyed to nothing (or silently skipping),
it throws at the point of the mistake, when you route it, rather than
later at send time.

The facade offers a shorthand that constructs one for you:

```ts
await Notifications.send(
  Notifications.route("mail", "ops@example.com"),
  new ServerDown(),
);
```

## `ChannelManager`

```ts
class ChannelManager extends Manager<NotificationChannel>
```

| Method | Returns | Notes |
|---|---|---|
| `send(notifiable, notification)` | `Promise<void>` | Fan out across every channel `via()` lists. |
| `driver(name?)` | `NotificationChannel` | Inherited. Default is `"mail"`. |
| `extend(name, factory)` | `this` | Register a channel. |
| `getDefaultDriver()` | `string` | Hardcoded `"mail"`. |

```ts
async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
  for (const channelName of notification.via(notifiable)) {
    await this.driver(channelName).send(notifiable, notification);
  }
}
```

Channels are delivered **sequentially, in `via()` order**, and **errors
propagate**. If the mail channel throws, the database channel that came
after it in `via()` never runs, and the caller sees the exception. There
is no partial-success reporting and no best-effort mode.

That's the honest default: a "some of these worked" result type would be
awkward to consume and easy to ignore. If you want best-effort delivery,
wrap your own dispatch, or split the channels across queued jobs so each
retries independently:

```ts
try {
  await notify(user, new InvoicePaid(invoice));
} catch (error) {
  app().logger.error("notification failed", { error: String(error) });
}
```

`getDefaultDriver()` returns `"mail"` unconditionally. There's no
`notifications.default` config key. It only matters if something calls
`driver()` with no name, which `send()` never does.

**A `via()` entry naming an unregistered channel throws
`DriverNotRegisteredError`** from `Manager.driver()`. There is no
`class_exists($driver)` fallback (Laravel's `ChannelManager` has one).
Channel names are registered strings, nothing more.

## The channels

```ts
interface NotificationChannel {
  send(notifiable: NotificationRoutable, notification: Notification): Promise<void>;
}
```

### `mail`

```ts
async send(notifiable, notification): Promise<void> {
  if (!notification.toMail) return;
  await this.mail.send(notification.toMail(notifiable));
}
```

Takes the `Mailable` from `toMail()` and hands it to `MailManager.send()`.
Requires `MAIL_TOKEN` to be bound.

**The mailable owns its own recipients.** `routeNotificationFor("mail")`
is *advisory*. Nothing reads it automatically. A `toMail()` that wants
the routed address reads it and calls `.to(...)` itself:

```ts
toMail(notifiable: NotificationRoutable): Mailable {
  return new InvoicePaidMailable(this.invoice)
    .to(notifiable.routeNotificationFor("mail") as string);
}
```

This is the same "recipients live on the mailable" rule the
[Mail](../mail/#the-mail-facade) package enforces on its facade, applied
consistently.

### `database`

Persists `toDatabase()`'s payload into the `notifications` table.

```ts
const notifiableClass = Object.getPrototypeOf(notifiable).constructor;

const notifiableType =
  typeof notifiableClass.morphAlias === "function"
    ? notifiableClass.morphAlias()
    : notifiableClass.table;

const now = new Date().toISOString();

await this.db.connection().kysely.insertInto("notifications").values({
  id: notification.id ?? randomUUID(),
  type: notification.databaseType(),
  notifiable_type: notifiableType,
  notifiable_id: notifiable.routeNotificationFor("database") as string,
  data: JSON.stringify(notification.toDatabase(notifiable)),
  read_at: null,
  created_at: now,
  updated_at: now,
}).execute();
```

Two things it reads off the notifiable:

- **`notifiable_type`** from the notifiable class's
  [`morphAlias()`](../relationships/#morph-maps), the same morph map →
  `morphName` → `table` chain every polymorphic relation uses, so the
  value agrees with what a `morphMany`/`morphTo` against that table would
  write. Plain adapter notifiables that aren't `Model` subclasses have no
  `morphAlias()` and fall back to their static `table`. A notifiable with
  neither throws.
- **`notifiable_id`** from `routeNotificationFor("database")`.

Note the class is read off the **prototype**, not `notifiable.constructor`.
A live `Model` is `Proxy`-wrapped and its `get` trap binds every function
it returns, including `constructor`, and a bound function carries none
of the original's statics. Reading `notifiable.constructor.table` on a
real model yields `undefined`.

`type` is the `Notification` subclass's own `constructor.name`:
`"InvoicePaid"`, `"LikeNotification"`. Note that this means **minification
or a class rename changes the persisted `type` of future rows**, and old
rows keep the old string. If you need a stable public discriminant, put
one inside the JSON payload instead, a `data` column carrying
`{ type: "like", ... }` with a `"like"` the framework never sees.

`toDatabase()` is typed as returning `object`, not
`Record<string, unknown>`, so a subclass can return a narrow named
interface directly. A TS interface has no index signature and therefore
isn't assignable to `Record<string, unknown>`; `object` accepts any
non-primitive.

```ts
export class LikeNotification extends Notification {
  constructor(private actorId: string, private postId: string) {
    super();
  }

  via(): string[] {
    return ["database"];
  }

  toDatabase(): LikeNotificationData {
    return { type: "like", actorId: this.actorId, postId: this.postId };
  }
}
```

`DatabaseChannel` writes with a **raw Kysely insert**, not a model. The
row is created before anything would read it back as a relation, and the
insert needs no relation machinery. Read them back with an ordinary
`where`:

```ts
const builder = Notification.query()
  .where("notifiable_type", User.morphAlias())
  .where("notifiable_id", Auth.id());

const result = await cursorPaginate(builder, { column: "id", perPage, cursor, direction: "desc" });
```

Prefer `User.morphAlias()` over a hardcoded `"users"` on the read side
too, so both halves stay in step if the alias is ever remapped.

Because `notifiable_type` uses the same alias chain as every other
polymorphic column, a `Notification` model can declare a real `morphTo`
for its recipient:

```ts
// notifiable: MorphTo<User | Team>;   // in the attributes interface

static override relationships = {
  notifiable: morphTo<User | Team>({
    morphType: "notifiable_type",
    morphId: "notifiable_id",
    types: { user: () => User, team: () => Team },
  }),
};
```

```ts
const rows = await Notification.query().with("notifiable").get();
rows.first()!.notifiable;   // User | Team | undefined
```

### `broadcast`

```ts
async send(notifiable, notification): Promise<void> {
  if (!notification.toBroadcast) return;
  await this.events.dispatch(
    new NotificationBroadcast(notifiable, notification, notification.toBroadcast(notifiable)),
  );
}
```

It dispatches an event and stops. No websocket code lives in this
package.

`NotificationBroadcast` extends `AbstractEvent` and **structurally
implements** `@mahiframework/broadcasting`'s `ShouldBroadcast`. It has
`broadcastChannel()`, `broadcastEventName()` and `broadcastPayload()`,
without importing the interface. Broadcasting checks for that shape
structurally, so implementing it is enough. That's what keeps
`@mahiframework/broadcasting` an *optional* dependency: an app without
broadcasting installed still dispatches the event, it simply has no
listeners, and the notifications package doesn't depend on broadcasting
to define the class.

```ts
class NotificationBroadcast extends AbstractEvent {
  constructor(
    readonly notifiable: NotificationRoutable,
    readonly notification: Notification,
    readonly data: object,
  ) { super(); }

  broadcastChannel(): string {
    const route = this.notifiable.routeNotificationFor("broadcast");
    return typeof route === "string" ? route : this.notification.constructor.name;
  }

  broadcastEventName(): string {
    return this.notification.constructor.name;
  }

  broadcastPayload(): unknown {
    return { id: this.notification.id, type: this.notification.constructor.name, ...this.data };
  }
}
```

| Wire field | Source |
|---|---|
| Channel | `routeNotificationFor("broadcast")` when it's a string, else the notification's class name |
| Event name | The notification's class name |
| Payload | `{ id, type, ...toBroadcast() }` |

Requires `EVENTS_TOKEN` to be bound. The push to actual clients requires
`@mahiframework/broadcasting` too. See [Broadcasting](../broadcasting/), and
note its single-process limitation before relying on it.

## Channel registration and graceful degradation

`NotificationsServiceProvider` registers each built-in channel **only if
its backing token is actually bound**:

```ts
this.app.singleton(NOTIFICATIONS_TOKEN, (app) => {
  const manager = new ChannelManager(app);

  manager.extend("database", () => new DatabaseChannel(app.make<DatabaseManager>(DATABASE_TOKEN)));

  if (app.has(MAIL_TOKEN)) {
    manager.extend("mail", () => new MailChannel(app.make<MailManager>(MAIL_TOKEN)));
  }

  if (app.has(EVENTS_TOKEN)) {
    manager.extend("broadcast", () => new BroadcastChannel(app.make<EventDispatcher>(EVENTS_TOKEN)));
  }

  return manager;
});
```

| Channel | Required binding | Registered when |
|---|---|---|
| `database` | `DATABASE_TOKEN` | Always. The `notifications` table is this package's own hard dependency |
| `mail` | `MAIL_TOKEN` | Only if `MailServiceProvider` is registered |
| `broadcast` | `EVENTS_TOKEN` | Only if `EventsServiceProvider` is registered |

**"Degrades" here means "throws a specific, obvious error"**, not "does
nothing". If `MAIL_TOKEN` isn't bound, the `mail` channel is never
`extend()`ed, and a `via()` returning `["mail"]` throws:

```
Driver "mail" is not registered on ChannelManager.
```

That's the same message any unregistered driver produces anywhere in the
framework, and it's deliberately noisy. The failure mode being avoided is
a notification that silently doesn't send because a provider is missing
from `config/app.ts`, a bug that surfaces as a support ticket six weeks
later, not as an exception.

The `if (app.has(...))` guards buy you the ability to *install less*: an
app with no mail package still gets working `database` notifications
instead of a boot-time crash. They do not buy you tolerance for a
misconfigured `via()`.

### Provider ordering

The channel factories resolve their tokens at `register()` time, so in
`config/app.ts` this provider must come **after**:

- `DatabaseServiceProvider`: always
- `MailServiceProvider`: if the `mail` channel is used
- `EventsServiceProvider`: if the `broadcast` channel is used

```ts
export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  // ...
  MailServiceProvider,
  NotificationsServiceProvider,
  // ...
];
```

`NotificationsServiceProvider` also contributes a `migrations()` hook
pointing at its own migrations directory, so `./artisan migrate` picks up
the `notifications` table with no extra wiring. See
[Providers](../providers/).

## The `notifications` table

```ts
await Schema.create("notifications", (table: Blueprint) => {
  table.string("id").primary();
  table.string("type");
  table.string("notifiable_type");
  table.string("notifiable_id");
  table.text("data");
  table.timestamp("read_at").nullable();
  table.timestamp("created_at");
  table.timestamp("updated_at");
  table.index(["notifiable_type", "notifiable_id"]);
});
```

| Column | Contents |
|---|---|
| `id` | `notification.id`, or a `randomUUID()` assigned at insert |
| `type` | The `Notification` subclass name |
| `notifiable_type` | The recipient's `morphAlias()` (or static `table` for a non-`Model` adapter) |
| `notifiable_id` | `routeNotificationFor("database")` |
| `data` | `JSON.stringify(toDatabase())` |
| `read_at` | `NULL` means unread |
| `created_at` | ISO string, set at insert |
| `updated_at` | ISO string; re-stamped when `read_at` flips |

The composite index on `(notifiable_type, notifiable_id)` is the one
query this table exists to serve: "everything for this recipient".

`id` is a **string** primary key, not an autoincrementing integer. Which
is why assigning a UUID v7 gives you chronological ordering and the
default v4 doesn't.

### Reading them back: `DatabaseNotification`

`@mahiframework/notifications` ships a read-model for this table so you don't have
to hand-roll one:

```ts
import { DatabaseNotification } from "@mahiframework/notifications";

// A recipient's notifications, newest first. Pass the discriminant + id
// the way DatabaseChannel wrote them: a real Model's morphAlias(), or a
// plain adapter's static table, and routeNotificationFor("database").
const rows = (await DatabaseNotification.for(User.morphAlias(), Auth.id()).get()).all();
for (const n of rows) {
  n.unread();      // read_at is null
  n.payload();     // decoded `data` JSON
  await n.markAsRead();
}

// Just the unread ones.
await DatabaseNotification.unreadFor(User.morphAlias(), Auth.id()).get();

// Mark all unread as read in one statement.
await DatabaseNotification.markAllAsRead(User.morphAlias(), Auth.id());
```

The `id` is a client-supplied string, so no key strategy is configured,
and `timestamps` stays on so `markAsRead()`/`markAsUnread()` stamp
`updated_at`, the column the migration carries for exactly this.

If you'd rather resolve the recipient as a relation, declare your own
model over the same table with a `notifiable` marker in its attributes:

```ts
import { Model, morphTo } from "@mahiframework/database";
import type { MorphTo } from "@mahiframework/database";

interface AppNotificationAttributes {
  id: string;
  type: string;
  notifiable_type: string;
  notifiable_id: string;
  data: string;
  read_at: string | null;
  created_at: string;
  updated_at: string;

  notifiable: MorphTo<User>;
}

class AppNotification extends Model<AppNotificationAttributes>()({
  table: "notifications",
  primaryKey: "id",
}) {
  static override relationships = {
    notifiable: morphTo<User>({
      morphType: "notifiable_type",
      morphId: "notifiable_id",
      types: { user: () => User },
    }),
  };
}
```

A relation is declared in two places that must agree: the `MorphTo<User>`
marker in the attributes interface (which gives `notification.notifiable`
its type) and the `morphTo()` definition in `static override
relationships` (which tells the loader how to fetch it).

The `types` keys must match what `DatabaseChannel` writes, i.e. each
model's `morphAlias()`. That's the agreement the alias chain exists to
guarantee.

## Sending

### `notify()`

```ts
function notify(notifiable: NotificationRoutable, notification: Notification): Promise<void>
```

The free-function analogue of Laravel's `$user->notify($notification)`.
TypeScript has no traits, so rather than mixing a `notify()` method into
every notifiable model, it's a plain function that resolves
`NOTIFICATIONS_TOKEN` off the global app.

```ts
import { notify } from "@mahiframework/notifications";

await notify(new UserNotifiable(post.user_id), notification);
```

Many recipients is a loop, or a `Promise.all`:

```ts
await Promise.all(followers.map((f) => notify(new UserNotifiable(f.id), notification)));
```

Prefer injecting `ChannelManager` via `NOTIFICATIONS_TOKEN` where you
have `app`, same guidance as `app()` itself.

### The `Notifications` facade

```ts
class Notifications extends Facade<ChannelManager>(() => NOTIFICATIONS_TOKEN)
```

| Static | Behaviour |
|---|---|
| `Notifications.send(notifiable \| notifiable[], notification)` | Deliver to one or many, sequentially |
| `Notifications.route(channel, target)` | Construct an `AnonymousNotifiable` |

```ts
await Notifications.send(user, new InvoicePaid(invoice));
await Notifications.send([alice, bob], new InvoicePaid(invoice));
await Notifications.send(Notifications.route("mail", "ops@example.com"), new ServerDown());
```

`send()` accepts an array so a single `await` covers a whole fan-out.
Recipients are processed sequentially and errors propagate, the same
contract as `ChannelManager.send()`, one level up.

It's `Notifications` (plural) because the package already exports
`Notification` (the base class). Same plural-facade / singular-base-class
split as `Events`/`Event`, `Bus`/`Job`, `Mail`/`Mailable`.

### From a listener

Dispatching notifications from event listeners keeps the notification
decision out of the controller:

```ts
export class NotifyOnLike implements Listener<PostLiked> {
  async handle(event: PostLiked): Promise<void> {
    const { like } = event;

    const post = await Post.find(like.post_id);
    if (post === undefined || post.user_id === like.user_id) return;   // no self-notify

    const notification = new LikeNotification(like.user_id, post.id);
    notification.id = randomUUIDv7();
    await notify(new UserNotifiable(post.user_id), notification);
  }
}
```

See [Events](../events/).

## Queued notifications

There is no `ShouldQueue` marker. Deferring delivery is a `Job`, the same
as it is for mail:

```ts
export class SendInvoicePaidJob extends Job {
  constructor(public readonly userId: string, public readonly invoiceId: string) {
    super();
  }

  async handle(): Promise<void> {
    const invoice = await Invoice.findOrFail(this.invoiceId);
    await notify(new UserNotifiable(this.userId), new InvoicePaid(invoice));
  }
}
```

Since `ChannelManager.send()` is sequential and errors propagate, one job
per channel gives you independent retries:

```ts
await Bus.dispatch(new SendInvoiceMailJob(userId, invoiceId));       // via() -> ["mail"]
await Bus.dispatch(new PersistInvoiceNotificationJob(userId, id));   // via() -> ["database"]
```

See [Queues](../queues/).

## Sending after a transaction commits

A notification sent inside a `DB.transaction()` is delivered immediately by
default. Override `afterCommit()` to return `true` and the whole fan-out is
held until the transaction commits, and dropped if it rolls back:

```ts
class InvoicePaid extends Notification {
  override afterCommit() { return true; }
  via() { return ["mail", "database"]; }
  // ...
}

await DB.transaction(async () => {
  const invoice = await Invoice.create({ ... });
  await notify(user, new InvoicePaid(invoice));   // delivered after commit
});
```

Outside a transaction it delivers immediately. Built on `@mahiframework/database`'s
[after-commit dispatch](../database/#after-commit-dispatch-for-events-jobs-mail--notifications).

## Writing a channel

Implement `NotificationChannel`, invent an optional `toXxx()` convention,
and register it with `extend()`:

```ts
import { ServiceProvider } from "@mahiframework/core";
import {
  ChannelManager,
  NOTIFICATIONS_TOKEN,
  type NotificationChannel,
  type Notification,
  type NotificationRoutable,
} from "@mahiframework/notifications";

declare module "@mahiframework/notifications" {
  interface Notification {
    toSlack?(notifiable: NotificationRoutable): { text: string };
  }
}

export class SlackChannel implements NotificationChannel {
  constructor(private client: SlackClient) {}

  async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
    if (!notification.toSlack) return;

    const webhook = notifiable.routeNotificationFor("slack");
    if (typeof webhook !== "string") return;

    await this.client.post(webhook, notification.toSlack(notifiable));
  }
}

export class SlackServiceProvider extends ServiceProvider {
  boot(): void {
    this.app
      .make<ChannelManager>(NOTIFICATIONS_TOKEN)
      .extend("slack", () => new SlackChannel(new SlackClient()));
  }
}
```

Two conventions worth following, because every built-in channel does:

**Skip when the builder is absent.** `if (!notification.toSlack) return;`.
A notifiable may list `"slack"` in `via()` only conditionally.

**Take dependencies through the constructor.** Resolve them once in the
factory rather than calling `app().make()` inside `send()`. That keeps
the channel a plain testable object, which is what `MailChannel` and
`DatabaseChannel` both do.

## Testing

Register a fake channel and assert it was called. `ChannelManager` is a
plain `Manager`, constructible without any providers:

```ts
const manager = new ChannelManager(new Application());
const calls: unknown[] = [];
manager.extend("database", () => ({ async send(n, notification) { calls.push(notification); } }));

await manager.send(new UserNotifiable("42"), new LikeNotification("7", "9"));

expect(calls).toHaveLength(1);
```

For the mail channel specifically, point `mail.default` at `"array"` and
assert against `ArrayTransport.messages`. See [Mail](../mail/#testing).

For the database channel, assert on the table:

```ts
await notify(new UserNotifiable(user.id), new LikeNotification(actor.id, post.id));

const rows = await Notification.query()
  .where("notifiable_type", "users")
  .where("notifiable_id", user.id)
  .get();

expect(rows).toHaveLength(1);
expect(JSON.parse(rows[0].data)).toMatchObject({ type: "like" });
```

## Gotchas

**`via()` naming an unregistered channel throws.** It does not skip. Check
that the backing provider is in `config/app.ts`.

**Channels run sequentially and errors propagate.** A failing mail channel
prevents a later `database` channel in the same `via()` from running.
There is no partial-success result.

**A notification with no matching `toXxx()` silently sends nothing on that
channel.** `via(): ["mail"]` on a notification with no `toMail` is a
no-op, not an error. That's intentional (conditional channels) and is the
one place where a typo goes unnoticed.

**`DatabaseChannel` needs a static `table` on the notifiable's
constructor.** Plain rows from `@mahiframework/database` don't have one, wrap
them, as `UserNotifiable` does.

**`route("database", ...)` on an `AnonymousNotifiable` throws.** By
design; there's no persisted recipient to key a row to.

**`type` in the database is `constructor.name`.** Renaming a
`Notification` subclass changes the value written for new rows and leaves
old rows alone. Put a stable discriminant in the JSON payload if you need
one.

**Notification `id` defaults to a UUID.** If you're paginating by `id`,
assign a time-sortable value before calling `notify()`.

**`routeNotificationFor("mail")` is not read automatically.** The mailable
owns its recipients; `toMail()` has to call `.to(...)` itself.

**`toDatabase()` returns `object`, not `Record<string, unknown>`.** That's
so a named interface is assignable. It also means TypeScript won't stop
you returning something with no useful shape.

## Related

- [Mail](../mail/): `Mailable`, and why recipients live on it
- [Broadcasting](../broadcasting/): `ShouldBroadcast`, and the single-process caveat
- [Events](../events/): `NotificationBroadcast`, dispatching from listeners
- [Queues](../queues/): deferring delivery; there is no `ShouldQueue`
- [Migrations](../migrations/): the provider-contributed `notifications` table
- [Models](../models/): a read model over that table
- [Pagination](../pagination/): `cursorPaginate` over notification `id`s
- [Providers](../providers/): the `migrations()` hook and boot ordering
