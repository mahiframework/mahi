# Logging

## Two separate systems

Read this section before anything else. Mahi has **two logging systems**,
and they are not the same logger unless you deliberately configure them
to be.

### 1. `app.logger`: always available, zero config

```ts
readonly logger: Logger = new ConsoleLogger(this);
```

A plain readonly field on `Application`. It exists the moment
`new Application()` returns, before any provider registers, before
`bootstrap()` runs. It is always a `ConsoleLogger`. It reads no config.
It cannot be swapped.

```ts
app.logger.info("Server listening", { port: 8000 });
this.app.logger.error("auth:gc failed", { error: String(error) });
```

This is what the framework itself uses internally, `LogTransport` (the
`log` mailer), `BroadcastServiceProvider`'s failed-broadcast handler,
`auth:gc`, `schedule:work`. None of them can assume anything else exists.

### 2. `LOG_TOKEN` / `LogManager`: opt-in, configurable channels

```ts
import { Log } from "@mahiframework/core";

Log.info("using the default channel");
Log.channel("daily").warning("only goes to the daily-rotated file");
```

This is the channel system: `console`, `single`, `daily`, `array`,
`null`, `stack`, plus anything you `extend()`. It reads
`config/logging.ts`. It writes to files.

**It requires `LoggingServiceProvider`, which is NOT auto-registered.**
Unlike every framework that quietly boots its logger for you, Mahi has no
implicit provider registration anywhere, so an app that wants channels
lists the provider explicitly:

```ts
// config/app.ts
import { LoggingServiceProvider } from "@mahiframework/core";

export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  // ...
  LoggingServiceProvider,
  // ...
];
```

Without it, `LOG_TOKEN` is unbound and `Log.info(...)` throws
`BindingNotFoundError`.

### Why they're separate

Wiring `Application.logger` through the container would create a
bootstrap-ordering hazard for no benefit. Something has to log during
`bootstrap()`, a provider's `register()` failing, a config problem, a
connection that won't open, and that something runs *before*
`LoggingServiceProvider.register()` has necessarily happened. A logger
that might not exist yet is not a logger you can call unconditionally.

So `app.logger` is the floor: always there, never fails, writes to the
console. `LOG_TOKEN` is the ceiling: configurable, file-backed, opt-in.
Framework internals target the floor; application code that wants
channels targets the ceiling.

The practical consequence people trip over:

```ts
app.logger.info("A");           // console, always
Log.info("B");                  // whatever logging.default resolves to — maybe a file
```

**These may go to entirely different places.** If your app logs to
`storage/logs/mahi.log` via a `single` channel and you can't find a
framework message in there, it's because the framework wrote it to
`app.logger`, which is stdout.

If you want them to be the same, make your default channel `console`,
or accept that `app.logger` output belongs to your process supervisor
(systemd, Docker, pm2) rather than to your log files. Most deployments
capture stdout anyway, which is why the split is tolerable in practice.

The rest of this page covers both, with the `Logger` interface first
(shared by both) and then the channel system.

## `LogLevel`

```ts
type LogLevel =
  | "emergency" | "alert" | "critical" | "error"
  | "warning"   | "notice" | "info"    | "debug";
```

The eight PSR-3 / RFC 5424 severities, most severe first. Same set
Laravel exposes one method per.

| Level | Meaning (RFC 5424) |
|---|---|
| `emergency` | System is unusable |
| `alert` | Action must be taken immediately |
| `critical` | Critical conditions |
| `error` | Runtime errors that don't require immediate action |
| `warning` | Exceptional occurrences that aren't errors |
| `notice` | Normal but significant events |
| `info` | Interesting events |
| `debug` | Detailed debug information |

`warning`, not `warn`, is the canonical name. `warn()` survives as a
`@deprecated` alias that forwards to `warning()`, so the historical
four-level API (`debug`/`info`/`warn`/`error`) keeps compiling. New code
should use `warning()`.

**There is no level filtering.** No `logging.level`, no minimum severity,
no per-channel threshold. Every call reaches its destination. If you want
`debug` suppressed in production, either don't call it or point a channel
at the `null` driver.

## The `Logger` interface

```ts
interface Logger {
  emergency(message: string, context?: Record<string, unknown>): void;
  alert(message: string, context?: Record<string, unknown>): void;
  critical(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  warning(message: string, context?: Record<string, unknown>): void;
  notice(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;

  /** @deprecated use warning() */
  warn(message: string, context?: Record<string, unknown>): void;
}
```

