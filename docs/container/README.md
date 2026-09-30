# Service container

The container maps string tokens to factories. A service provider binds a
factory; a consumer calls `app.make(TOKEN)`. That is the whole model.

```ts
import { Application, CACHE_TOKEN } from "@mahiframework/core";
import type { CacheManager } from "@mahiframework/cache";

const app = new Application();
const cache = app.make<CacheManager>(CACHE_TOKEN);
```

`Application` extends `Container`, so every method on this page is
available on the app instance you already have, in a provider
(`this.app`), a command (`this.app`), or inside a factory (its argument).

## Binding

| Method | Behaviour |
|---|---|
| `bind<T>(token, factory)` | Factory runs on **every** `make()`. New value each time. |
| `singleton<T>(token, factory)` | Factory runs once; the result is cached and returned thereafter. |
| `scoped<T>(token, factory)` | Factory runs once **per scope** (`runScoped()`); cached for that scope only, transient outside one. |
| `instance<T>(token, value)` | Register an already-constructed value. Implicitly shared. |

```ts
export class CacheServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(CACHE_TOKEN, (app) => {
      const config = app.config.get<CacheConfig>("cache");
      const manager = new CacheManager(app, config);

      manager.extend("array", () => new ArrayCacheStore());
      manager.extend("file", () => {
        const fileConfig = (manager.storeConfig("file") ?? {}) as { path?: string };
        return new FileCacheStore(fileConfig.path ?? storage_path("cache"));
      });

      return manager;
    });

    this.app.singleton(RATE_LIMITER_TOKEN, (app) => {
      const manager = app.make<CacheManager>(CACHE_TOKEN);
      return new RateLimiter(manager.store());
    });
  }
}
```

That is how `@mahiframework/cache` registers itself, and it shows two
things: a factory resolves its own
dependencies by calling `app.make()`, and re-binding a token drops any
cached instance, `bind()` and `singleton()` both call
`instances.delete(token)` before storing the new binding.

`instance()` is what the base app's bootstrap uses for the validated
environment object, which is a plain value with nothing to construct:

```ts
const env = loadEnv({ schema: envSchema });
app.instance("env", env);
```

`scoped()` registers a factory resolved once **per scope** and cached only
for that scope. A scope is opened with `runScoped()` (an `AsyncLocalStorage`
region, the same primitive request-scoped state, auth identity, log
context, the active transaction, already uses):

```ts
app.scoped(REQUEST_ID_TOKEN, () => crypto.randomUUID());

await app.runScoped(async () => {
  app.make(REQUEST_ID_TOKEN); // resolved once
  app.make(REQUEST_ID_TOKEN); // same value, within this scope
});
// A second runScoped() gets a fresh value. Outside any scope, a scoped
// binding resolves fresh every time (transient-like) and is never cached
// on the process-global container.
```

### Test / lifecycle helpers

| Method | Behaviour |
|---|---|
| `forget(token)` | Drop the binding, cached instance and extenders entirely. |
| `forgetInstance(token)` | Drop only the cached instance; the binding stays and rebuilds on next `make()`. |
| `flush()` | Reset the container: all bindings, instances, extenders. |

Circular resolution (`a → b → a`) throws a `CircularDependencyError` naming
the cycle, rather than an opaque `RangeError: Maximum call stack`.

## Resolving

```ts
make<T>(token: string): T
has(token: string): boolean
```

`make()` runs a fixed sequence:

1. If a **cached instance** (or, inside a scope, a **scoped instance**)
   exists for the token, return it. No factory runs, no extenders run.
2. Look up the **binding**. If there is none, throw `BindingNotFoundError`.
   (If the token is already mid-resolution on the stack, throw
   `CircularDependencyError` naming the cycle.)
3. Call the **factory** with the container.
4. Run every registered **extender** for that token, in registration
   order, each receiving the previous result.
5. If the binding is a **singleton**, cache the result; if it is **scoped**
   and a scope is open, cache it in the scope.
6. Return it.

