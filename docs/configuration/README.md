# Configuration

Configuration is a dot-notation store on the `Application`, populated from
plain TypeScript functions in `config/`, which read a validated
environment object. There is no config caching step, no `.php`-style
array files, and no magic discovery, `bin/bootstrap.ts` calls
`app.config.set()` once per namespace and that is the whole mechanism.

```ts
app.config.get<string>("database.default");           // "sqlite"
app.config.get("cache.stores.file.path");             // "storage/cache"
app.config.get<number>("http.port", 8000);            // with a fallback
```

## ConfigRepository

`app.config` is a `ConfigRepository`, created as a `readonly` field on the
`Application` and available before any provider runs.

| Method | Behaviour |
|---|---|
| `set(key, value)` | Dot-notation write. `set("app.debug", true)` writes the nested value; a single segment replaces that namespace outright. |
| `merge(namespace, values)` | **Deeply** merges into the namespace. Later merges win on conflicting leaves. |
| `get<T>(key, fallback?)` | Dot-notation read. Returns `fallback` (default `undefined`) if any segment is missing. Returns a deep clone of object values. |
| `has(key)` | Whether a dot-notation key exists (even when its value is `null`). |
| `push(key, value)` / `prepend(key, value)` | Append/prepend to the array at `key`, creating it if absent. |
| `all()` | A deep clone of the whole store, mutating it never mutates the repository. |

`set()` understands dot notation: `set("database.default", "sqlite")` writes
the nested `{ database: { default: "sqlite" } }`, creating intermediate
objects as needed. A single-segment key (`set("database", {...})`) replaces
that namespace outright. `merge()` still takes a **top-level namespace name**
as its first argument.

### get() and dot notation

`get()` delegates to `data_get`, so the full path syntax applies,
including wildcards:

```ts
config.get("database.connections.sqlite.filename");
config.get<string[]>("logging.channels.stack.channels");
```

A missing segment anywhere in the path returns the fallback rather than
throwing:

```ts
config.get<HasherOptions>("hashing", {});   // base app ships no hashing config
```

That is `EncryptionServiceProvider`'s actual call. The `hashing`
namespace is optional, and an absent one yields `{}` so argon2 uses its
own defaults.

### merge vs set

The merge is **deep for plain objects and replace-wholesale for
everything else**. Arrays are values, not containers to be concatenated:

```ts
config.set("cache", { default: "array", stores: { array: {}, file: { path: "a.json" } } });
config.merge("cache", { stores: { file: { path: "b.json" }, redis: {} } });

config.get("cache.default");           // "array"          — untouched
config.get("cache.stores.array");      // {}               — untouched
config.get("cache.stores.file.path");  // "b.json"         — leaf replaced
config.get("cache.stores.redis");      // {}               — added
```

```ts
config.set("logging", { channels: { stack: { driver: "stack", channels: ["console", "single"] } } });
config.merge("logging", { channels: { stack: { channels: ["daily"] } } });

config.get("logging.channels.stack.channels");   // ["daily"] — NOT ["console","single","daily"]
```

`set()` does no merging at all. It overwrites the namespace outright,
including keys the new value doesn't mention.

### The convention

**The application uses `set()` at bootstrap. Packages use `merge()` in
`register()`.**

```ts
// bin/bootstrap.ts — the app declares the truth
app.config.set("database", databaseConfig(env));
app.config.set("cache", cacheConfig());
```

```ts
// a package contributes defaults under whatever the app decided
export class BillingServiceProvider extends ServiceProvider {
  register(): void {
    this.app.config.merge("billing", {
      default: "stripe",
      drivers: { stripe: { apiVersion: "2024-06-20" } },
    });
  }
}
```

The ordering makes this work: the app's `set()` calls all run in
`bootstrap.ts` *before* `app.bootstrap()`, so by the time any
`register()` executes, the app's values are already in place. A deep
`merge()` then fills in keys the app didn't specify without clobbering the
ones it did.

A provider whose config is an all-or-nothing structure, rather than a set
of independent leaves, uses a third variant: a presence check, then
`set()`, so a partial app-supplied value is never half-merged with
defaults:

```ts
if (this.app.config.get("media") === undefined) {
  this.app.config.set("media", defaultMediaConfig());
}
```

## Environment variables

`loadEnv()` loads `.env` and validates `process.env` against a Zod schema.

```ts
export function loadEnv<TSchema extends z.ZodTypeAny>(
  options: { schema: TSchema; path?: string },
): z.infer<TSchema>;
```

```ts
const env = loadEnv({ schema: envSchema });
```

What it does, in order:

1. If the file at `path` (default `".env"`, relative to the current
   working directory) **exists**, load it via dotenv. A missing `.env` is
   **not an error**, production deployments usually inject real
   environment variables instead.
2. `safeParse` the whole of `process.env` against the schema.
3. On failure, throw an `Error` listing **every** issue at once:

```
Invalid environment configuration:
  - APP_KEY: Required
  - PORT: Expected number, received nan
```

4. On success, return `result.data`.

Two properties of step 4 matter. The return is the **parsed** data, not
`process.env`, so `z.coerce.number()` gives you an actual `number`, and
`.default(...)` fills in values that were never set. And it is **typed**:
`z.infer<typeof envSchema>`, so `env.PORT` is `number` and `env.APP_KEY`
is `string | undefined`.

Fail-fast is the point. A missing variable becomes a boot-time error
naming the variable, rather than an `undefined` surfacing inside a request
three weeks later.

### The environment schema

`config/env.ts` in the base app:

```ts
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8000),
  APP_URL: z.string().default("http://localhost:8000"),

  DB_FILENAME: z.string().default("database/database.sqlite"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  APP_KEY: z.string().optional(),
  APP_PREVIOUS_KEYS: z.string().optional(),

  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  MAIL_MAILER: z.string().default("log"),
  MAIL_FROM_ADDRESS: z.string().default("hello@example.com"),
  MAIL_FROM_NAME: z.string().default("Mahi"),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // ...
});

export type Env = z.infer<typeof envSchema>;
```

Add your own keys here as the app grows. A key that isn't in the schema
isn't on the typed `Env` object. Which is the point. There is no
`env("SOME_VAR")` helper that reads arbitrary strings; if you want it,
declare it.

`APP_KEY` is `.optional()` rather than `.default(...)` on purpose: a
missing key should fail loudly inside `EncryptionServiceProvider` with an
actionable message, not silently encrypt everything under a fixed known
key.

`env` is bound into the container so providers can reach it:

```ts
app.instance("env", env);
```

```ts
const env = app.make<EncryptionEnv>("env");
```

## Config files

Each file exports a function returning a typed config object, most taking
`env`. `bin/bootstrap.ts` calls them all:

```ts
app.config.set("database", databaseConfig(env));
app.config.set("http", httpConfig(env));
app.config.set("cache", cacheConfig());
app.config.set("storage", storageConfig());
app.config.set("logging", loggingConfig());
app.config.set("queue", queueConfig());
app.config.set("schedule", scheduleConfig());
app.config.set("auth", authConfig(env));
app.config.set("broadcasting", broadcastingConfig());
app.config.set("redis", redisConfig(env));
app.config.set("mail", mailConfig(env));
```

They're regular TypeScript, type-checked against the interface each
package exports. A typo in a key is a compile error.

### config/app.ts

The odd one out. It exports a provider **list**, not a config object, and
is never passed to `config.set()`:

```ts
export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  // ...
  AppServiceProvider,
];
```