Every method is **synchronous and returns `void`**. There is no promise
to await and no way to know a write succeeded. `FileLogger` uses
`appendFileSync` deliberately: making `Logger` async would push `await`
into every call site in the framework and every app, for log writes,
which is not a trade anyone wants. Same "synchronous is fine, I/O is not
the bottleneck here" reasoning as `better-sqlite3` in `@mahiframework/database`.

`log(level, ...)` is for when the level itself is a variable, mapping an
HTTP status class to a severity, say:

```ts
logger.log(status >= 500 ? "error" : "info", `${method} ${path}`, { status });
```

### `AbstractLogger`

```ts
abstract class AbstractLogger implements Logger {
  protected abstract write(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void;
}
```

**Implement one `write()` and you get all ten methods.** Every level
method, plus `log()` and `warn()`, funnels through it. That's the same
shape as Laravel's `Illuminate\Log\Logger` routing everything through one
`writeLog()`, and it's why adding a backend is a ten-line class:

```ts
import { AbstractLogger, type LogLevel } from "@mahiframework/core";

export class SentryLogger extends AbstractLogger {
  constructor(private client: SentryClient) {
    super();
  }

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level === "debug" || level === "info") return;
    this.client.captureMessage(message, { level, extra: context });
  }
}
```

Every logger that ships extends `AbstractLogger`.

## `formatLogLine`

```ts
function formatLogLine(
  level: string,
  message: string,
  context?: Record<string, unknown>,
  source?: LogSource,
): string
```

Exported, not private, specifically so custom loggers can reuse it rather
than reinventing the format. `ConsoleLogger`, `FileLogger` and
`DailyLogger` all call it, so every channel produces visually identical
output.

```
[2026-08-27 09:14:02] production.ERROR: Payment failed {"orderId":"427185966743560456"} {"invocation":"9048372019229466888"}
```

