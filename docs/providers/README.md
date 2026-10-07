# Service providers

A service provider is a class with three optional lifecycle methods and a
set of optional hooks. It is the only extension point in Mahi, routes,
commands, listeners, migrations, jobs, policies, scheduled tasks, and
container bindings all arrive through one.

```ts
import { ServiceProvider } from "@mahiframework/core";

export class PostsServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(POSTS_TOKEN, (app) => new PostRepository(app));
  }

  routes(router: Router): void {
    registerPostRoutes(router);
  }
}
```

Providers are listed in `config/app.ts` and instantiated during
`app.bootstrap()`. They receive the `Application` as their only
constructor argument, stored as the protected `app` field.

## register() vs boot() vs shutdown()

```ts
export abstract class ServiceProvider implements ProviderHooks {
  constructor(protected app: Application) {}

  register?(): void | Promise<void>;
  boot?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}
```

All three are optional and all may be async. The guarantee:

> **Every provider's `register()` completes before any provider's
> `boot()` starts.** Boots then run **sequentially**, in registration
> order, each awaited before the next begins. `shutdown()` runs during
> `app.terminate()`, in **reverse** registration order.

Concretely, for providers A and B registered in that order, the call
sequence is always `A.register`, `B.register`, `A.boot`, `B.boot`,
`B.shutdown`, `A.shutdown`, and if `A.boot()` is async and takes 20ms
while `B.boot()` is synchronous, `B` still runs second. This is not
`Promise.all`; it's a deliberate ordering guarantee that providers depend
on. The reversal at shutdown is the same guarantee read backwards: a
provider unwinds before whatever it booted on top of.

### What goes in register()

**Only bindings.** Register your own services into the container and
merge your own default config. Nothing else.

You cannot assume any other provider has registered yet. `register()` runs
in list order, so a provider listed earlier has bound its tokens by the
time yours runs, but relying on that couples you to list position, and
the framework's own providers deliberately don't. The exception is
`RedisServiceProvider`, which *does* resolve other managers in
`register()` and documents the ordering requirement loudly for it.

Because container factories are lazy, a factory body can freely resolve
anything. It doesn't run until someone calls `make()`, long after all
registration is done:

```ts
register(): void {
  this.app.singleton(RATE_LIMITER_TOKEN, (app) => {
    // Runs on first make(), not now. CACHE_TOKEN is guaranteed bound.
    const manager = app.make<CacheManager>(CACHE_TOKEN);
    return new RateLimiter(manager.store());
  });
}
```

That is the normal way to express a dependency between providers: put the
`make()` call *inside* the factory, not in the `register()` body.

### What goes in boot()

**Everything that needs other providers.** By `boot()`, every token in the
application is bound. This is where you:

- Resolve services and configure them.
- Collect hooks from other providers.
- Open connections (`Connectable.connect()`).
- Decorate other packages' services.

```ts
export class AppServiceProvider extends ServiceProvider {
  boot(): void {
    const limiter = this.app.make<RateLimiter>(RATE_LIMITER_TOKEN);

    limiter.for("login", async (request: Request) => Limit.perMinute(5).by(await loginKey(request)));
    limiter.for("register", (request: Request) => Limit.perMinute(10).by(clientIp(request)));
  }
}
```

Async `boot()` is normal and is how connection warm-up works:

```ts
async boot(): Promise<void> {
  const manager = this.app.make<DatabaseManager>(DATABASE_TOKEN);
  const driver = manager.driver();

  if (isConnectable(driver)) {
    await driver.connect();
  }
}
```

Because boots are sequential and awaited, every provider after
`DatabaseServiceProvider` in the list can assume the connection is open.

### What goes in shutdown()

**Whatever `boot()` acquired.** `shutdown()` is the mirror of `boot()` and
runs during `app.terminate()`, in **reverse** registration order, so a
provider tears down before the providers it booted on top of.

```ts
async shutdown(): Promise<void> {
  const manager = this.app.make<DatabaseManager>(DATABASE_TOKEN);
  await manager.disconnectAll();
}
```

Implement it for anything that keeps Node's event loop alive: connection
pools, sockets, `setInterval` timers, file watchers. A pool opened in
`boot()` and never closed is why a CLI command finishes its work and then
the process just sits there instead of exiting.