Step 1 coming before step 4 is the reason `extend()` has to handle
already-resolved singletons specially. See [`extend()`](#extend) below.

`BindingNotFoundError` carries the token:

```ts
export class BindingNotFoundError extends Error {
  constructor(public readonly token: string) {
    super(`Nothing bound in the container for token "${token}".`);
    this.name = "BindingNotFoundError";
  }
}
```

`has()` returns true if either a binding *or* an instance is registered.
Packages use it to make dependencies soft, `@mahiframework/notifications` only
wires its `mail` channel when `MAIL_TOKEN` is actually bound:

```ts
if (app.has(MAIL_TOKEN)) {
  manager.extend("mail", () => new MailChannel(app.make<MailManager>(MAIL_TOKEN)));
}
```

## Factory typing

```ts
export type Factory<T, TContainer = Container> = (container: TContainer) => T;
```

`bind`/`singleton` declare their factory as `Factory<T, this>`. Because
`this` is polymorphic, a factory registered on an `Application` is typed
as receiving an `Application`, not a bare `Container`:

```ts
this.app.singleton(LOG_TOKEN, (app) => {
  // `app` is Application here — `config`, `logger`, `environment()` all
  // resolve, with no cast.
  const config = app.config.get<LogConfig>("logging");
  return new LogManager(app, config);
});
```

Without the `this`-typing, every factory in the framework would need an
`as Application` cast to reach `app.config`. This is a small piece of
typing that removes a cast from roughly every provider in the codebase.

## extend()

```ts
extend<T>(token: string, callback: (value: T, container: this) => T): void
```

Decorate whatever a token resolves to. The callback receives the resolved
value and returns the replacement.

```ts
app.singleton("n", () => 1);
app.extend<number>("n", (n) => n + 1);
app.make<number>("n"); // 2
```

Two behaviours worth committing to memory:

**It applies retroactively.** If the token is already resolved and cached
(a singleton someone has made, or an `instance()`), `extend()` runs the
callback immediately against the cached value and writes the result back.
You do not have to order your `extend()` call before the first `make()`.

```ts
app.instance("m", 10);
app.make("m");            // 10 — resolved and cached
app.extend<number>("m", (m) => m * 2);
app.make("m");            // 20 — the cached instance was rewritten
```

**It does not require the token to exist.** `extend()` only appends to an
extender list; it never looks up the binding. Extending an unbound token
is silent, and the extender will fire if and when something binds and
resolves that token later. That is convenient for optional integrations
and a trap if you typo the token. Nothing will tell you.

For a transient (`bind()`) token, extenders run on every single `make()`.
For a shared token they run once, and the extended value is what gets
cached.

## Well-known tokens

Tokens are strings. Tokens that cross package boundaries are declared once
in `@mahiframework/core`'s `well-known-tokens.ts` and re-exported by their owning
package, so a typo is a compile error rather than a runtime
`BindingNotFoundError`.

| Token constant | Value | Resolves to | Owner |
|---|---|---|---|
| `DATABASE_TOKEN` | `"db"` | `DatabaseManager` | `@mahiframework/database` |
| `AUTH_TOKEN` | `"auth"` | `AuthManager` | `@mahiframework/auth` |
| `GATE_TOKEN` | `"gate"` | `GateRegistry` | `@mahiframework/authorization` |
| `QUEUE_TOKEN` | `"queue"` | `QueueManager` | `@mahiframework/queue` |
| `CACHE_TOKEN` | `"cache"` | `CacheManager` | `@mahiframework/cache` |
| `EVENTS_TOKEN` | `"events"` | `EventDispatcher` | `@mahiframework/events` |
| `BROADCAST_TOKEN` | `"broadcast"` | `BroadcastManager` | `@mahiframework/broadcasting` |
| `STORAGE_TOKEN` | `"storage"` | `StorageManager` | `@mahiframework/storage` |

All eight are importable from `@mahiframework/core` *and* from their owning
package. `@mahiframework/authorization` resolves the current user through
`AUTH_TOKEN` without depending on `@mahiframework/auth`; `@mahiframework/schedule`
dispatches through `QUEUE_TOKEN` without depending on `@mahiframework/queue`. That
is what these constants are for.

Package-private tokens stay in their own package:

| Token constant | Value | Resolves to | Package |
|---|---|---|---|
| `LOG_TOKEN` | `"log"` | `LogManager` | `@mahiframework/core` |
| `SCHEMA_TOKEN` | `"db.schema"` | `SchemaBuilder` | `@mahiframework/database` |
| `MODEL_REGISTRY_TOKEN` | `"db.models"` | `ModelRegistry` | `@mahiframework/database` |
| `HTTP_KERNEL_TOKEN` | `"http.kernel"` | `HttpKernel` | `@mahiframework/http` |
| `ROOT_ROUTER_TOKEN` | `"http.router"` | `Router` | `@mahiframework/http` |
| `URL_GENERATOR_TOKEN` | `"url.generator"` | `UrlGenerator` | `@mahiframework/http` |
| `RATE_LIMITER_TOKEN` | `"rate-limiter"` | `RateLimiter` | `@mahiframework/cache` (re-exported by `@mahiframework/http`) |
| `CONSOLE_KERNEL_TOKEN` | `"console.kernel"` | `ConsoleKernel` | `@mahiframework/cli` |
| `ENCRYPTER_TOKEN` | `"encrypter"` | `Encrypter` | `@mahiframework/encryption` |
| `HASHER_TOKEN` | `"hasher"` | `Hasher` | `@mahiframework/encryption` |
| `SIGNER_TOKEN` | `"signer"` | `Signer` | `@mahiframework/encryption` |
| `MAIL_TOKEN` | `"mail"` | `MailManager` | `@mahiframework/mail` |
| `NOTIFICATIONS_TOKEN` | `"notifications"` | `ChannelManager` | `@mahiframework/notifications` |
| `SCHEDULE_TOKEN` | `"schedule"` | `Schedule` | `@mahiframework/schedule` |
| `JOB_REGISTRY_TOKEN` | `"queue.jobs"` | `JobRegistry` | `@mahiframework/queue` |
| `REDIS_TOKEN` | `"redis"` | `RedisManager` | `@mahiframework/redis` |
| `SNOWFLAKE_TOKEN` | `"snowflake"` | `SnowflakeGenerator` | `@mahiframework/snowflake` |

The base app also binds `"env"`, the validated environment object, via
`app.instance("env", env)` in `bin/bootstrap.ts`. That is an application
convention, not a framework token, but framework code that needs
`APP_KEY` (`EncryptionServiceProvider`) resolves it by that name.

## Why no auto-wiring

There is no `reflect-metadata`, no `@Injectable`, no constructor
parameter inspection, and no contextual binding
(`when()->needs()->give()`).

A container that auto-wires has to answer "what does this constructor
parameter mean?" from type metadata. In TypeScript that means
`emitDecoratorMetadata`, which means the decorator transform, which means
your build tool has to emit metadata, and esbuild, swc, and tsup all
have different levels of support and different gaps. The framework would
be betting its core resolution mechanism on a compiler feature that
doesn't survive most bundlers.

The consequence of not auto-wiring is that a factory says out loud what it
needs:

```ts
this.app.singleton(RATE_LIMITER_TOKEN, (app) => {
  const manager = app.make<CacheManager>(CACHE_TOKEN);
  return new RateLimiter(manager.store());
});
```

You can read that. You can follow `CACHE_TOKEN` to its declaration. The
type checker verifies `manager.store()` returns something `RateLimiter`
accepts. None of that is true of an auto-wired constructor, where the
wiring exists only at runtime and the failure mode is an unhelpful error
during boot.

Contextual binding is absent for the same reason. If one consumer needs a
different implementation, bind a second distinct token and have that
consumer resolve it. Two tokens is more code than a `when()` clause and
considerably more obvious.

## The Manager pattern

Most framework services aren't one object, they're "one of several named
drivers, chosen by config". `Manager<TDriver>` is the shared base for
that: `DatabaseManager`, `CacheManager`, `QueueManager`, `LogManager`,
`StorageManager`, `MailManager`, `BroadcastManager`, `AuthManager`,
`RedisManager`, `ChannelManager`.

```ts
export abstract class Manager<TDriver = unknown> {
  constructor(protected app: Application) {}
  abstract getDefaultDriver(): string;
  extend(name: string, factory: DriverFactory<TDriver>): this;
  driver(name?: string): TDriver;
  isResolved(name: string): boolean;
  resolvedDriverNames(): string[];
  forget(name: string): Promise<boolean>;
}
```

| Member | Purpose |
|---|---|
| `getDefaultDriver()` | Abstract. Which driver `driver()` resolves with no argument. Usually `this.config.default`. |
| `extend(name, factory)` | Register a driver factory. Returns `this`. Re-registering invalidates any cached instance. |
| `driver(name?)` | Resolve and cache a driver. Throws `DriverNotRegisteredError` if the name is unknown. |
| `isResolved(name)` | Has this name already been resolved (and therefore cached)? |
| `resolvedDriverNames()` | Every name resolved so far. |
| `forget(name)` | Disconnect the resolved driver and unregister the name. `true` if anything was dropped. |

`forget()` is for a driver whose name goes away entirely, a disk built
from a database row that has since been deleted. `extend()` already
invalidates a cached instance, so re-registering is enough to *replace* a
driver; `forget()` is what closes one. Without it the only thing that
ever calls `disconnect()` is `disconnectAll()` at shutdown, so dropping a
connected driver any other way leaks its socket. Like
`disconnectAll()`, it never resolves a registered-but-unused driver just
to tear it down. Unlike it, a failing `disconnect()` propagates, since the
caller asked about one driver and is in a position to handle the answer.

`DriverFactory<TDriver>` is `(app: Application) => TDriver`.

There is a *default* driver, not an *only* driver. Several drivers can be
resolved and live side by side, the default SQLite connection plus a
named analytics connection, the `array` cache plus an explicitly named
`redis` store. Each is cached independently under its own name.

Subclasses typically add a domain-flavoured alias for `driver()` and a
config accessor:

```ts
export class DatabaseManager extends Manager<DatabaseDriver> {
  getDefaultDriver(): string {
    return this.config.default;
  }

  connection(name?: string): DatabaseDriver {
    return this.driver(name);
  }

  connectionConfig(name: string): unknown {
    return this.config.connections[name];
  }
}
```

`CacheManager` calls it `store()`, `LogManager` calls it `channel()`,
`QueueManager` and `BroadcastManager` call it `connection()`. They are all
the same method.

### Registration is always explicit

There is no `create{Name}Driver` string-to-method dispatch. A manager's
own provider registers its built-in drivers through `extend()`, using
exactly the same call a third-party plugin would:

```ts
manager.extend("sqlite", () => {
  const sqliteConfig = manager.connectionConfig("sqlite") as ConstructorParameters<typeof SqliteDriver>[0];
  return new SqliteDriver(sqliteConfig);
});
```

Which means adding a driver from outside the framework has no second-class
path. `RedisServiceProvider` adds a `redis` driver to three managers it
doesn't own, from its own `register()`:

```ts
private extendCache(): void {
  if (!this.app.has(CACHE_TOKEN)) return;

  const cache = this.app.make<CacheManager>(CACHE_TOKEN);
  cache.extend("redis", (app) => {
    const config = (cache.storeConfig("redis") ?? {}) as RedisCacheStoreConfig;
    const redis = app.make<RedisManager>(REDIS_TOKEN);
    return new RedisCacheStore(redis.connection(config.connection), config.keyPrefix ?? "");
  });
}
```

Nothing about that is privileged. It is the same `extend()` the built-ins
use, guarded by `has()` so the package works whether or not you installed
`@mahiframework/cache`.

### Why driver() is synchronous

`driver()` returns `TDriver`, never `Promise<TDriver>`. This is a
deliberate constraint and it propagates everywhere: `DB.table()`,
`Cache.get()`, `Storage.disk()` are all reachable without awaiting a
resolution step first.

It works because constructing a driver *handle* is cheap. `new
Kysely({ dialect })` doesn't touch the disk. `new Redis(config)` returns
immediately and connects in the background. The actual I/O happens
per-call, lazily, and is awaited there, which you were going to await
anyway.

Drivers that genuinely need async warm-up implement `Connectable`:

```ts
export interface Connectable {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
```

The manager never calls these. The driver's **owning provider** does, from
its own `boot()`. Which is already async:

```ts
async boot(): Promise<void> {
  const manager = this.app.make<DatabaseManager>(DATABASE_TOKEN);
  const driver = manager.driver();

  if (isConnectable(driver)) {
    await driver.connect();
  }
}
```

`isConnectable(value)` is exported from `@mahiframework/core` and is a plain
duck-type check for both methods. The pattern is: resolution stays sync,
connection is an explicit lifecycle step owned by a provider. See
[Application lifecycle](../lifecycle/) for where `boot()` sits.

`DriverNotRegisteredError` names both sides so the message is actionable:

```
Driver "postgres" is not registered on DatabaseManager.
```

## The app() global

```ts
import { app } from "@mahiframework/core";

const cache = app().make<CacheManager>(CACHE_TOKEN);
```

`app()` returns the current `Application`. `Application.bootstrap()` calls
`setCurrentApp(this)` as its final step, so the global is populated the
moment bootstrap resolves, and not before. Calling `app()` earlier throws
with a message telling you so.

Prefer injection. Providers, commands, seeders, and models already receive
`app`; use it. `app()` exists for the cases where threading it through is
genuinely impractical, an ad-hoc script, a deeply nested pure helper.

**The test caveat.** Only one `Application` can be "current" at a time,
and it's whichever one bootstrapped last. A test suite that constructs an
isolated `Application` per file will find `app()` pointing at some other
file's app, depending on execution order. Two options:

- Resolve off the test's own instance: `testApp.app.make(TOKEN)`. This is
  the right answer nearly always.
- Manage the global yourself with `setCurrentApp()` / `clearCurrentApp()`
  around each test.

The same caveat applies to every facade, since facades are built on
`app()`.

## Facades

`@mahiframework/facades` exports a single function:

```ts
export function Facade<T>(getFacadeKey: () => string) {
  return class {
    static instance(): T {
      return this.swapped ?? app().make<T>(getFacadeKey());
    }

    static swap<S extends Partial<T>>(fake: S): S;
    static restore(): void;
    static isSwapped(): boolean;
  };
}
```

A concrete facade extends the class it returns and writes out its own
static methods by hand:

```ts
export class Events extends Facade<EventDispatcher>(() => EVENTS_TOKEN) {
  static dispatch<E extends AbstractEvent>(event: E): Promise<void> {
    return this.instance().dispatch(event);
  }
}

await Events.dispatch(new PostCreated(post));
```

The framework ships `DB`, `Schema`, `Cache`, `Auth`, `Gate`, `Events`,
`Bus`, `Mail`, `Notifications`, `Crypt`, `Hash`, `Route`, `URL`, and
`Log`.

### Swapping a facade in tests

`swap()` replaces what `instance()` returns until `restore()`:

```ts
Cache.swap({ get: async () => "canned" });

// ...the code under test calls Cache.get()

Cache.restore();
```

It takes a **partial**, since a test usually cares about one or two
methods. Anything the double omits is simply absent, so calling it throws
a normal `TypeError` rather than silently returning `undefined`.

> **A swap is not a container rebinding, and that is the point.** The
> double lives on the facade class, so `app().make(TOKEN)` still returns
> the real service. Code that resolves the dependency directly,
> constructor injection, a provider, another service, is unaffected.
> Rebinding the token instead would mean a swap intended to intercept
> `Cache.get()` silently changed unrelated call paths.
>
> The flip side: if the code under test resolves from the container rather
> than through the facade, `swap()` will not intercept it. Bind a fake on
> the test's own `Application` for that.

`restore()` in an `afterEach`. The double is static, so it outlives the
test that set it otherwise. Facades built from the same `Facade()` base
stay isolated from one another, since the assignment creates an own
property on each subclass.

### Why a mixin factory and not `abstract class Facade<T>`

The obvious design is:

```ts
abstract class Facade<T> {
  static instance(): T { ... }   // error TS2302
}
```

TypeScript rejects this: **"Static members cannot reference class type
parameters."** A generic class's static side has no access to that class's
own type parameters. There is one static side shared by every
instantiation, so `T` is meaningless there. The rule also holds for a base
class's statics as seen through a subclass, so `class Events extends
Facade<EventDispatcher>` can't inherit a working generic
`static instance(): T` either.

Calling `Facade<T>(...)` as a *function* sidesteps it entirely. The
returned class is ordinary and non-generic, with `T` already substituted
into `instance()`'s return type at the call site. The cost is that the
token must be passed as an argument to `Facade<T>(...)` rather than
overridden as a static method on the subclass, which the same TS rule
would also have disallowed.

### Why this is not a dynamic proxy

Laravel's `Facade` forwards arbitrary method names through
`__callStatic`. That is exactly what Mahi's [design
principles](../README.md#design-principles) rule out, and this isn't a
reversal of it:

- Each facade proxies **one fixed token**, chosen once at the `extends`
  call site. No computed tokens, no resolving one service to discover the
  name of another.
- Every method is **hand-written** with a real signature. There is no
  `Proxy`, no reflection, no forwarding.
- Renaming a method on the underlying service is a **compile error** in
  the facade's own body, at `this.instance().thatMethod(...)`.
- Calling a method the facade never declared (`Events.notAMethod()`) is
  also a compile error. With dynamic forwarding, a typo compiles and fails
  at runtime.
- `Facade()` **binds nothing**. The token must already be bound by the
  owning provider, or `instance()` throws `BindingNotFoundError`.
- `instance()` **re-resolves every call**. Caching is the container's job,
  decided by `bind()` vs `singleton()`.

`Log` is hand-written directly against `app()` rather than built on
`Facade<T>`, because `@mahiframework/facades` depends on `@mahiframework/core` and
`LOG_TOKEN`/`LogManager` live in core, importing `Facade` there would
close a package cycle. Its `instance()` is otherwise identical to what
`Facade<LogManager>(() => LOG_TOKEN)` would produce.

## Gotchas

**Re-binding clears the cached instance.** `bind()` and `singleton()`
both `delete` any cached instance for the token. Overriding a framework
binding after bootstrap works, but anything already holding a reference to
the old value keeps it. `app.instance(TOKEN, replacement)` is the usual
way to swap a singleton in tests. That's what
`createTestApplication({ fakeEvents: true })` does for `EVENTS_TOKEN`.

**`extend()` on an unbound token is silent.** No error, ever. A typo'd
token means an extender that never fires and no diagnostic. Import the
token constant instead of typing the string.

**A cached instance skips extenders.** Because step 1 of `make()` returns
early. `extend()` compensates by rewriting the cached value immediately,
but if you're writing your own resolution logic on top of the container,
that ordering matters.

**Manager caches are separate from container caches.** `Manager.driver()`
has its own `resolved` map. Re-binding the manager's container token gets
you a fresh manager with an empty driver cache; calling
`manager.extend(name, ...)` for an already-resolved name does *not* evict
the cached driver. `QueueManager.swap()` exists precisely because there
was no other way to force a resolved driver to change (it writes straight
into `resolved`) and is documented as test-only.

## Related

- [Service providers](../providers/): where bindings are registered
- [Application lifecycle](../lifecycle/): when `register()` and `boot()` run
- [Configuration](../configuration/): what factories read to build drivers
- [Testing](../testing/): swapping bindings in a test application