| Part | Source |
|---|---|
| `[2026-08-27 09:14:02]` | `DateTime.now("UTC").format("yyyy-MM-dd HH:mm:ss")` |
| `production` | `source.environment()` |
| `ERROR` | `level.toUpperCase()` |
| `Payment failed` | the message |
| `{"orderId":...}` | the per-call `context` argument |
| `{"invocation":...}` | the global `source.context.all()`, which every entry point seeds with the [invocation id](#invocation-ids) |

**The timestamp is UTC**, always, regardless of the machine's timezone.
Log lines from a fleet of servers in different regions are directly
comparable. (Note the contrast with `DailyLogger`'s rotation, which uses
**local** date. See [below](#daily).)

**The `env.` prefix comes from `source.environment()`.** Laravel's
fallback Monolog channel name is the app environment, which is where
`production.DEBUG` comes from. When no `source` is supplied, a
standalone logger constructed outside any `Application`, the prefix is
omitted entirely and the line is just `ERROR: message`.

**Empty context is omitted, not rendered as `{}`.** Both the per-call
context and the global context are skipped when they have no keys,
matching Monolog's `ignoreEmptyContextAndExtra`. A log line with neither
is just `[ts] env.LEVEL: message`.

**Per-call context renders before global context.** Laravel puts its
`Context` in `%extra%`, which comes after `%context%`; this matches.

### `LogSource`

```ts
interface LogSource {
  environment(): string;
  readonly context: ContextRepository;
}
```

What a logger needs from the outside world. `Application` structurally
satisfies it: it has `environment()` and a `context` field, so loggers
are constructed with the `Application` instance itself:

```ts
new ConsoleLogger(app)
new FileLogger(path, app)
new DailyLogger(path, maxFiles, app)
```

That's explicit injection rather than a hidden `app()` call inside the
formatter, per the framework's DI philosophy. It's also why
`app.logger`'s initializer can pass `this`: the fields it reads
(`environment()`, `context`) are resolved lazily at log time, so even the
zero-config fallback renders full lines.

Both `ArrayLogger` and `NullLogger` take no source, neither formats
anything.

## Channels

Everything from here on requires `LoggingServiceProvider`.

### Configuration

```ts
// config/logging.ts
import { storage_path, type LogConfig } from "@mahiframework/core";

export function loggingConfig(): LogConfig {
  return {
    default: "stack",
    channels: {
      console: { driver: "console" },
      single:  { driver: "single", path: storage_path("logs/mahi.log") },
      daily:   { driver: "daily", path: storage_path("logs/mahi.log"), maxFiles: 14 },
      array:   { driver: "array" },
      null:    { driver: "null" },
      stack:   { driver: "stack", channels: ["console", "single"] },
    },
    emergency: { path: storage_path("logs/mahi.log") },
  };
}
```

```ts
type LogChannelConfig =
  | { driver: "console" }
  | { driver: "single"; path: string }
  | { driver: "daily"; path: string; maxFiles?: number }
  | { driver: "array" }
  | { driver: "null" }
  | { driver: "stack"; channels: string[] };

interface LogConfig {
  default: string;
  channels: Record<string, LogChannelConfig>;
  emergency?: { path: string };
}
```

`LogChannelConfig` is a discriminated union, so the `driver` string
narrows the rest of the object at compile time, a `daily` entry without
a `path` is a type error, not a runtime surprise.

### The drivers

#### `console`

```ts
{ driver: "console" }
```

`new ConsoleLogger(app)`. Routes each level to the closest `console`
method so severity survives into dev tooling:

| Levels | `console` method |
|---|---|
| `emergency`, `alert`, `critical`, `error` | `console.error` |
| `warning`, `notice` | `console.warn` |
| `info` | `console.info` |
| `debug` | `console.debug` |

Same class `app.logger` is.

#### `single`

```ts
{ driver: "single", path: storage_path("logs/mahi.log") }
```

`new FileLogger(path, app)`. Appends formatted lines to one file.
`mkdirSync(dirname(path), { recursive: true })` runs in the **constructor**,
so resolving the channel creates the directory even before the first write.

**`FileLogger` has no rotation.** It appends to one growing file forever.
Not "rotates when large", not "truncates on restart", forever.

That's a deliberate scope decision: real rotation (size thresholds,
compression, retention policy, atomic rename-and-reopen, signalling the
writer) is an operational concern that `logrotate`, Docker's log driver,
or your platform's log shipper already solves better than application
code can. If you want application-level rotation, use the `daily` driver.
If you want `single` and you're on a long-lived box, point `logrotate` at
the file.

#### `daily`

```ts
{ driver: "daily", path: storage_path("logs/mahi.log"), maxFiles: 14 }
```

`new DailyLogger(path, maxFiles, app)`. Rotates to a new
`{base}-{YYYY-MM-DD}{ext}` file each day.

**The configured `path` is a template. Nothing is ever written to it.**

```ts
// withDateSuffix("storage/logs/mahi.log", date) -> "storage/logs/mahi-2026-08-27.log"
```

Configure `storage_path("logs/mahi.log")` and you get
`storage/logs/mahi-2026-08-27.log`, `mahi-2026-08-28.log`, and so on.
`storage/logs/mahi.log` itself stays empty, or, if you also run a
`single` channel at the same path, contains only that channel's output.
The default config does exactly that, which is deliberate but worth
knowing: `single` and `daily` in a generated app are configured with the
*same* `path`, and they write to *different* files.

**Rotation is computed from the current date at write time, not by a
timer.** Every `write()` recomputes `withDateSuffix(this.path, new Date())`:

```ts
protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const resolvedPath = withDateSuffix(this.path, new Date());

  mkdirSync(dirname(resolvedPath), { recursive: true });
  appendFileSync(resolvedPath, formatLogLine(level, message, context, this.source) + "\n");

  if (resolvedPath !== this.lastResolvedPath) {
    this.lastResolvedPath = resolvedPath;
    if (this.maxFiles !== undefined) {
      this.prune();
    }
  }
}
```

There is no `setInterval`, no scheduled job, no persisted state. That
means it works correctly across process restarts (the filename is
derived, not remembered), it never keeps the event loop alive, and a
process that's idle over midnight rotates correctly on its next write
rather than at midnight.

**Pruning only runs when the filename changes.** `lastResolvedPath` is
the guard. A burst of a thousand same-day log calls does one directory
scan at most, the first one, if the day just turned over. The
consequence: a process that starts and only ever logs on one day never
prunes at all, because the filename never changed from what the first
write established.

Pruning keeps the `maxFiles` most recent dated files matching the
template's base and extension, sorted by the date in the filename
descending, and `unlink`s the rest. Failures are swallowed, a file
removed concurrently isn't an error. `maxFiles` omitted means no pruning
ever.

**The rotation date is LOCAL, not UTC.** `formatDate()` uses
`getFullYear()`/`getMonth()`/`getDate()`, which read the process's local
timezone, while `formatLogLine()`'s timestamps are UTC. So on a machine
running `TZ=Asia/Tokyo`, a line stamped `[2026-08-27 16:30:00]` (UTC)
lands in `mahi-2026-08-28.log`, because it's already the 28th locally.

The two are inconsistent, and knowing which is which is the whole
mitigation: **the filename tells you the local day; the timestamps inside
tell you UTC.** If that bothers you, run your servers in UTC. Which is
what you want for a dozen other reasons anyway.

#### `array`

```ts
{ driver: "array" }
```

```ts
class ArrayLogger extends AbstractLogger {
  readonly entries: ArrayLogEntry[] = [];
}

interface ArrayLogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | undefined;
}
```

Collects entries in memory. Nothing is formatted. The entry keeps the
raw level, message and context, so assertions are on structure rather
than on a rendered string. Entries are kept in call order and never
pruned; dies with the process, like `ArrayCacheStore`.

The test driver. See [Testing](#testing).

#### `null`

```ts
{ driver: "null" }
```

Discards everything. Useful for silencing a channel without special-casing
call sites that call `logger.debug(...)` unconditionally.

#### `stack`

```ts
{ driver: "stack", channels: ["console", "single"] }
```

```ts
class StackLogger extends AbstractLogger {
  constructor(private loggers: Logger[]) { super(); }

  protected write(level, message, context): void {
    for (const logger of this.loggers) logger.log(level, message, context);
  }
}
```

Fans every call out to a list of other loggers. Console **and** file, or
file **and** whatever you added via `extend()`. The default in a
generated app.

Constituents are resolved through `manager.channel(name)`, not
`driver()`, so a broken member of a stack falls back to the emergency
logger rather than taking the whole stack down:

```ts
manager.extend("stack", () => {
  const cfg = manager.channelConfig("stack") as { driver: "stack"; channels: string[] };
  return new StackLogger(cfg.channels.map((name) => manager.channel(name)));
});
```

Fan-out goes through each constituent's own `log(level, ...)`, so all
eight levels reach every member from one `write()`.

Nothing prevents a stack from listing itself, which would recurse until
the stack overflows. Don't.

## `LogManager`

```ts
class LogManager extends Manager<Logger>
```

| Method | Returns | Notes |
|---|---|---|
| `channel(name?)` | `Logger` | Resolve a channel. **Never throws.** |
| `channelConfig(name)` | `unknown` | The raw `channels[name]` entry. |
| `emergency()` | `Logger` | The last-resort logger. Always a `FileLogger`. |
| `getDefaultDriver()` | `string` | `config.default`. |
| `extend(name, factory)` | `this` | Register a channel driver. |

### `channel()` never throws

This is the one place a `Manager` subclass deliberately breaks the base
class's contract:

```ts
channel(name?: string): Logger {
  try {
    return this.driver(name);
  } catch (error) {
    const emergency = this.emergency();
    emergency.error("Unable to create configured logger. Using emergency logger.", {
      channel: name ?? this.getDefaultDriver(),
      error: error instanceof Error ? error.message : String(error),
    });
    return emergency;
  }
}
```

An unregistered driver name, missing or malformed config, or the driver's
own constructor throwing (an unwritable log directory is the classic) all
get caught. You get a working `Logger` back, and the *reason* the real one
failed is written through the emergency logger.

The rationale is narrow and specific: **a misconfigured log channel must
not take down the request that was trying to log through it.** Logging is
what you use when something is already going wrong; a logger that
throws turns a handled error into an unhandled one, and buries the
original. This is exactly what Laravel's `LogManager::get()` does.

`driver()`, inherited from `Manager`, still throws
`DriverNotRegisteredError`. If you want the failure loud, call it
directly.

### `emergency()`

```ts
emergency(): Logger {
  if (!this.emergencyLogger) {
    const path = this.config.emergency?.path ?? storage_path("logs/mahi.log");
    this.emergencyLogger = new FileLogger(path, this.app);
  }
  return this.emergencyLogger;
}
```

**Always a `FileLogger`**, constructed directly. It is never resolved
through `driver()`/`extend()`, so it cannot fail for the same reason the
channel it's replacing just did, a broken `extend()` factory, a bad
config entry, a driver name that doesn't exist. The only way to construct
it is `new FileLogger(path, app)`, and the only way *that* fails is an
unwritable directory.

Path comes from `config.emergency.path`, defaulting to
`storage_path("logs/mahi.log")`, the same physical file `single`
defaults to. Lazily constructed and cached, like any resolved driver.

Nothing stops you calling it directly if you want a guaranteed-file
logger:

```ts
app.make<LogManager>(LOG_TOKEN).emergency().critical("out of disk");
```

## The `Log` facade

```ts
Log.info("cache warmed");
Log.channel("daily").warning("rotated");
Log.log(level, message, context);

const logger: Logger = Log.channel("custom");
```

| Static | Behaviour |
|---|---|
| `Log.instance()` | The `LogManager` |
| `Log.channel(name?)` | `manager.channel(name)` |
| `Log.emergency` … `Log.debug` | Forward to the **default channel** |
| `Log.log(level, msg, ctx?)` | Forward to the default channel |
| `Log.warn(msg, ctx?)` | `@deprecated`: forwards to `warning()` |

Note there is no `Log.error(msg, ctx, channel)` overload. For a
non-default channel, go through `Log.channel(name)`, which returns a plain
`Logger`.

`Log` is hand-written directly against `app()` and `LOG_TOKEN` rather
than built on `@mahiframework/facades`' `Facade<T>` mixin, because
`@mahiframework/facades` depends on `@mahiframework/core` (for `app()`), and
`LOG_TOKEN`/`LogManager` live in core, so importing `Facade` here would
be a circular package dependency. `LogManager` is a concrete non-generic
type anyway, so `Facade<T>`'s generic-static workaround buys nothing.

Same guidance as every facade: prefer constructor-injecting `LogManager`
via `LOG_TOKEN` where you already have `app`. And the same test caveat,
`Log` always resolves off the *current global* app, so a test with its own
isolated `Application` should resolve `LOG_TOKEN` off that instance
directly.

### Custom channels

```ts
import { ServiceProvider, LogManager, LOG_TOKEN, AbstractLogger, type LogLevel } from "@mahiframework/core";

export class SentryLogger extends AbstractLogger {
  constructor(private dsn: string) { super(); }

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level === "debug" || level === "info" || level === "notice") return;
    void fetch(this.dsn, {
      method: "POST",
      body: JSON.stringify({ level, message, extra: context }),
    }).catch(() => { /* a logger must not throw */ });
  }
}

export class SentryServiceProvider extends ServiceProvider {
  boot(): void {
    const manager = this.app.make<LogManager>(LOG_TOKEN);
    manager.extend("sentry", () => {
      const cfg = manager.channelConfig("sentry") as { dsn: string };
      return new SentryLogger(cfg.dsn);
    });
  }
}
```

```ts
// config/logging.ts
channels: {
  // ...
  sentry: { driver: "sentry", dsn: env.SENTRY_DSN } as LogChannelConfig,
  stack:  { driver: "stack", channels: ["console", "single", "sentry"] },
}
```

Three notes:

**Register in `boot()`** if you're extending a manager another provider
owns. `LOG_TOKEN` has to be bound first.

**A custom channel's config is outside `LogChannelConfig`'s union.**
That union enumerates the built-in drivers, so a custom entry needs a cast
(or a module augmentation) to satisfy it. `channelConfig()` returns
`unknown` regardless, so the cast happens in your factory either way.

**Never throw from `write()`.** `channel()` catches construction
failures, not write failures. A `write()` that throws propagates out of
`logger.info(...)`, a synchronous, void-returning call that nobody
wraps.

## Context

```ts
import { Context } from "@mahiframework/core";

Context.add("requestId", requestId);
Log.info("cache warmed");    // ... cache warmed {"requestId":"a1b2c3"}
```

`ContextRepository` is a key/value store for cross-cutting data that
should ride along with everything the application does. Its most visible
consumer is `formatLogLine()`, which appends `all()` as a trailing JSON
object to **every** log line.

Like `app.logger`, it's a **plain readonly field on `Application`**:

```ts
readonly context = new ContextRepository();
```

No token, no provider, no registration. `Context` (the facade) works with
zero setup. It doesn't need `LoggingServiceProvider` or anything else.

### The two-layer design

Laravel gets per-request isolation free from PHP's process-per-request
model. A Node process serving concurrent requests would otherwise share
one repository across all of them, so a request id written by request A
would appear in request B's log lines.

So the repository has **two layers**, resolved automatically per call:

```ts
private globalData: Record<string, unknown> = {};
private readonly requestScope = new AsyncLocalStorage<Record<string, unknown>>();

private active(): Record<string, unknown> {
  return this.requestScope.getStore() ?? this.globalData;
}
```

- A **process-global** store: data added at boot (app version, deploy
  id, worker name), visible everywhere.
- A **per-request overlay**, an `AsyncLocalStorage`-scoped store opened
  by `runScoped()`, which starts as a **shallow copy of the global
  store**. A request sees all global context immediately, and every
  subsequent read/write/forget inside the request targets the overlay
  only. Nothing a request adds, or forgets, leaks into the global store
  or into another concurrent request, and the overlay is discarded when
  the request ends.

Every operation goes through `active()`, so **the API is identical
whether or not a scope is open**. Outside one, boot, a queue job, a CLI
command, a test, everything falls back to the global store. You never
have to check.

### `runScoped()`

```ts
runScoped<T>(fn: () => T): T
```

Every framework entry point already opens one for you, via
`runInvocationScope()` (see [Invocation ids](#invocation-ids)): the HTTP
kernel as its **outermost** pipe, ahead of even the maintenance-mode
check; the queue worker around each job; the console kernel around each
command. So anything added by a pipe, a handler, a job or a command is
isolated to that unit of work and discarded when it ends. It's cheap: one
`AsyncLocalStorage.run` per invocation.

That last part matters most for a queue worker, which is a daemon that
can run for days. Without a per-job scope, anything a job adds to the
context accumulates in the process-global store and shows up on the log
lines of every job that follows it.

Use it directly only in an entry point the framework doesn't own, or to
nest a narrower scope inside one:

```ts
await Context.runScoped(async () => {
  Context.add("batchId", batch.id);
  await processBatch(batch);
});
```

`hasScope()` tells you whether one is currently active on this call stack.

## Invocation ids

Every log line carries an `invocation` id identifying the single unit of
work that produced it — one HTTP request, one queue job, one CLI command:

```
[2026-10-07 12:00:05] production.INFO: payment captured {"invocation":"01a11521-ebe0-71f6-bc76-199e0b807ad4"}
```

A log line on its own says what happened; a log line with an invocation
id says what happened *during what*, which is the difference between
reading a concurrent server's output and guessing at it. Filter a log
aggregator by one id and you get exactly the lines from that one request.

Nothing at the call site passes it. Each entry point calls
`runInvocationScope()`, which generates the id and writes it into the
context overlay, and `formatLogLine()` appends the context to every line.

### Reading it

```ts
import { Invocation } from "@mahiframework/core";

Invocation.id();       // string — generates and memoizes on first call
Invocation.current();  // string | null — the memoized id, never generates one
Invocation.reset();    // drop it; the next id() generates a fresh one
Invocation.hasScope(); // whether an invocation scope is active here
```

Useful for stamping the id onto something durable — an audit row, an
outbound webhook header, an error report — so a record in your database
can be tied back to the log lines that produced it.

`id()` is **synchronous**, which is what lets `formatLogLine()` read it —
a log formatter cannot await. It is memoized per invocation, so asking
twice gives the same answer. `current()` is the variant that reports
absence instead of generating.

### A UUIDv7

The id is a v7 UUID: a 48-bit millisecond timestamp followed by 74 bits
of entropy. That shape is deliberate, and gives the three properties an
invocation id needs:

- **time-sortable**, so ids sort chronologically in an aggregator;
- **no coordination**, uniqueness comes from entropy rather than from an
  operator assigning a distinct node id per process. Any number of
  processes, containers or hosts generate ids concurrently with no shared
  state and no configuration. A scheme deriving uniqueness from a
  configured worker id instead emits *duplicate* ids when two processes
  share that config — for the one value whose entire job is to
  disambiguate concurrent work, the worst possible failure;
- **cheap** (~80ns), so stamping one on every request and job is free.

Ordering is millisecond-granular: two ids from the same millisecond have
no guaranteed order relative to each other. For correlating log lines
that is irrelevant — the id is an identity, not a sequence.

It needs no provider, no config and no container. `Invocation.id()` works
in a bare unit test.

### Per-invocation isolation

The id is held in an `AsyncLocalStorage` scope, not a static field,
because this framework boots one long-lived `Application` and serves
every request from it. A plain static would be shared by every request in
flight: one request's `reset()` would be observed by another mid-flight,
and two concurrent requests would log the same id — exactly the confusion
the id exists to remove.

Outside any scope (boot, a script, a test) `id()` and `reset()` fall back
to a process-global holder, so the API behaves identically whether or not
a scope is open and callers never have to check.

### The full API

Available identically on `ContextRepository` and on the `Context` facade.

| Method | Signature | Behaviour |
|---|---|---|
| `add` | `(key, value)` / `(record)` | Set one pair, or merge a whole record. Overwrites. |
| `addIf` | `(key, value)` | Set only when the key is absent. |
| `get` | `<T>(key, default?)` | The value, or `default` when absent. |
| `pull` | `<T>(key, default?)` | `get()` then `forget()`. |
| `has` | `(key)` | `Object.hasOwn` on the active store. |
| `missing` | `(key)` | `!has(key)`. |
| `all` | `()` | **A shallow copy** of the active store. |
| `only` | `(keys)` | Just those keys. Absent keys are omitted. |
| `except` | `(keys)` | Everything but those keys. |
| `forget` | `(key \| key[])` | Remove one or several. |
| `push` | `(key, ...values)` | Append to the array at `key`. **Throws on a non-array.** |
| `remember` | `<T>(key, factory)` | Compute and store when absent, then return. |
| `scope` | `<T>(callback, data?)` | Run with `data` merged in, then restore. |
| `runScoped` | `<T>(fn)` | Open a fresh per-request overlay. |
| `flush` | `()` | Clear the active store. |
| `isEmpty` | `()` | No keys in the active store. |
| `hasScope` | `()` | *(repository only)* Is an overlay active? |

Everything mutating returns `this` (or the repository, from the facade),
so calls chain.

**`all()` returns a copy.** Mutating the returned object never mutates the
repository:

```ts
const snapshot = Context.all();
snapshot.userId = "spoofed";      // no effect on the repository
```

That also means `all()` allocates on every call, including once per log
line via `formatLogLine()`. Keep the context small.

**`push()` throws on a non-array:**

```ts
Context.add("tags", "welcome");
Context.push("tags", "onboarding");
// Error: Unable to push value onto context stack for key "tags" — existing value is not an array.
```

Same guard as Laravel's `push()`. Pushing to an absent key creates the
array; pushing to a string, number or object is a programming error and
says so. Note that `push()` **replaces** the array with a new one
(`[...existing, ...values]`) rather than mutating in place, so a
previously captured `all()` snapshot doesn't change under you.

**`has()` is `Object.hasOwn`, not truthiness.** A key explicitly set to
`null`, `0`, `""` or `false` is present. Only a key that was never set,
or was `forget()`ed, is missing.

### `scope()` restore semantics

```ts
scope<T>(callback: () => T, data: Record<string, unknown> = {}): T
```

Runs `callback` with `data` temporarily merged into the active store, then
restores the previous contents:

```ts
Context.add("deploy", "abc123");

Context.scope(() => {
  Context.add("step", "migrate");
  Log.info("running");        // ... running {"deploy":"abc123","step":"migrate"}
}, { batch: 7 });

Context.all();                // { deploy: "abc123" } — step and batch are both gone
```

Three things to know:

**Changes the callback itself makes are discarded too.** `step` above was
added inside the callback and does not survive. The restore is a full
snapshot replacement, not a targeted removal of `data`'s keys. That
matches Laravel's `scope()` semantics.

**It restores even when the callback throws**, and, for async callbacks,
only after the returned promise settles:

```ts
if (result instanceof Promise) {
  return result.finally(restore) as T;
}
```

The `instanceof Promise` check matters: a thenable that isn't a
real `Promise` restores synchronously, i.e. too early.

**Async `scope()` outside a request scope is not isolated.** Inside a
`runScoped()` overlay, `scope()` snapshots and restores the overlay, so
concurrent requests don't interfere. Outside one it operates on the
process-global store, and two concurrent async `scope()` calls sharing
that store will clobber each other's snapshots. Use `runScoped()` for
genuine isolation; `scope()` is a temporary-overlay convenience, not a
concurrency primitive.

The restore is done by replacing the store's contents **in place**, not by
reassigning the reference. An `AsyncLocalStorage` overlay is owned by
the scope and can't be swapped out.

### Deliberately omitted

From Laravel's `Context` API: hidden data (`addHidden()` et al.),
counters (`increment()`/`decrement()`), and the dehydrate/hydrate hooks
that propagate context across queued jobs. If you want context on a job,
put it in the job's own fields.

## Testing

`ArrayLogger` is the fake, and it needs no container:

```ts
import { ArrayLogger } from "@mahiframework/core";

const logger = new ArrayLogger();
logger.warning("disk nearly full", { free: 512 });

expect(logger.entries).toEqual([
  { level: "warning", message: "disk nearly full", context: { free: 512 } },
]);
```

Entries are structural, not formatted strings, so assertions don't depend
on the timestamp or the environment prefix.

Through the channel system:

```ts
app.config.set("logging", {
  default: "array",
  channels: { array: { driver: "array" } },
});
app.register(LoggingServiceProvider);
await app.bootstrap();

const manager = app.make<LogManager>(LOG_TOKEN);
const logger = manager.channel() as ArrayLogger;

await doTheThing();

expect(logger.entries.map((e) => e.level)).toContain("error");
```

Channels are cached per name, so the same `ArrayLogger` comes back every
time. Which is what makes this work, and also why you want a fresh
`Application` per test rather than clearing `entries` by hand.

For `formatLogLine()` itself, note that the timestamp is `Date.now()` at
call time in UTC, assert with a regex or fake the clock.

Context in tests needs no setup at all, since `app.context` always
exists. If a test leaks context into another, wrap it:

```ts
await Context.runScoped(async () => {
  Context.add("test", name);
  await subject();
});
```

## Gotchas

**`app.logger` and `Log` are different loggers.** The single biggest
source of "where did my log line go". `app.logger` is always a
`ConsoleLogger`; `Log` is whatever `logging.default` resolves to.

**`LoggingServiceProvider` is not auto-registered.** `Log.info(...)`
throws `BindingNotFoundError` without it in `providers[]`.

**`channel()` never throws. It silently degrades to the emergency
logger.** Your logs are then in `storage/logs/mahi.log`, not where you
configured. Look for the `"Unable to create configured logger"` line.

**`daily` never writes to the configured path.** That path is a template.
Look for `mahi-YYYY-MM-DD.log` next to it.

**`daily` rotates on LOCAL date; timestamps inside are UTC.** Run servers
in UTC and the discrepancy disappears.

**`daily` prunes only when the filename changes.** A process that only
ever logs on one day never prunes.

**`FileLogger`/`single` has no rotation at all.** One file, forever. Use
`logrotate` or the `daily` driver.

**There is no level filtering.** No minimum severity. `debug` in
production writes `debug` in production.

**Log writes are synchronous.** `appendFileSync` on the main thread. High
log volume to a slow disk is backpressure on your request handler.

**`warn()` is deprecated, `warning()` is canonical.** Both work.

**`Context.all()` allocates a copy per call**, including once per
formatted log line. Big contexts cost.

**`Context.push()` throws on a non-array.** Set the key with an array, or
don't set it at all.

**`Context.scope()` discards changes the callback made**, not just the
data you passed in.

**Async `Context.scope()` outside `runScoped()` isn't isolated.** Two
concurrent scopes on the global store clobber each other.

**A custom logger's `write()` must not throw.** Nothing catches it,
`channel()` only guards construction.

## Related

- [Configuration](../configuration/): `config/logging.ts`, `storage_path()`
- [Providers](../providers/): registering `LoggingServiceProvider`, `extend()`
- [Lifecycle](../lifecycle/): why `app.logger` exists before any provider
- [Container](../container/): `LOG_TOKEN`, `BindingNotFoundError`
- [Requests](../requests/): the per-request `Context` overlay the kernel opens
- [Mail](../mail/): the `log` mailer writes through `app.logger`
- [Queues](../queues/): using `runScoped()` around a job
- [Deployment](../deployment/): capturing stdout, and log shipping