Three things to get right:

- **Be best-effort.** Failures are caught and logged by `terminate()`, not
  raised. The process is going down regardless, and one broken teardown
  must not strand a pool the next hook would have closed.
- **Guard against a partial boot.** `shutdown()` can run after an *earlier*
  provider's `boot()` threw, so state your own `boot()` creates may not
  exist yet.
- **Don't resolve to destroy.** Check `app.isResolved(TOKEN)` before
  `make()`ing something in order to close it, or you construct the very
  pool you were trying not to leave open. `Manager.disconnectAll()` applies
  the same rule to drivers.

See [Application lifecycle](../lifecycle/#termination) for the full
sequence.

## Hooks

Beyond `register()`/`boot()`, a provider may implement any of ten hook
methods. All are optional; implement only what you need. Each is collected
by whichever package owns it, by iterating `app.getProviders()`.

| Hook | Signature | Collected by | When |
|---|---|---|---|
| `routes` | `(router: Router) => void` | `HttpKernel.collectFromProviders()` | `HttpServiceProvider.boot()` |
| `middleware` | `() => HttpPipe[]` | `HttpKernel.collectFromProviders()` | `HttpServiceProvider.boot()` |
| `models` | `() => Array<typeof Model>` | `ModelRegistry` | `DatabaseServiceProvider.boot()` |
| `migrations` | `() => string` | `collectMigrationDirectories()` | migrate commands, at run time |
| `seeders` | `() => Array<new (app) => Seeder>` | `DbSeedCommand` | `db:seed`, at run time |
| `commands` | `() => CommandClass[]` | `ConsoleKernel.collectFromProviders()` | `bin/console.ts`, after bootstrap |
| `listeners` | `() => Array<[EventClass, ListenerClass]>` | `EventDispatcher` | `EventsServiceProvider.boot()` |
| `jobs` | `() => Record<string, JobClass>` | `JobRegistry` | `QueueServiceProvider.boot()` |
| `gates` | `(gate: GateRegistry) => void` | `GateRegistry` | `AuthorizationServiceProvider.boot()` |
| `schedule` | `(schedule: Schedule) => void` | `Schedule` | `ScheduleServiceProvider.boot()` |
| `checks` | `() => HealthCheck[]` | `HealthRegistry` | `HealthServiceProvider.boot()` |

Note the "when" column. Hooks collected during another provider's `boot()`
are gathered from **every** provider regardless of list position, the
collector iterates all of them, and they're all instantiated before any
boot runs. So a hook on the last provider in the list is still picked up
by a collector in the first. What list position affects is the *order*
within the collected set, and whether a token you resolve inside a hook
body is bound yet.

### routes(router)

Receives the root `Router`. Routes are registered from providers rather
than a global route file, so a feature's routes live next to the rest of
it.

```ts
export class AppServiceProvider extends ServiceProvider {
  routes(router: Router): void {
    registerAuthRoutes(router);
  }
}
```

```ts
export function registerAuthRoutes(router: Router): void {
  router.group("/auth", (auth) => {
    auth.post("/register", RegisterController).middleware(throttle("register")).name("auth.register");
    auth.post("/login", LoginController).middleware(throttle("login")).name("auth.login");
    auth.post("/logout", LogoutController).middleware(authenticate()).name("auth.logout");
    auth.get("/me", MeController).middleware(authenticate()).name("auth.me");
  });
}
```

See [Routing](../routing/) for the router API.

### middleware()

Global HTTP pipes, run ahead of route dispatch for every request. Pipes
are collected in provider registration order, an earlier provider's pipes
run before a later one's.

```ts
export class AuthServiceProvider extends ServiceProvider {
  middleware(): HttpPipe[] {
    return [(request, next) => runWithAuth({ user: null, guard: null }, () => next(request))];
  }
}
```

`HttpPipe` is `Pipe<Request, ResponseInput>` from `@mahiframework/pipeline`. It
receives the framework `Request` (not a Hono context) and a `next`
function, and returns a response. A pipe that returns without calling
`next(request)` short-circuits the whole request.

### models()

Model classes that can appear inside queued job payloads. Each must
declare a `static morphName`. They serialize to `{ __model, __id }` and
rehydrate before `handle()` runs, so a worker process can reconstruct a
model it never imported.

```ts
models(): Array<typeof Model> {
  return [User, Post];
}
```

### migrations()

An **absolute** path to a directory of migration files this provider
contributes. Collected alongside the app's own `database/migrations` by
`migrate`, `migrate:rollback`, `migrate:status`, and friends.

```ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class QueueServiceProvider extends ServiceProvider {
  migrations(): string {
    return path.join(__dirname, "migrations");
  }
}
```

Note it returns one string, not an array.

Prefer `migrationSources()` below in any provider that might be bundled,
a directory path resolves to nothing inside a single-file executable, and
the runner reports that as "nothing to migrate" rather than an error.

### migrationSources()

The bundle-safe form: this provider's migrations as explicit,
statically-imported `{ name, migration }` entries. Collected by the same
`migrate*` commands, and preferred over this provider's `migrations()` if
both are implemented.

```ts
import createJobsTable from "./migrations/0001_create_jobs_table.js";

export class QueueServiceProvider extends ServiceProvider {
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_jobs_table", migration: createJobsTable }];
  }
}
```

This is how the framework's own tables, `personal_access_tokens`,
`sessions`, `jobs`, `failed_jobs`, `notifications`, get created without
you copying migration files into your app. `@mahiframework/auth`, `@mahiframework/queue`,
and `@mahiframework/notifications` each register theirs statically, so they work in
a compiled binary; each also keeps a `migrations()` directory for older
consumers.

`name` is what lands in the `migrations` table and orders execution, so it
must stay identical to the filename-without-extension the directory form
produced. See [Migrations → Static migration sources](../migrations/README.md#static-migration-sources).

### seeders()

Seeder classes, run in registration order by `db:seed`.

```ts
seeders() {
  return [DatabaseSeeder];
}
```

### commands()

Console command classes, registered onto the Commander program by
`ConsoleKernel`.

```ts
export class ScheduleServiceProvider extends ServiceProvider {
  commands() {
    return [ScheduleRunCommand, ScheduleListCommand, ScheduleTestCommand, ScheduleWorkCommand];
  }
}
```

Command signatures must be unique across the whole application. The
kernel throws at startup if two providers register the same signature.
This happens when you re-list a framework command that its own provider
already contributes. See [Console](../console/).

### listeners()

`[EventClass, ListenerClass]` pairs, wired into the `EventDispatcher`.

```ts
listeners(): ReadonlyArray<ListenerRegistration> {
  return [
    [PostCreated, LogPostCreated],
    [PostCreated, NotifyOnReply],
    ["model.posts.*", AuditModelWrites],
  ];
}
```

One event may have many listeners; list a pair per listener.

An event-**name** wildcard pattern is accepted in place of the event
class, and a closure in place of the listener class. A pattern matches
`event.eventName` and can't narrow the event type, so a closure paired
with one receives `AbstractEvent`. `listenQueued()` is the only
registration this hook can't express. See [Events](../events/).

### jobs()

Job-name-to-class pairs. The name is what gets persisted in the queue
payload, so a worker can reconstruct the class by name.

```ts
jobs(): Record<string, JobClass> {
  return {
    "posts:log-created": LogPostCreatedJob,
    "posts:welcome-author": WelcomePostAuthorJob,
  };
}
```

Names are yours to choose but must be stable, changing one orphans any
job already sitting in the queue under the old name. See [Queues](../queues/).

### gates()

Receives the `GateRegistry`. Register abilities and policies on it.

```ts
gates(gate: GateRegistry): void {
  gate.policy(Post, PostPolicy);
  gate.define("admin", (user: User) => user.isAdmin);
}
```

A single hook covers both, rather than a separate `policies()` returning
tuples, same shape as `schedule()`: receive the registry, call methods on
it. See [Authorization](../authorization/).

### schedule()

Receives the `Schedule`. Register recurring tasks on it.

```ts
schedule(schedule: Schedule): void {
  schedule
    .call(async (app) => {
      await new AuthGcCommand(app).handle();
    })
    .daily()
    .name("auth-gc")
    .withoutOverlapping();
}
```

`schedule.job(() => new SomeJob())` takes a factory, not an instance, so
each tick enqueues a fresh job. It requires `QUEUE_TOKEN` to be bound and
throws a clear error if `QueueServiceProvider` isn't registered. See
[Scheduling](../scheduling/).

### checks()

Returns readiness checks. The dependencies that must be working for this
instance to serve traffic. Surfaced by `GET /health` and
`./artisan health`.

```ts
checks(): HealthCheck[] {
  return [
    {
      name: "stripe",
      async run() {
        const res = await fetch("https://api.stripe.com/healthcheck");
        if (!res.ok) return `Stripe returned ${res.status}`;
      },
    },
  ];
}
```

Throw or return a string to fail, return nothing to pass, return `null` to
skip. Checks default to the `"app"` group; declaring `group: "core"` with a
built-in's name replaces that built-in, since later registrations win.

Checks must be cheap and constant-cost, `run()` executes on every probe
interval, on every instance. See [Health checks](../health/).

## How hook typing works

`@mahiframework/core` declares an empty interface:

```ts
export interface ProviderHooks {}

export abstract class ServiceProvider implements ProviderHooks { ... }

export interface ServiceProvider extends ProviderHooks {}
```

That's it. Core has no `routes()`, no `commands()`, no knowledge that HTTP
or the CLI exist.

Each package that owns a hook augments the interface from its own side:

```ts
// @mahiframework/http — provider-hooks.ts
import type { Router } from "./router.js";
import type { HttpPipe } from "./middleware/pipeline-middleware.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    routes?(router: Router): void;
    middleware?(): HttpPipe[];
  }
}
```

and imports that file for its side effect from its own entry point:

```ts
// @mahiframework/http — index.ts
import "./provider-hooks.js";
```

TypeScript merges every augmentation it sees into one interface. Because
`ServiceProvider` is declaration-merged with `ProviderHooks`, subclasses
can implement any merged hook as a normal typed method override.

The payoff is that **the set of hooks available to you is exactly the set
of packages you installed**. An app importing `@mahiframework/http`, `@mahiframework/cli`,
and `@mahiframework/events` sees `routes`, `middleware`, `commands`, and
`listeners`, fully typed, with `Router` and `CommandClass` resolved to
their real types, while `@mahiframework/core` never imports any of those packages
and has no dependency on them. Remove `@mahiframework/http` from your
`package.json` and `routes()` stops type-checking, which is correct: there
is nothing to collect it.

The tradeoff is that a hook name typo is invisible. `routs(router)` is a
perfectly legal extra method on a class; nothing will tell you it's never
called. TypeScript's `override` keyword doesn't help here either, since
the hooks are optional interface members rather than base-class methods.

## Writing a plugin package

A distributable Mahi package is a provider plus whatever it binds. The
shape every framework package follows:

```ts
// src/tokens.ts
export const BILLING_TOKEN = "billing";
```

```ts
// src/billing-service-provider.ts
import { ServiceProvider, isConnectable, EVENTS_TOKEN } from "@mahiframework/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BillingManager, type BillingConfig } from "./billing-manager.js";
import { StripeDriver } from "./drivers/stripe-driver.js";
import { BillingSyncCommand } from "./commands/billing-sync.js";
import { BILLING_TOKEN } from "./tokens.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { BILLING_TOKEN };

export class BillingServiceProvider extends ServiceProvider {
  register(): void {
    // Contribute defaults without clobbering anything the app already set.
    this.app.config.merge("billing", {
      default: "stripe",
      drivers: { stripe: { apiVersion: "2024-06-20" } },
    });

    this.app.singleton(BILLING_TOKEN, (app) => {
      const config = app.config.get<BillingConfig>("billing");
      const manager = new BillingManager(app, config);

      manager.extend("stripe", () => new StripeDriver(manager.driverConfig("stripe")));

      return manager;
    });
  }

  async boot(): Promise<void> {
    const driver = this.app.make<BillingManager>(BILLING_TOKEN).driver();
    if (isConnectable(driver)) await driver.connect();
  }

  migrations(): string {
    return path.join(__dirname, "migrations");
  }

  commands() {
    return [BillingSyncCommand];
  }
}
```

```ts
// src/index.ts
export { BillingServiceProvider, BILLING_TOKEN } from "./billing-service-provider.js";
export { BillingManager } from "./billing-manager.js";
export type { BillingConfig } from "./billing-manager.js";
```

Conventions worth following, because the framework packages all do:

**Own exactly one token per service, and export the constant.** Consumers
should never type the string. If your token needs to be resolved by a
package that can't depend on yours, look at how
[`well-known-tokens.ts`](../container/#well-known-tokens) handles that.

**Contribute config with `merge()` in `register()`.** The app's own
`config.set()` calls in `bin/bootstrap.ts` run before any provider, so a
`merge()` layers defaults *under* whatever the app decided. See
[Configuration](../configuration/#merge-vs-set).

**Use `Manager` for anything with named drivers**, and register your
built-ins with `extend()`, the same call a downstream plugin would use to
add one. No special-casing for built-ins.

**Make optional dependencies soft.** Guard with `app.has(TOKEN)`:

```ts
if (app.has(MAIL_TOKEN)) {
  manager.extend("mail", () => new MailChannel(app.make<MailManager>(MAIL_TOKEN)));
}
```

An app that didn't install `@mahiframework/mail` gets a package that works, minus
the mail channel, not a `BindingNotFoundError` during boot.

**Add a `declare module "@mahiframework/core"` block** if your package introduces a
new hook, and import it for side effect from `index.ts`.

**Document your ordering constraints in the provider's docstring.** You
cannot enforce them; the app's `config/app.ts` decides. A clear docstring
is the whole mechanism.

`./artisan make:provider Billing` scaffolds the skeleton.

## Provider ordering

`boot()` runs sequentially in list order, so a provider may rely on an
earlier one being fully booted. The base app's `config/app.ts` documents
every constraint that applies:

```ts
export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  QueueServiceProvider,
  ScheduleServiceProvider,
  CacheServiceProvider,
  StorageServiceProvider,
  EncryptionServiceProvider,
  AuthServiceProvider,
  AuthorizationServiceProvider,
  LoggingServiceProvider,
  ConsoleServiceProvider,
  HttpServiceProvider,
  BroadcastServiceProvider,
  RedisServiceProvider,
  MailServiceProvider,
  NotificationsServiceProvider,

  AppServiceProvider,
];
```

The reasoning, constraint by constraint:

**`EventsServiceProvider` before anything that dispatches events during
its own `boot()`.** Listeners are wired in the events provider's boot; a
provider that dispatches before that happens dispatches into the void.

**`DatabaseServiceProvider` before anything that queries during boot**,
including `QueueServiceProvider`, whose `database` connection factory
resolves `DatabaseManager`.

**`ScheduleServiceProvider` after `QueueServiceProvider`**, so a task
using `schedule.job(...)` finds a bound `QUEUE_TOKEN`. Soft dependency,
`schedule()` hooks that never call `.job()` work either way.

**`CacheServiceProvider` before `HttpServiceProvider`**, since
`throttle()`'s `RateLimiter` resolves the default cache store.

**`AuthServiceProvider` after Database** (user lookups plus its own
`personal_access_tokens` and `sessions` tables), **after Encryption**
(`HASHER_TOKEN` for passwords, `SIGNER_TOKEN` for signed session
cookies), **and before Http**, so `AUTH_TOKEN` is bound, and its global
auth-scope pipe collected, before routes and middleware are.

**`AuthorizationServiceProvider` after Auth** (its gate resolves the
current user through `AUTH_TOKEN`) **and before Http**, so `GATE_TOKEN` is
bound before routes referencing `can()` are collected.

**`BroadcastServiceProvider` after Events** (it decorates the dispatcher
with an `afterDispatch()` hook) **and after Http** (it mounts its
websocket upgrade endpoint onto the already-constructed kernel).

**`RedisServiceProvider` after Cache/Queue/Broadcast.** Its `register()`
extends each of those managers with a `redis` driver, so their tokens must
already be bound. This is the one provider that genuinely resolves other
providers' tokens during `register()` rather than inside a lazy factory.
It stays inert until some config points at `"redis"`, so listing it costs
nothing without a running Redis.

**`NotificationsServiceProvider` after Database** (it owns the
`notifications` table), **Mail, and Events**, its channel factories
resolve those tokens at `register()` time.

`LoggingServiceProvider`, `EncryptionServiceProvider`, and
`MailServiceProvider` have no ordering dependency in either direction;
they're grouped with the other always-on infrastructure providers.

**Framework providers first, then your own, added at the bottom.** Your
providers almost always consume framework services and almost never the
reverse.

Note what's *not* on this list: nothing is registered implicitly. Even
`LoggingServiceProvider`, which lives in `@mahiframework/core`, must be listed
explicitly like everything else, consistent with there being no implicit
registration anywhere, and with `Application.logger` remaining the
always-available zero-config fallback.

## Splitting by feature

`AppServiceProvider` is where a new app wires things up, but it isn't
meant to stay the only one. Split by feature and list them all:

```ts
  UsersServiceProvider,
  MediaServiceProvider,
  PostsServiceProvider,
  LikesServiceProvider,
  FollowsServiceProvider,
```

A feature provider owns its routes, its events and listeners, its jobs,
its policies, its rate limiters, and its commands:

```ts
export class PostsServiceProvider extends ServiceProvider {
  boot(): void {
    const limiter = this.app.make<RateLimiter>(RATE_LIMITER_TOKEN);
    limiter.for("create-post", (request: Request) => Limit.perMinute(30).by(request.ip() ?? "unknown"));
  }

  routes(router: Router): void {
    registerPostRoutes(router);
  }

  gates(gate: GateRegistry): void {
    gate.policy(Post, PostPolicy);
  }

  listeners(): Array<[EventClass, ListenerClass]> {
    return [
      [PostCreated, LogPostCreated],
      [PostCreated, NotifyOnReply],
    ];
  }

  jobs(): Record<string, JobClass> {
    return {
      "posts:log-created": LogPostCreatedJob,
      "posts:welcome-author": WelcomePostAuthorJob,
    };
  }

  models(): Array<typeof Model> {
    return [User, Post];
  }

  commands() {
    return [PostSeedCommand];
  }

  checks(): HealthCheck[] {
    return [{ name: "posts-search", run: () => searchIndex.ping() }];
  }
}
```

Every wire from that feature to the framework is on one screen.

## Gotchas

**Registering a provider after `bootstrap()` does nothing.** `register()`
pushes onto a class list that `bootstrap()` reads once. Post-bootstrap
additions are never instantiated and never run, silently. Register
everything before you bootstrap.

**`getProviders()` is empty until `bootstrap()` runs.** Instances are
created inside `bootstrap()`, so anything iterating providers must run
after that. Every collector in the framework runs from a `boot()` hook or
later for this reason.

**Resolving another provider's token in your `register()` body is a
list-order bet.** Put the `make()` inside the lazy factory instead. If
you genuinely can't, `RedisServiceProvider` genuinely can't, since
`extend()` mutates a live manager, document the constraint in the
provider docstring, because nothing else will catch it.

**Duplicate command signatures throw at startup.** Registering a framework
command your app already gets via its owning provider is the usual cause.
The base app's `AppServiceProvider` invokes `AuthGcCommand` directly from
a scheduled task rather than re-listing it in `commands()`, specifically
to avoid this.

**An async `register()` is awaited, and it blocks every other provider's
registration.** It's supported, but if you're doing I/O there, ask whether
it belongs in `boot()`.

**`migrations()` returns an absolute path.** Use `path.dirname(fileURLToPath(import.meta.url))`,
not a relative string, the CLI resolves the app's own migrations
directory against `base_path()`, but a package's directory must be
resolved against the package.

**A `migrations()` directory that cannot be read is not an error.** The
runner treats it as "nothing to discover" and moves on, which is right for
a directory that does not exist and badly wrong inside a bundle, where
it means the provider's tables are silently never created. Use
`migrationSources()` if the provider may be compiled.

## Related

- [Service container](../container/): `bind`, `singleton`, `make`, tokens
- [Application lifecycle](../lifecycle/): the exact bootstrap sequence
- [Configuration](../configuration/): `set()` vs `merge()`, config namespaces
- [Routing](../routing/): the `Router` passed to `routes()`
- [Console](../console/): writing the classes `commands()` returns
- [Events](../events/): the classes `listeners()` pairs up