Order is significant. See [Service
providers](../providers/#provider-ordering) for every constraint and why
it exists.

### config/env.ts

The Zod schema above. Also exports `type Env`, which every other config
file imports for its parameter type.

### config/database.ts

```ts
// Relative to THIS file so a compiled `dist/bin/console.js migrate` finds
// `dist/database/migrations/*.js` — see Deployment.
const migrationsPath = path.join(import.meta.dirname, "..", "database", "migrations");

export function databaseConfig(env: Env): DatabaseConfig & { migrationsPath: string } {
  return {
    default: "sqlite",
    migrationsPath,
    connections: {
      sqlite: { filename: env.DB_FILENAME },
    },
  };
}
```

| Key | Meaning |
|---|---|
| `default` | Connection `DatabaseManager.connection()` resolves with no argument. |
| `connections` | Named connection configs. The key is the driver name registered via `extend()`. |
| `migrationsPath` | Where `./artisan migrate` looks for **your** migrations. Resolved relative to the running file so it points at compiled `.js` under `dist/`. |

`migrationsPath` covers your app's migrations only. Framework tables,
`personal_access_tokens`, `sessions`, `jobs`, `failed_jobs`,
`notifications`, come from their packages' `migrations()` provider hooks
and are picked up automatically. Don't list them.

See [Database](../database/) and [Migrations](../migrations/).

### config/http.ts

```ts
export function httpConfig(env: Env): HttpConfig {
  return {
    url: env.APP_URL,
    cors: {
      origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    },
  };
}
```

| Key | Meaning |
|---|---|
| `url` | Canonical root URL. Used by the URL generator when there's no in-flight request to borrow a host from, queue jobs, CLI, scheduled tasks. A live request's own scheme/host wins over this. |
| `cors` | If set, `hono/cors` is installed on every route. **Omit it and there is no CORS at all**. It's opt-in. |
| `liveness` | If set, registers a zero-I/O liveness route (default `GET /up`) returning `200 {"status":"ok"}`, exempt from maintenance mode. `{}` is enough. Formerly `health`, which is still read as a fallback. |
| `healthCheck` | If set, registers a readiness route (default `GET /health`) that runs every registered check and returns `200`/`503`. Requires `@mahiframework/health`. Takes `path`, `failureStatus`, and `secret`. **Not** maintenance-exempt. |

`CORS_ORIGIN` is comma-separated, which is why the config splits it. The
whole `http` namespace is optional; `HttpKernel` applies nothing it
doesn't find.

### config/cache.ts

```ts
export function cacheConfig(): CacheConfig {
  return {
    default: "array",
    stores: {
      array: {},
      file: { path: "storage/cache" },
      redis: {},
    },
  };
}
```

`default` is `"array"`, in-process, per-process, gone on restart. Correct
for a single process and for tests.

`file` keeps one file per key under `path`, which is a **directory**, not
a file. It survives restarts and is safe for several processes on one host
to share.

`redis` needs `RedisServiceProvider` registered; an empty `{}` means "use
the `default` Redis connection from `config/redis.ts`, under the `cache:`
namespace". Point `default` here when you run more than one host. A store
listed here but never resolved costs nothing.

The rate limiter behind `throttle()` uses the **default** store, so this
key decides whether rate limits are shared across your processes. See
[Cache](../cache/).

### config/queue.ts

```ts
export function queueConfig(): QueueConfig {
  return {
    default: "sync",
    connections: {
      sync: {},
      database: { queue: "default", retryAfter: 90, afterCommit: true },
      redis: { queue: "default", retryAfter: 90 },
    },
  };
}
```

`sync` runs jobs inline at dispatch, no worker, no async, exceptions
propagate to the caller. `database` persists to the `jobs` table;
`redis` buys throughput over it, and brings cross-process locks that the
array/file cache stores can't provide.

`retryAfter` (seconds) is the visibility timeout: how long a reserved job
may be held before another worker assumes its holder died and takes it.
**It must exceed the longest a job can run**, or a slow job gets a second
worker. `afterCommit` holds every dispatch on that connection until the
enclosing `DB.transaction()` commits, recommended, since it removes the
"worker popped the job before the row it references was committed" race.
`queue` is the default named queue for the connection.

`QueueServiceProvider` also registers a `fake` connection out of the box,
for tests. See [Queues](../queues/).

### config/auth.ts

```ts
export function authConfig(env: Env): AuthConfig {
  return {
    default: "token",
    guards: {
      token: { provider: "users", expiresInMinutes: null },
      session: {
        provider: "users",
        store: "database",
        cookie: "session",
        lifetimeMinutes: 120,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
        path: "/",
      },
    },
    providers: {
      users: {
        driver: "database",
        model: User,
        identifierColumn: "email",
        passwordColumn: "password",
      },
    },
  };
}
```

Which guard to use is topology-dependent, not a preference:

- **`token`**: bearer tokens in an `Authorization` header. Correct for a
  detached frontend on another origin, and for third-party API consumers.
  Needs no CSRF protection, because browsers never attach an
  `Authorization` header automatically. `expiresInMinutes: null` means
  never expires (matching Sanctum); the `expires_at` column already
  exists, so switching to a finite lifetime is a config change and nothing
  more.
- **`session`**, signed cookie plus a server-side session. Correct when
  the frontend is served from the **same origin** as the API. Cross-origin
  cookies require `sameSite: "None"` **and** `secure: true`, and `secure`
  means they will not work over plain HTTP, so a cross-origin SPA in
  local development silently gets no session at all. That's a browser
  rule, not a framework limitation. Pair this guard with `csrf()`.

`providers.users` describes how to find a user: which `Model`, which
column holds the identifier, which holds the password hash.
`identifierColumn` defaults to `"email"` if omitted.

Note `model: User` is a real class reference, not a string, config files
are TypeScript. See [Authentication](../authentication/).

There is no `config/authorization.ts`. A gate has no drivers, no
connections, and no defaults; its absence is intentional.

### config/storage.ts

```ts
export function storageConfig(): StorageConfig {
  return {
    default: "public",
    disks: {
      local: { root: storage_path("app/private") },
      public: { root: storage_path("app/public"), url: "/storage" },
    },
  };
}
```

Disk names are the `extend()` keys. `root` is an absolute filesystem path;
`url` is the public prefix `Storage.url(path)` builds against. A disk
without a `url` isn't publicly addressable. That's the whole difference
between `local` and `public` here. See [Storage](../storage/).

### config/logging.ts

```ts
export function loggingConfig(): LogConfig {
  return {
    default: "stack",
    channels: {
      console: { driver: "console" },
      single: { driver: "single", path: storage_path("logs/mahi.log") },
      daily: { driver: "daily", path: storage_path("logs/mahi.log"), maxFiles: 14 },
      array: { driver: "array" },
      null: { driver: "null" },
      stack: { driver: "stack", channels: ["console", "single"] },
    },
    emergency: { path: storage_path("logs/mahi.log") },
  };
}
```

`LogChannelConfig` is a discriminated union on `driver`, so each channel
is checked against the right shape, `single` requires a `path`, `stack`
requires `channels`.

| Driver | Behaviour |
|---|---|
| `console` | stdout/stderr |
| `single` | One fixed file |
| `daily` | Rotates to a dated file; `maxFiles` prunes old ones |
| `array` | In memory: for tests |
| `null` | Discards everything |
| `stack` | Fans out to other named channels |

`emergency` is the fallback used when resolving a channel *throws*, an
unregistered driver, bad config, an unwritable log directory. Defaults to
`storage_path("logs/mahi.log")` if omitted.

This namespace configures the `LogManager` at `LOG_TOKEN`, which is opt-in
via `LoggingServiceProvider`. It does not configure `app.logger`, the
always-available `ConsoleLogger` fallback. See [Logging](../logging/).

### config/mail.ts

```ts
export function mailConfig(env: Env): MailConfig {
  return {
    default: env.MAIL_MAILER,
    from: { address: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME },
    mailers: {
      log: {},
      array: {},
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined,
        pool: true,
      },
    },
  };
}
```

`default` is `"log"` (via `MAIL_MAILER`), so local development and tests
never open an SMTP connection. The log mailer writes the rendered message
through `app.logger`. Set `MAIL_MAILER=smtp` in production, or `"array"`
in tests to capture messages in memory.

`from` is the process-wide default sender, applied to any Mailable that
doesn't set its own `from()`. See [Mail](../mail/).

### config/redis.ts

```ts
export function redisConfig(env: Env): RedisConfig {
  return {
    default: "default",
    connections: {
      default: {
        url: env.REDIS_URL,
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        password: env.REDIS_PASSWORD,
        keyPrefix: "mahi:",
      },
    },
  };
}
```

One connection is shared by the `redis` cache store, queue connection, and
broadcast driver. Declaring it costs nothing until something actually
resolves a `redis` driver, `RedisServiceProvider.boot()` checks whether
`cache.default`, `queue.default`, or `broadcasting.default` is `"redis"`
before opening a socket, specifically so short-lived CLI processes still
exit.

`keyPrefix` matters on a shared Redis: `RedisCacheStore.flush()` only
clears keys under this prefix, so it can't wipe a co-tenant's data. See
[Redis](../redis/).

### config/broadcasting.ts

```ts
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

The `local` driver runs the websocket server inside this Node process and
keeps its subscription table in that process's memory. Correct for a
single-process deployment and **silently lossy** for any other: with two
or more processes, a broadcast from one never reaches clients connected to
another. No error, no warning. The message just doesn't arrive.

Switch `default` to `"redis"` (or register a Pusher/Ably driver via
`BroadcastManager.extend()`) before scaling horizontally. The websocket
endpoint path stays the same. See [Broadcasting](../broadcasting/).

### config/schedule.ts

```ts
export interface ScheduleConfig {
  lockDirectory: string;
  lockStore?: string;
  pingTimeoutMs?: number;
}

export function scheduleConfig(): ScheduleConfig {
  return {
    lockDirectory: "storage/schedule-locks",
    // lockStore: "redis",
    pingTimeoutMs: 5_000,
  };
}
```

| Key | Default | Purpose |
|---|---|---|
| `lockDirectory` | `"storage/schedule-locks"` | Where `withoutOverlapping()` writes its lock files. |
| `lockStore` |: | Cache store to hold overlap locks in instead, so they span hosts. |
| `pingTimeoutMs` | `5000` | Timeout for `pingBefore()`/`thenPing()`/… webhooks. |

Every key is read with a default, so the whole namespace is optional. The
interface is declared in the app rather than exported by `@mahiframework/schedule`.
See [Scheduling](../scheduling/).

### config/health.ts

```ts
export function healthConfig(): HealthConfig {
  return { timeoutSeconds: 5, concurrency: 1 };
}
```

| Key | Meaning |
|---|---|
| `timeoutSeconds` | Default per-check deadline. Defaults to `5`; a check can override it. |
| `concurrency` | How many checks run at once. Defaults to `1` (sequential), parallel probing bursts connections at a dependency that is already suspected of being unwell. |

Entirely optional; read with a `?? {}` fallback, so an app that never sets
the namespace gets both defaults. The endpoint's own settings live under
`http.healthCheck`, not here. See [Health checks](../health/).


## Path helpers

Four functions, exported from `@mahiframework/core`:

| Helper | Resolves to |
|---|---|
| `base_path(...segments)` | the app root (`process.cwd()` by default) + segments |
| `storage_path(...segments)` | `base_path("storage", ...segments)` |
| `resource_path(...segments)` | `base_path("resources", ...segments)` |
| `database_path(...segments)` | `base_path("database", ...segments)` |

**That's the complete list.** There is no `app_path()`, no
`config_path()`, no `public_path()`. Laravel has them; Mahi doesn't,
because a Mahi app's `src/` layout is not prescribed, config is imported
by module path rather than looked up on disk, and static file serving goes
through a storage disk with a `url`.

```ts
base_path()                              // "/srv/my-app"
base_path("config")                      // "/srv/my-app/config"
storage_path("logs/mahi.log")            // "/srv/my-app/storage/logs/mahi.log"
database_path("migrations")              // "/srv/my-app/database/migrations"
```

**`null` and `undefined` segments are stripped**, so conditional segments
can be passed inline:

```ts
base_path("storage", isProd && "cache");   // drops the false-y segment
storage_path("app", null, "public");       // "<cwd>/storage/app/public"
```

### Why process.cwd() and not the Application

The helpers resolve against `process.cwd()`, deliberately, not against
any state on an `Application` instance.

Config files call these helpers **while building the config** that gets
handed to `app.config.set(...)`. That happens before `app.bootstrap()`
runs and long before the `app()` global is populated:

```ts
export function storageConfig(): StorageConfig {
  return {
    default: "public",
    disks: {
      local: { root: storage_path("app/private") },   // no Application exists yet
      public: { root: storage_path("app/public"), url: "/storage" },
    },
  };
}
```

If these were methods on `Application`, every config file would need an
app instance it can't have, and you'd get a bootstrap-ordering trap in
exchange for nothing. Tying them to cwd makes them usable at any point in
the boot sequence.

The practical consequence: **paths depend on where you run the process
from.** `./artisan` handles this by `cd`-ing to its own directory first;
`bin/server.ts` assumes you launched it from the app root. If a
production supervisor starts your app from `/`, every path helper resolves
against `/`. Set the working directory in your process manager. See
[Deployment](../deployment/).

### setBasePath(): for apps that aren't run from their own directory

Some apps have no meaningful cwd. A CLI installed on `PATH`, or compiled
to a single-file binary, gets run from wherever the user happens to be,
so `database_path()` resolving to `~/Downloads/database` is not just
wrong, it is *silently* wrong: a relative sqlite `filename` under it
creates a fresh, empty database rather than failing.

Such an app pins its own root instead:

```ts
import { setBasePath, base_path, loadEnv } from "@mahiframework/core";

export async function bootstrap(): Promise<Application> {
  setBasePath(resolveMyAppHome());        // e.g. ~/.config/myapp — FIRST statement
  const env = loadEnv({ schema: envSchema, path: base_path(".env") });
  // ...
}
```

Everything else follows without being told, because the other three
helpers already delegate to `base_path()`:

| Helper | Resolves to |
|---|---|
| `base_path()` | `~/.config/myapp` |
| `storage_path("logs/app.log")` | `~/.config/myapp/storage/logs/app.log` |
| `database_path("app.sqlite")` | `~/.config/myapp/database/app.sqlite` |

**Ordering is the only way this goes wrong.** It must be the first
statement of `bootstrap()`, before `loadEnv()` and before any
`config/*.ts` function runs, since those call `storage_path()` while
building the config object. A path helper called before `setBasePath()`
silently uses cwd.

It stays a module-level setter, not `Application` state, for exactly the
reason above: config functions run before an `Application` exists.

Two companions, both mainly for tests and diagnostics:

- `resolvedBasePath()`: the root currently in effect, so a `doctor`-style
  command can report which root it picked.
- `clearBasePath()`: restores the `process.cwd()` default. A module-level
  root would otherwise leak between test files sharing a module registry.

**Project-style apps should not call this at all.** Leave it unset and
every helper behaves exactly as documented above; `./artisan`'s `cd` is
already the right answer.

## Gotchas

**`set()` and `merge()` take a namespace, not a path.**
`config.set("database.default", "sqlite")` silently creates a useless
top-level key named `"database.default"`. Only `get()` splits on dots.

**`merge()` replaces arrays wholesale.** Merging
`{ channels: ["daily"] }` over `{ channels: ["console", "single"] }` gives
`["daily"]`. If you want to add to a list, read it, concatenate, and set
it back.

**A missing `.env` is not an error.** `loadEnv()` skips loading when the
file doesn't exist and validates `process.env` as-is. That's correct for
production, and it means a locally missing `.env` fails later, at schema
validation, on whichever required key you didn't set.

**`loadEnv()` returns parsed data, not `process.env`.** Use the returned
object. Reading `process.env.PORT` afterwards gets you the raw string,
uncoerced, with no defaults applied.

**`Application`'s environment default is `"production"`, the base app's
schema default is `"development"`.** They differ because they're
fail-safes for different situations. `app.useEnvironment(env.NODE_ENV)`
reconciles them, call it. See
[Application lifecycle](../lifecycle/#environment).

**Config must be set before `bootstrap()`.** Providers read config in
`register()` and inside factories resolved during `boot()`. Setting a
namespace afterwards affects only bindings that haven't resolved yet,
which is unpredictable. `createTestApplication`'s `configure` hook
necessarily runs post-bootstrap for this reason and is documented as such.

**Path helpers follow the process's working directory.** They are not
anchored to the app's installed location.

## Related

- [Application lifecycle](../lifecycle/): where config is set, and when
- [Service providers](../providers/): contributing defaults with `merge()`
- [Service container](../container/): how factories read config
- [Installation](../installation/): what the installer writes into `.env`
- [Deployment](../deployment/): environment variables in production
