# Testing

`@mahiframework/testing` boots your **real** application against a throwaway
database (SQLite by default, or MySQL/Postgres, see
[Choosing an engine](#choosing-an-engine)) and dispatches requests
straight into its Hono instance, no server, no port, no mocking of the
framework.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApplication, TestClient, type TestApplication } from "@mahiframework/testing";
import { bootstrap } from "../bin/bootstrap.js";

describe("Auth API", () => {
  let testApp: TestApplication;
  let client: TestClient;

  beforeAll(async () => {
    testApp = await createTestApplication(bootstrap);
    client = new TestClient(testApp.request);
  });

  afterAll(async () => {
    await testApp.cleanup();
  });

  it("requires authentication for /auth/me", async () => {
    const response = await testApp.request("/auth/me");
    expect(response.status).toBe(401);
  });
});
```

The generated app ships with vitest configured and a working suite:

```bash
npm test
./artisan test          # same thing, through the console kernel
```

The package is runner-agnostic by construction. Every assertion here
throws a plain `Error` rather than using a vitest matcher, so nothing
stops you composing it from node:test or any other runner. Vitest is
simply what the template wires up.

## `createTestApplication()`

```ts
createTestApplication(
  bootstrapFn: () => Promise<Application>,
  options?: TestApplicationOptions,
): Promise<TestApplication>
```

It takes **your app's own bootstrap function** rather than importing one.
The package can't depend on any specific application, so it stays a
generic helper that each app supplies its bootstrap to. Which is also
what makes a test run against the same wiring as production. `bin/bootstrap.ts`
is shared by `bin/console.ts`, `bin/server.ts`, and the test suite:

```ts
import { bootstrap } from "../bin/bootstrap.js";

const testApp = await createTestApplication(bootstrap);
```

### What it does, in order

**1. Creates a temp directory and points the database at it.**

```ts
const tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-test-"));
process.env.DB_FILENAME = path.join(tmpDir, "test.sqlite");
process.env.NODE_ENV = "test";
process.env.APP_KEY ??= `base64:${randomBytes(32).toString("base64")}`;
```

Every call gets its **own** `mkdtemp` directory, so two
`createTestApplication()` calls, in the same file or in parallel files,
never share a database.

On MySQL or Postgres it also creates a scratch database on the server,
`mahi_test_app_<label>_<random>`, and points `DB_CONNECTION`, `DB_HOST`,
`DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and `DB_PASSWORD` at it. Every
call gets its own, for the same reason. See
[Choosing an engine](#choosing-an-engine).

**2. Sets the environment *before* `bootstrapFn()` runs.**
The ordering is the whole trick. A typical `config/database.ts` reads
`env.DB_CONNECTION` and `env.DB_FILENAME` (or the `DB_*` host
variables), so setting them first means the app picks up the throwaway
database with no test-specific configuration:

```ts
export function databaseConfig(env: Env): DatabaseConfig {
  return {
    default: env.DB_CONNECTION,
    connections: {
      sqlite: { driver: "sqlite", filename: env.DB_FILENAME },
      mysql: { driver: "mysql", host: env.DB_HOST, database: env.DB_DATABASE /* ... */ },
      pgsql: { driver: "postgres", host: env.DB_HOST, database: env.DB_DATABASE /* ... */ },
    },
  };
}
```

`NODE_ENV=test` flows into `app.useEnvironment(env.NODE_ENV)`, so
`app.environment("test")` is true and `isProduction()` is false.

`APP_KEY` is set with `??=`, only when nothing has set one already. The
template's env schema deliberately leaves `APP_KEY` without a default so a
missing key fails loudly in production, which would otherwise make every
test that doesn't have a real `.env` fail `loadEnv()` validation. A fresh
random key per run is exactly right for a test.

**3. Calls `bootstrapFn()`.** This runs `loadEnv()`, populates config,
registers providers, and runs the full two-stage `register()`/`boot()`
lifecycle. It is the real application.

**4. Calls `options.configure?.(app)`.**

**5. Runs every migration.** Not just yours:

```ts
const runner = new MigrationRunner(db.driver().kysely);
const migrationDirectories = collectMigrationDirectories(app);
await runner.up(migrationDirectories);
```

`collectMigrationDirectories()` gathers `database/migrations` (or whatever
`database.migrationsPath` says) **plus every registered provider's
`migrations()` directory**. So the `users`, `personal_access_tokens`,
`sessions`, `jobs`, `failed_jobs`, and `password_reset_tokens` tables the
framework's own providers contribute are all present, without you listing
them. See [Migrations](../migrations/).

**6. Installs the fakes** requested by `options`.

**7. Grabs the Hono instance** for `request()`, if an HTTP kernel is bound.

### `TestApplicationOptions`

```ts
interface TestApplicationOptions {
  database?: TestDatabaseEngine | TestDatabaseOptions;
  configure?: (app: Application) => void;
  fakeQueue?: boolean;
  fakeEvents?: boolean;
  fakeHttp?: boolean;
  fakeProcess?: boolean;
  fakeMail?: boolean;
  fakeNotifications?: boolean;
  fakeStorage?: boolean | string[];
  fakeCache?: boolean;
}
```

**`database`** picks the engine: `"sqlite"` (the default), `"mysql"` or
`"postgres"`. The object form also takes a `label` for the scratch
database name and a `connectionName` for apps whose `config/database.ts`
doesn't use the template's `sqlite`/`mysql`/`pgsql` names. See
[Choosing an engine](#choosing-an-engine).

**`configure`** runs after `bootstrapFn()` resolves but before migrations.
Note that `bootstrapFn` is itself responsible for calling
`app.bootstrap()`, so this hook necessarily runs **after** providers have
already registered and booted. It is not a pre-boot hook. Use it for
extra `app.config.set`/`merge` calls or test-only overrides that don't
belong in the app's own bootstrap:

```ts
const testApp = await createTestApplication(bootstrap, {
  configure: (app) => {
    app.config.set("mail.default", "log");
  },
});
```

**`fakeQueue`** swaps the queue's *default* connection for a
`FakeQueueDriver`, the `Queue::fake()` equivalent. Dispatches are
recorded, not run.

**`fakeEvents`** replaces the `EventDispatcher` singleton with a
`RecordingEventDispatcher`, the `Event::fake()` equivalent. Events are
recorded; no listener, queued listener, or `afterDispatch` callback runs.

**`fakeHttp`** calls `Http.fake()` so `@mahiframework/http-client` intercepts every
outbound request, and registers `Http.restore()` on `cleanup()`. Unlike the
other two it needs no container swap and no provider, `Http` is a static
facade over module-level state, so there is **no `testApp.http`**; assert
with the statics:

```ts
const testApp = await createTestApplication(bootstrap, { fakeHttp: true });

await testApp.request("/webhooks/trigger", { method: "POST" });

Http.assertSent("api.stripe.com/*");
```

The stub map starts empty and an unmatched request raises
`StrayRequestError` rather than reaching the network, so call
`Http.fake({ ... })` in the test itself to stub specific responses. See
[Faking HTTP requests](#faking-http-requests).

**`fakeProcess`** is the same arrangement for `@mahiframework/process`: it calls
`Process.fake()` so commands are intercepted instead of spawned, and
registers `Process.restore()` on `cleanup()`. Also a static facade, so
there is no `testApp.process`:

```ts
const testApp = await createTestApplication(bootstrap, { fakeProcess: true });

Process.fake({ "git status*": makeProcessResult("git status", 0, "clean\n", "") });

await testApp.request("/deploy", { method: "POST" });

Process.assertRan("git *");
```

Worth turning on broadly, a test that shells out unmocked is slow,
environment-dependent, and occasionally destructive.

> **Note the asymmetry with `fakeHttp`.** An unmatched *command* returns a
> successful empty result; an unmatched *request* throws
> `StrayRequestError`. That is `Process.fake()`'s own documented default
> (matching Laravel's), left alone here so the behaviour does not change
> depending on who enabled it, but it does mean a typo'd pattern looks
> like a passing test. Assert with `Process.assertRan()` rather than
> relying on the stub having matched.

**`fakeMail`** replaces the `MailManager` singleton with a
`RecordingMailManager`, the `Mail::fake()` equivalent. `Mail.send()` /
`MailManager.send()` records the `Mailable` instead of delivering it, and
the recorder is returned as `testApp.mail`. See [Faking mail](#faking-mail).

**`fakeNotifications`** replaces the notifications `ChannelManager` with a
`RecordingChannelManager`, the `Notification::fake()` equivalent.
`Notifications.send()` records the `(notifiable, notification)` pair
instead of fanning out to channels; returned as `testApp.notifications`.
See [Faking notifications](#faking-notifications).

**`fakeStorage`** swaps the named disks (`["public", "s3"]`), or the
default disk, when `true`, for `FakeStorageDriver`s rooted at fresh temp
directories, the `Storage::fake($disk)` equivalent. Writes under test never
touch the app's real disk roots; each fake is returned on `testApp.storage`
keyed by disk name. See [Faking storage](#faking-storage).

**`fakeCache`** points the cache's default store at a fresh in-memory
`ArrayCacheStore` (with its sweep timer disabled), the `Cache::fake()`
equivalent, per-test isolation with no interval keeping the event loop
alive.

**`fakeQueue`, `fakeEvents`, `fakeMail`, `fakeNotifications`, `fakeStorage`,
and `fakeCache` are no-ops when the relevant provider isn't registered:**

```ts
if (options.fakeQueue && app.has(QUEUE_TOKEN)) { /* ... */ }
if (options.fakeEvents && app.has(EVENTS_TOKEN)) { /* ... */ }
if (options.fakeMail && app.has(MAIL_TOKEN)) { /* ... */ }
```

An app that registers only the database and HTTP layers can pass
`{ fakeQueue: true }` without an error. `testApp.queue` is simply
`undefined`. That's why `queue`/`events`/`mail`/`notifications` are all
optional on `TestApplication` and why every example asserts through
`testApp.queue!`.

`fakeEvents` uses `app.instance(EVENTS_TOKEN, events)` rather than
rebinding a factory, so every subsequent `make(EVENTS_TOKEN)`, model
lifecycle events, the `Events` facade, a controller resolving it, gets
the recorder. Listener wiring already ran during boot against the real
dispatcher; that's fine, because a fake runs no listeners anyway.

### `TestApplication`

```ts
interface TestApplication {
  app: Application;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  cleanup: () => Promise<void>;
  resetDatabase: () => Promise<void>;
  clearDatabase: () => Promise<void>;
  actingAs: (user: unknown, guard?: string) => void;
  queue?: FakeQueueDriver;
  events?: RecordingEventDispatcher;
  mail?: RecordingMailManager;
  notifications?: RecordingChannelManager;
  storage: Record<string, FakeStorageDriver>;
}
```

**`app`** is the real, booted `Application`. Resolve anything from it:

```ts
const registry = testApp.app.make<JobRegistry>(JOB_REGISTRY_TOKEN);
const schedule = testApp.app.make<Schedule>(SCHEDULE_TOKEN);
```

**`request(path, init)`** dispatches into the app's own Hono instance via
`hono.request()` and returns a standard `Response`. Nothing binds a port.
The `init` is a plain `RequestInit`, method, headers, body.

If no HTTP kernel is bound, calling `request()` throws a clear message
rather than failing at setup time, so a database-only test app is still
usable:

```
createTestApplication(): no HTTP kernel is bound (HttpServiceProvider not
registered), so request() is unavailable.
```

**`cleanup()`** tears the whole thing down, in order:

1. restores any module-level fakes (`Http.restore()` when `fakeHttp` was
   set, `Process.restore()` when `fakeProcess` was);
2. `app.terminate()`: runs every provider's `shutdown()` hook, which
   closes the sqlite handle or the MySQL/Postgres pool, and any Redis
   client the app opened;
3. on MySQL or Postgres, drops the scratch database;
4. restores the `process.env` keys it mutated (`DB_FILENAME`, `NODE_ENV`,
   `APP_KEY`, and the `DB_*` connection keys) to exactly what they were,
   deleting the ones that were previously unset;
5. removes the temp directory.

The order matters: terminating first means the database file is not
deleted out from under an open handle, and on Postgres it is what makes
the drop possible at all, since a database with a connected session
cannot be dropped.

Dropping the scratch database never throws. If it fails, the database is
left behind (it is uniquely named, so nothing reuses it) rather than one
failed teardown failing the whole suite.

Always call it from `afterAll`.

**`clearDatabase()`** deletes every row from every table, keeps the
schema, and restarts auto-increment counters at 1. The `migrations`
ledger is left alone. This is the per-test reset to reach for. See
[Test isolation](#test-isolation).

**`resetDatabase()`** re-runs every migration from scratch against the
same database (`migrate:fresh`, drop all tables, re-migrate). Only needed
when a test changes the schema.

**`actingAs(user, guard?)`** sets the authenticated user for every
subsequent request driven through the kernel, Laravel's `actingAs()`. It
delegates to `AuthManager.actingAs()`, which swaps the resolved guard so
`authenticate()` returns `user` without a real token or session cookie:

```ts
testApp.actingAs(user);
const me = await client.getJson("/me");   // 200, Auth.user() === user
```

Pass `null` to clear it. It requires `@mahiframework/auth`'s `AuthServiceProvider`
to be registered, calling it otherwise throws a clear error. For a full
round trip through a real guard (issuing a bearer token or a session
cookie) rather than short-circuiting resolution, use
[`withToken()`](#actingas-tokens-and-cookies) or the cookie jar instead.

## `TestClient`

A thin wrapper over a `request()` function that removes the repeated
`JSON.stringify` and `Content-Type` boilerplate.

```ts
const client = new TestClient(testApp.request);

const { status, body } = await client.postJson<{ token: string }>("/auth/login", {
  email: "ada@example.com",
  password: "correct-horse-battery",
});
```

| Method | Signature |
|---|---|
| `getJson<T>` | `(path, init?)` |
| `postJson<T>` | `(path, payload?, init?)` |
| `patchJson<T>` | `(path, payload?, init?)` |
| `putJson<T>` | `(path, payload?, init?)` |
| `deleteJson<T>` | `(path, init?)` |

Every method returns `{ status: number; body: T }`, no `Response`, no
second `await res.json()`.

**There is no bare `get()`, `post()`, or `delete()`.** Every method parses
the body as JSON, and every method's name says so. But unlike a naive
`res.json()`, the client **reads the body defensively**: a `204 No
Content`, an empty body, or a non-JSON `Content-Type` (a plain-text
`404`/`500`) returns `body: undefined` rather than throwing an opaque
`SyntaxError`. You still have `status` to assert on:

```ts
const { status, body } = await client.getJson("/auth/me");
expect(status).toBe(401);        // works even if the 401 has no JSON body
```

For header assertions or the raw `Response`, use `testApp.request()`
directly:

```ts
const response = await testApp.request("/auth/me");
expect(response.headers.get("content-type")).toContain("application/json");
```

Headers passed as `init.headers` are **normalised through `new
Headers()`**, so a `Headers` instance or a `[key, value][]` tuple array is
honoured, both used to spread to `{}` and be silently dropped:

```ts
await client.getJson("/me", { headers: new Headers({ Authorization: "Bearer x" }) });
await client.getJson("/me", { headers: [["Authorization", "Bearer x"]] });
```

The write methods still merge `Content-Type: application/json` (only when
you didn't set one yourself) and send `JSON.stringify(payload ?? {})`, so a
payload-less `postJson(path)` sends `{}`, not an empty body.

### `actingAs`, tokens, and cookies

`TestClient` carries a **cookie jar** and a set of **default headers**, so
a login flow through the kernel just works:

```ts
const client = new TestClient(testApp.request);

// Bearer-token auth — pair with TokenGuard.createToken().
client.withToken(token);
const me = await client.getJson("/me");

// Session auth — a Set-Cookie from one request is replayed on the next.
await client.postJson("/login", { email, password });
expect(client.cookie("session")).toBeDefined();
const dashboard = await client.getJson("/dashboard");   // sends the cookie
```

| Method | Purpose |
|---|---|
| `withToken(token, type?)` | `Authorization: <type> <token>` on every request (`type` defaults to `Bearer`) |
| `withHeaders(headers)` | Merge extra default headers |
| `withCookie(name, value)` | Seed the cookie jar |
| `cookie(name)` | Read a captured cookie |
| `flush()` | Drop all default headers and cookies |

Every `Set-Cookie` on a response is captured into the jar and replayed as a
`Cookie` header on subsequent requests, so session-guard flows are testable
end to end through the kernel. Which is what the token/session tests need
(and what `actingAs()` short-circuits when you don't care about the guard
mechanics). Per-request `init.headers` always win over the client
defaults.

`TestClient` is a plain class, not a runner-specific base, compose it
from `beforeAll`/`afterAll` like any other fixture.

## Writing tests

The template's `tests/auth.test.ts` and `tests/helpers/auth.ts` are the
pattern to copy.

### The helper

```ts
// tests/helpers/auth.ts
export async function registerUser(
  testApp: TestApplication,
  overrides: { email?: string; password?: string; name?: string } = {},
): Promise<AuthenticatedUser> {
  const email = overrides.email ?? `user-${randomUUID()}@example.com`;
  const password = overrides.password ?? "correct-horse-battery";

  await resetRateLimits(testApp);

  const response = await testApp.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: overrides.name ?? "Test User", email, password }),
  });

  if (response.status !== 201) {
    throw new Error(`Failed to register test user: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { user: { id: string }; token: string };

  return { id: body.user.id, email, password, token: body.token, ...clientFor(testApp, body.token) };
}
```

```ts
export function clientFor(testApp: TestApplication, token: string) {
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    testApp.request(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });

  return { client: new TestClient(request), request };
}
```

Two things this buys you. The helper **throws on an unexpected status
with the response body in the message**, a failed registration surfaces
as "user registration returned 422: {...}" rather than as a confusing
`undefined` three assertions later. And it returns both a `TestClient`
(for JSON assertions) and a raw `request` (for header and status
assertions) with the bearer token already attached:

```ts
const author = await registerUser(testApp);

const { status, body } = await author.client.postJson<PostJson>("/posts", { body: "Hello" });
const raw = await author.request("/auth/logout", { method: "POST" });
```

### Rate limiters in tests

This is the detail most likely to bite you, and it's why the helper calls
`resetRateLimits()`.

The app's rate limiters key off `request.ip()`, the template registers
`register` at 10/min and `login` at 5/min. An in-process `hono.request()`
has **no socket peer**, so `ip()` is `undefined` and every request in the
suite shares one limiter key. The consequences:

- One test file's requests eat another's budget. A file that registers 12
  users trips the `register` limiter and the twelfth `registerUser()` call
  fails with a 429, in a file that has nothing to do with rate limiting.
- Failures become **order-dependent**. The suite passes when run alone and
  fails under `--shard`, or vice versa.
- A genuine rate-limiting test can't distinguish "I tripped the limit"
  from "I inherited someone else's exhausted budget."

The fix is to clear the limiter's state between tests:

```ts
export async function resetRateLimits(testApp: TestApplication): Promise<void> {
  if (!testApp.app.has(CACHE_TOKEN)) return;
  await testApp.app.make<CacheManager>(CACHE_TOKEN).store().flush();
}

beforeEach(async () => {
  await resetRateLimits(testApp);
});
```

> **Don't fake a distinct client with a per-request `x-forwarded-for`.**
> That only works if `Request.ip()` trusts the header. Which is exactly
> the hole that lets an attacker rotate it to bypass the login limiter.
> The header is not trusted, so a test that sets it is testing nothing.
> If a testing convenience depends on a security hole, the hole is the
> problem.

Testing the limiter itself is direct, fire until it trips:

```ts
const statuses = [];
for (let i = 0; i < 7; i++) {
  const { status } = await client.postJson("/auth/login", {
    email: user.email,
    password: `wrong-${i}`,
  });
  statuses.push(status);
}
expect(statuses).toContain(429);
```

And assert it *can't* be bypassed, by sending a forged header and
expecting the limit to hold anyway:

```ts
const { status } = await client.postJson(
  "/auth/login",
  { email: user.email, password: "wrong" },
  { headers: { "x-forwarded-for": "10.0.0.99" } },
);
```

See [Cache](../cache/#rate-limiting) for the limiter internals, and
[Trusted proxies](../routing/#trusted-proxies-and-hosts) for how `ip()`
resolves in production.

### Test isolation

**The default is one database per file, shared across every `it()`.** That
is deliberate: `createTestApplication()` boots a full application and runs
every migration, which is not free, and most test files are perfectly
happy creating fresh fixtures per test.

```ts
beforeAll(async () => {
  testApp = await createTestApplication(bootstrap);
  author = await registerUser(testApp);
});

afterAll(() => testApp.cleanup());
```

Write tests that don't collide, unique emails, unique hashtag names,
fresh posts, and the shared database is a non-issue. The template's
helpers already do this with `randomUUID()` suffixes.

When you genuinely need per-`it()` isolation, `clearDatabase()` from a
`beforeEach`:

```ts
beforeAll(async () => {
  testApp = await createTestApplication(bootstrap);
});

beforeEach(async () => {
  await testApp.clearDatabase();
});

afterAll(() => testApp.cleanup());
```

It is Laravel's `DatabaseTruncation`: every row goes, the schema stays,
and auto-increment ids restart at 1 on every engine so a test asserting
an id means the same thing everywhere. Per engine:

| Engine | How |
|---|---|
| SQLite | `DELETE FROM` each table with foreign keys off, then clears `sqlite_sequence` |
| MySQL | `TRUNCATE` each table with `FOREIGN_KEY_CHECKS = 0` on one pinned connection |
| Postgres | one `TRUNCATE ... RESTART IDENTITY CASCADE` over the tables in `current_schema()` |

The `migrations` and `migrations_lock` tables are skipped, so the ledger
still matches the schema. Any fixture created in `beforeAll` is wiped by
the first `beforeEach`, so create fixtures in `beforeEach` too when you
use it.

There is deliberately no transaction-wrapped reset (Laravel's
`RefreshDatabase`). Rolling back after each test is cheap, but it means
nothing the test does is ever committed: `lock()` and
`SELECT ... FOR UPDATE` have nothing to contend with, a second
connection or a queue worker can't see the test's rows, and
commit-time behaviour is never exercised. Those are the things a real
engine is there to test.

**`resetDatabase()`** is the heavier option: it runs `migrate:fresh`,
dropping every table and re-running every migration. Use it only when a
test alters the schema. On SQLite it is fast; on MySQL or Postgres it
costs seconds per call, which makes it unusable in a `beforeEach`.

Neither re-boots the app, so the **fakes are not reset with them**. Each
exposes its own `reset()`:

```ts
beforeEach(async () => {
  await testApp.clearDatabase();
  testApp.queue?.reset();
  testApp.events?.reset();
  testApp.mail?.reset();
  testApp.notifications?.reset();
});
```

For per-`describe` isolation without the reset, nest `describe` blocks
with their own `beforeAll`/`afterAll`, useful when each block needs
different fake options anyway.

### Choosing an engine

**Test on what you deploy on.** SQLite is the default because it needs
nothing running, not because it stands in for MySQL or Postgres. A suite
that deploys on Postgres and tests on SQLite passes things production
won't:

- `like` folds case on SQLite and is case-sensitive on Postgres, so a
  search endpoint can pass every test and match nothing in production.
- Partial indexes, GIN indexes and `dropForeign()` can't run on SQLite at
  all, so those migrations have to be skipped or branched on dialect,
  and the tested schema is no longer the deployed one.
- SQLite has no type affinity: a `varchar(20)` column accepts anything.
- `lock()` is a no-op on SQLite, so a `SELECT ... FOR UPDATE` race is
  asserted against nothing.
- Unique-violation and other error translation is engine-specific; a
  SQLite test only proves the SQLite mapping.

Each of those is a green test that asserted nothing.

Pick the engine per call:

```ts
testApp = await createTestApplication(bootstrap, { database: "postgres" });
```

or move the whole suite without touching a test file:

```bash
MAHI_TEST_ENGINE=postgres npm test
```

The option wins over the variable. An unrecognised value in either throws
rather than falling back to SQLite, since a typo that quietly ran SQLite
would report a Postgres run that never happened.

**Where the server is.** The harness reads its own variables, not `DB_*`
(those belong to your app, and the harness *writes* them):

| Variable | Default |
|---|---|
| `MAHI_TEST_MYSQL_HOST` / `_PORT` | `127.0.0.1` / `3306` |
| `MAHI_TEST_MYSQL_DATABASE` | `mahi_test` |
| `MAHI_TEST_MYSQL_USER` / `_PASSWORD` | `root` / `mysql` |
| `MAHI_TEST_PGHOST` / `MAHI_TEST_PGPORT` | `127.0.0.1` / `5432` |
| `MAHI_TEST_PGDATABASE` | `mahi_test` |
| `MAHI_TEST_PGUSER` / `MAHI_TEST_PGPASSWORD` | `postgres` / `postgres` |

The configured database is only used to connect and issue
`CREATE DATABASE`; each `createTestApplication()` call then works in its
own `mahi_test_app_<label>_<random>` database, dropped by `cleanup()`.
That gives parallel test files real isolation without serialising them.
The user needs permission to create and drop databases.

A crashed run can leave a scratch database behind. They all share the
`mahi_test_app_` prefix, so they're easy to find and drop.

The object form sets the name label and, if your `config/database.ts`
names its connections differently from the template, the connection to
select:

```ts
await createTestApplication(bootstrap, {
  database: { engine: "postgres", label: "checkout", connectionName: "primary" },
});
```

**Skipping when the server isn't there.** Gate the suite with
`testEngineAvailable()`, so a developer without docker running gets a
skip rather than a wall of connection errors:

```ts
import { testEngineAvailable } from "@mahiframework/testing";

const suite = (await testEngineAvailable("postgres")) ? describe : describe.skip;

suite("checkout on postgres", () => {
  // ...
});
```

Set `CI_STRICT_MODE=true` in the CI job that provisions the database and
an unreachable server throws instead. A skip there would report a green
run that tested nothing. It is deliberately not keyed off `CI`, which
every GitHub Actions runner sets, including jobs with no database.

## Database assertions

```ts
import {
  assertDatabaseHas,
  assertDatabaseMissing,
  assertDatabaseCount,
  assertSoftDeleted,
  assertNotSoftDeleted,
  countDatabaseRows,
  type DatabaseCriteria,
} from "@mahiframework/testing";
```

| Function | Signature | Asserts |
|---|---|---|
| `assertDatabaseHas` | `(app, table, criteria)` | At least one matching row |
| `assertDatabaseMissing` | `(app, table, criteria)` | No matching row |
| `assertDatabaseCount` | `(app, table, expected)` | The table has exactly `expected` rows **in total** |
| `assertSoftDeleted` | `(app, model \| table, criteria)` | The row is still there **and** its delete column is set |
| `assertNotSoftDeleted` | `(app, model \| table, criteria)` | The row is still there **and** its delete column is null |
| `countDatabaseRows` | `(app, table, criteria?)` | *(not an assertion)* returns the count |

`assertSoftDeleted()` exists because `assertDatabaseMissing()` cannot tell
a working soft delete from a destructive one. It passes whether the row
was soft-deleted, hard-deleted, or never written at all. This asserts both
halves.

**Pass the model, not a table name.** A bare string has to assume the
column is `deleted_at`:

```ts
await assertSoftDeleted(app, Post, { id: post.id });   // reads Post.softDeleteColumn
await assertSoftDeleted(app, "posts", { id: post.id }); // assumes deleted_at
```

A model configured with `softDeletes: { column: "archived_at" }` would be
mis-asserted by the string form, and a model that does not soft-delete at
all throws rather than silently passing.

All are `async` and take the `Application` as their first argument.
They go through `app.make<DatabaseManager>(DATABASE_TOKEN).driver().kysely`
directly rather than through the model layer.

`DatabaseCriteria` is `Record<string, unknown>`. Each key is a **column
name** (not a model attribute), and each value is matched with `=`, except
`null`, which becomes `is null`:

```ts
query = value === null ? query.where(column, "is", null) : query.where(column, "=", value);
```

That `null` handling matters. `WHERE deleted_at = NULL` matches nothing
in SQL, and getting it wrong would make every soft-delete assertion
silently pass.

The point of these is asserting **persisted state independent of what an
API response claims**, an internal column no endpoint exposes:

```ts
it("soft-deletes rather than removing the row", async () => {
  const { body } = await author.client.postJson<PostJson>("/posts", { body: "To be deleted" });

  await assertDatabaseHas(testApp.app, "posts", { id: body.id, deleted_at: null });

  const del = await author.client.deleteJson(`/posts/${body.id}`);
  expect(del.status).toBe(200);

  // The row still exists, but deleted_at is now set — a fact no API
  // response exposes, only assertable against the database directly.
  await assertDatabaseMissing(testApp.app, "posts", { id: body.id, deleted_at: null });
  await assertDatabaseHas(testApp.app, "posts", { id: body.id });
});
```

`countDatabaseRows()` is exposed separately for when a boolean
has/missing isn't enough:

```ts
expect(await countDatabaseRows(testApp.app, "posts", { user_id: author.id })).toBe(3);
```

**`assertDatabaseCount()` takes no criteria**. It counts the whole table.
For a filtered count, use `countDatabaseRows()` with an `expect()`.

Failure messages name the table and the criteria:

```
Failed asserting that table [posts] contains a row matching {"id":"42","deleted_at":null}. Found 0 matching rows.
Failed asserting that table [posts] does not contain a row matching {"id":"42"}. Found 1 matching row(s).
Failed asserting that table [posts] has 3 row(s). Found 5.
```

## Faking the queue

```ts
const testApp = await createTestApplication(bootstrap, { fakeQueue: true });
```

`FakeQueueDriver` **records** every `push()` into an in-memory array and
never executes anything. That's the difference from `SyncQueueDriver`,
which runs jobs immediately and *for real*, side effects and all. With the
fake you can assert *what would have been dispatched* without the job's
work happening.

`pop()` always returns `undefined` (nothing is ever worked), and
`release`/`delete`/`fail` are no-ops.

### Assertions

| Method | Purpose |
|---|---|
| `pushed(job?, filter?)` | Every recorded push, in dispatch order |
| `hasPushed(job, filter?)` | Boolean |
| `assertPushed(job, filter?)` | At least one push |
| `assertNotPushed(job, filter?)` | No push (or no *matching* push, with a filter) |
| `assertPushedTimes(job, times, filter?)` | Exactly `times` |
| `assertNothingPushed()` | Nothing at all |
| `reset()` | Discard recorded pushes |

```ts
testApp.queue!.assertPushed(LogPostCreatedJob);
testApp.queue!.assertNotPushed(SendWelcomeEmailJob);
testApp.queue!.assertPushedTimes(LogPostCreatedJob, 1);
expect(testApp.queue!.pushed(LogPostCreatedJob)).toHaveLength(1);
```

`assertPushedTimes()` is the assertion `assertPushed()` can't make.
"This ran once, not twice" is exactly the shape of a duplicate-dispatch
bug, and `assertNotPushed()` only covers the zero case.

### Job class or registered name

A `JobIdentifier` is either the **class** or its registered name string:

```ts
testApp.queue!.assertPushed(LogPostCreatedJob);      // preferred
testApp.queue!.assertPushed("posts:log-created");    // also works
```

**The class form is the one you want.** It's what the dispatch site says,
it survives a rename, and a typo is a compile error rather than a silently
passing `assertNotPushed()`. It requires the driver to know the
`JobRegistry` in order to map a class to its registered name;
`createTestApplication({ fakeQueue: true })` wires that up, and so does
the `"fake"` connection `QueueServiceProvider` registers. A bare
`new FakeQueueDriver()` has no registry, and passing a class to it throws
a message saying so rather than quietly matching nothing.

### Filtering on the recorded state

```ts
interface PushedJob {
  jobClass: string;
  state: JobState;
  delaySeconds: number;
  chain: ChainedJob[];
  queue: string;         // "default" unless a queue was named
  afterCommit: boolean;  // deferred until the transaction committed
}
```

`state` is the job instance's fields **as serialized**, with any `Model`
encoded to a `{ __model, __id }` reference. So a job carrying a live
model asserts against the encoded id, not the instance:

```ts
testApp.queue!.assertPushed(
  "posts:log-created",
  (job) => (job.state as { post: { __id: string } }).post.__id === body.id,
);
```

`delaySeconds` is `0` for an undelayed dispatch, so a delayed job is
assertable:

```ts
testApp.queue!.assertPushed(SendReminderJob, (job) => job.delaySeconds === 3600);
```

`chain` carries the remaining links, for asserting a chained dispatch.

See [Queues](../queues/) for jobs, chains, and middleware.

### Testing that a job actually works

The fake proves the *dispatch*. To prove the *job*, run it, either
construct and `handle()` it directly, or dispatch on the sync connection
without the fake:

```ts
const testApp = await createTestApplication(bootstrap);   // no fakeQueue
const manager = testApp.app.make<QueueManager>(QUEUE_TOKEN);

// The sync driver runs inline, so this resolving is end-to-end proof.
await expect(manager.dispatch(new LogPostCreatedJob(post))).resolves.toBeUndefined();
```

That path also exercises model serialization, a job carrying a live model
is encoded on dispatch and rehydrated to a **freshly loaded** instance
before `handle()` runs:

```ts
await manager.dispatch(new CaptureUserJob(user));

expect(received).not.toBe(user);        // a new instance, not the same object
expect(received!.id).toBe(user.id);
```

## Faking events

```ts
const testApp = await createTestApplication(bootstrap, { fakeEvents: true });
```

`RecordingEventDispatcher` extends `EventDispatcher` and overrides
`dispatch()` to record and return. No listener, queued listener, or
`afterDispatch()` callback runs, including broadcasting and auditing.

This is the crucial difference from `Event.suppress()`, which also stops
listeners but **records nothing**. With a recorder, a test can prove code
*tried* to dispatch `PostCreated` without any of its side effects
happening.

| Method | Purpose |
|---|---|
| `dispatched(eventClass?, filter?)` | Every recorded event of that class, in order |
| `hasDispatched(eventClass, filter?)` | Boolean |
| `assertDispatched(eventClass, filter?)` | At least one |
| `assertNotDispatched(eventClass, filter?)` | None (or no *matching* one) |
| `assertDispatchedTimes(eventClass, times, filter?)` | Exactly `times` |
| `assertNothingDispatched()` | Nothing at all |
| `reset()` | Discard recorded events |

The filter receives the **live event instance**, so you assert on its real
properties, no serialization in the way:

```ts
await author.client.postJson<PostJson>("/posts", { body: "Faked events" });

testApp.events!.assertDispatched(PostCreated, (e) => e.post.body === "Faked events");
expect(testApp.events!.dispatched(PostCreated)).toHaveLength(1);
```

Class matching is `instanceof`, so a subclass of a recorded event matches
its parent.

One behaviour worth knowing: **events matching an active
`Event.suppress()` pattern are neither recorded nor run**, even under the
fake:

```ts
override async dispatch<E extends AbstractEvent>(event: E): Promise<void> {
  if (AbstractEvent.isSuppressed(event.eventName)) return;
  this.recorded.push(event);
}
```

That keeps `suppress()` meaning "as if never dispatched" rather than "runs
no listeners but still shows up in assertions".

Listener registration still works normally, `listen()` and
`afterDispatch()` are inherited and record their registrations, so
provider boot wiring doesn't throw. They simply never fire.

See [Events](../events/).

## Faking mail

```ts
const testApp = await createTestApplication(bootstrap, { fakeMail: true });
```

`RecordingMailManager` extends `MailManager` and overrides `send()` to
record the `Mailable` and deliver nothing. No transport is resolved,
nothing leaves the process. Because a transport only ever sees the
flattened `RenderedMail` (the `Mailable` class is lost at that boundary),
the fake intercepts at `send(mailable)` and keeps the actual `Mailable`
instances, so you can assert **by class** and filter on the live instance:

```ts
await author.client.postJson("/auth/register", { email, password, name });

testApp.mail!.assertSent(WelcomeMailable);
testApp.mail!.assertSent(WelcomeMailable, (m) => m.envelope().to[0]?.address === email);
testApp.mail!.assertNotSent(PasswordResetMailable);
```

| Method | Purpose |
|---|---|
| `sent(mailable?, filter?)` | Every recorded mailable of that class, in order |
| `hasSent(mailable, filter?)` | Boolean |
| `assertSent(mailable, filter?)` | At least one |
| `assertNotSent(mailable, filter?)` | None (or no *matching* one) |
| `assertSentTimes(mailable, times, filter?)` | Exactly `times` |
| `assertNothingSent()` | Nothing at all |
| `reset()` | Discard recorded mailables |

The recorder is bound with `app.instance(MAIL_TOKEN, mail)`, so the `Mail`
facade, a controller injecting `MailManager`, and the notification `mail`
channel all resolve it. Class matching is `instanceof`. See [Mail](../mail/).

## Faking notifications

```ts
const testApp = await createTestApplication(bootstrap, { fakeNotifications: true });
```

`RecordingChannelManager` extends `ChannelManager` and overrides `send()`
to record the `(notifiable, notification)` pair and skip the channel
fan-out, no mail, no `notifications` table row, no broadcast. It keeps
both halves so you assert the notification class **and** its target
together:

```ts
await orderService.markPaid(order);

testApp.notifications!.assertSentTo(order.customer, InvoicePaid);
testApp.notifications!.assertSentTo(order.customer, InvoicePaid, (n) => n.invoiceId === invoice.id);
testApp.notifications!.assertNotSentTo(otherUser, InvoicePaid);
```

| Method | Purpose |
|---|---|
| `sentTo(notifiable, notification, filter?)` | Every recorded notification of that class for that notifiable |
| `hasSentTo(notifiable, notification, filter?)` | Boolean |
| `assertSentTo(notifiable, notification, filter?)` | At least one |
| `assertNotSentTo(notifiable, notification, filter?)` | None (or no *matching* one) |
| `assertSentToTimes(notifiable, notification, times, filter?)` | Exactly `times` |
| `assertNothingSent()` | Nothing at all |
| `reset()` | Discard recorded notifications |

The notifiable is matched by **identity** (`===`), so assert against the
same object you sent to. Class matching is `instanceof`. See
[Notifications](../notifications/).

## Faking storage

```ts
const testApp = await createTestApplication(bootstrap, { fakeStorage: ["public"] });
// or fakeStorage: true for just the default disk
```

Each named disk is swapped for a `FakeStorageDriver`, a real
`LocalStorageDriver` rooted at a fresh temp directory, so writes under
test never touch the app's configured disk roots, and `cleanup()` removes
each temp dir. The fakes are returned on `testApp.storage`, keyed by disk
name, with `assertExists`/`assertMissing` helpers:

```ts
await author.client.postJson("/avatars", { /* ... */ });

await testApp.storage.public!.assertExists(`avatars/${author.id}.png`);
await testApp.storage.public!.assertMissing("avatars/other.png");
```

The swap goes through `StorageManager.swap()` (the storage analogue of
`QueueManager.swap()`), so `Storage.put(...)`, `Storage.disk("public")`,
and an injected `StorageManager` all hit the fake. See [Storage](../storage/).

## Faking the cache

```ts
const testApp = await createTestApplication(bootstrap, { fakeCache: true });
```

Points the cache's **default** store at a fresh in-memory `ArrayCacheStore`
with its sweep timer disabled, full per-test isolation, and no interval
keeping the event loop alive after the run. Functionally the array store
already works in tests; `fakeCache` is the symmetry helper that guarantees
a clean, isolated store regardless of what `cache.default` is configured
to. It goes through `CacheManager.swap()`, so the `Cache` facade and an
injected `CacheManager` both see it.

## Faking processes

```ts
import { Process, makeProcessResult } from "@mahiframework/process";

beforeEach(() => {
  Process.fake({
    "git rev-parse *": makeProcessResult("git rev-parse HEAD", 0, "abc123\n", ""),
    "npm run build": makeProcessResult("npm run build", 0, "", ""),
  });
});

afterEach(() => Process.restore());

it("records the deployed commit", async () => {
  await deploy();
  Process.assertRan("git rev-parse *");
  Process.assertNotRan("rm *");
});
```

Keys are `*`-wildcard patterns matched against the joined command string;
the first match wins. A handler is a fixed `ProcessResult` or a function
of the command string. An **unmatched** command resolves with a generic
success and empty output rather than throwing, so `Process.fake()` with no
arguments stubs out every command.

Two things to remember. `Process.ran()` records **real** runs too. The
history is appended on every `run()` call whether faked or not. And it's
module-level static state, so `Process.restore()` in an `afterEach` is not
optional; without it, fake handlers and command history leak into the next
test.

See [Helpers](../helpers/#mahiprocess).

## Faking HTTP requests

```ts
import { Http } from "@mahiframework/http-client";

afterEach(() => Http.restore());

it("creates the customer remotely", async () => {
  Http.fake({
    "api.stripe.com/v1/customers": { id: "cus_123" },
    "api.stripe.com/*": 404,
  });

  await registerCustomer({ email: "ada@example.com" });

  Http.assertSent("api.stripe.com/v1/customers");
  Http.assertSent((request) => (request.data() as { email: string }).email === "ada@example.com");
  Http.assertSentCount(1);
});
```

Keys are `*`-wildcard patterns with an implicit leading `*`, so
`"api.stripe.com/*"` matches `https://api.stripe.com/v1/charges` without
spelling out the scheme. First match wins. A value can be an object (JSON
body), a string (raw body), a number (status code), an explicit
`{ body, status, headers }`, a handler function, or a `Http.sequence()`.

**An unmatched request raises `StrayRequestError`. It never reaches the
network.** This is the one place the client deliberately diverges from
Laravel, which falls through to the real handler and so turns a typo'd
pattern into a live call from your test suite. Failing loudly costs one
clear error message; failing silently costs a flaky, internet-dependent
test you debug later. `Http.allowStrayRequests()` restores Laravel's
behaviour if you want it.

A handler that returns `undefined` **declines**, falling through to the
next stub, useful for stubbing one shape of request and leaving the rest:

```ts
Http.fake({
  "api.example.com/*": (request) =>
    request.method === "POST" ? { created: true } : undefined,
  "*": { fallback: true },
});
```

`Http.sequence()` queues responses FIFO, which is how you test retries:

```ts
Http.fake({
  "api.example.com/*": Http.sequence()
    .pushStatus(500)
    .pushStatus(500)
    .push({ ok: true }),
});

const response = await Http.retry(3, 100).get("https://api.example.com/thing");
expect(response.json("ok")).toBe(true);
```

Assertions throw plain `Error`s, so they work in any runner:
`assertSent`, `assertNotSent`, `assertSentInOrder`, `assertSentCount`,
`assertNothingSent`, and `assertSequencesAreEmpty`. `Http.recorded()`
returns the raw `[request, response]` pairs when you need something the
assertions don't cover, including requests that matched no stub, which is
what you want when debugging why a pattern missed.

Like `Process`, this is module-level static state: `Http.restore()` in an
`afterEach` is not optional.

See [HTTP client](../http-client/).

## Faking the terminal

```ts
import { Tui } from "@mahiframework/tui";

it("prompts for an environment", async () => {
  const fake = Tui.fake(["\u001b[B", "\r"]);   // down arrow, enter
  try {
    await new DeployCommand(app).handle({});
    expect(fake.strippedOutput()).toContain("Deploying to staging");
  } finally {
    fake.restore();
  }
});
```

`Tui.fake(keys)` swaps in a `BufferedOutput` and a `FakeTerminal` that
yields the given keypresses instead of reading real stdin, and forces
`Tui.interactive(true)` so `ask()`/`select()` take the interactive code
path under a non-TTY test runner. It also stubs the cancel handler (so a
Ctrl-C key doesn't kill the test process) and pins the terminal to 80×24
so box and table alignment is deterministic.

The returned handle:

| Method | Returns |
|---|---|
| `output()` | Raw captured output, including ANSI escapes |
| `strippedOutput()` | The same with escapes removed, assert against this |
| `restore()` | Undo the fake |

**One `FakeTerminal` is shared for the whole `fake()` session**, so
`ask()` followed by `select()` in the same test draws from the same key
queue in order.

`Tui.interactive(value)` is available on its own when you only need to
force (or clear) the TTY-detection result.

See [Console](../console/) for testing commands end to end.

## Testing HTTP

```ts
it("registers a user and returns a usable token", async () => {
  const email = `new-${randomUUID()}@example.com`;

  const { status, body } = await client.postJson<{ user: { email: string }; token: string }>(
    "/auth/register",
    { name: "Ada", email, password: "correct-horse-battery" },
    { headers: freshIp() },
  );

  expect(status).toBe(201);
  expect(body.user.email).toBe(email);
  expect(body.token).toContain("|");

  const me = await clientFor(testApp, body.token).client.getJson<{ email: string }>("/auth/me");
  expect(me.status).toBe(200);
  expect(me.body.email).toBe(email);
});
```

A few patterns worth stealing:

**Assert on what must *not* be there.** A serialization test is more
useful stated negatively:

```ts
it("never returns the password hash", async () => {
  const { body } = await client.postJson<Record<string, unknown>>("/auth/register", { /* ... */ });
  expect(JSON.stringify(body)).not.toContain("$argon2");
});
```

That catches a leak through *any* field name, including one added later.

**Use the raw `request()` for status-only checks**, where there may be no
JSON body:

```ts
const response = await testApp.request("/auth/me");
expect(response.status).toBe(401);
```

**Prove the whole round trip**, not just the response. Register, then use
the token; log out, then confirm the token is dead:

```ts
const loggedOut = await user.request("/auth/logout", { method: "POST" });
expect(loggedOut.status).toBe(200);

const after = await user.request("/auth/me");
expect(after.status).toBe(401);
```

See [Requests](../requests/), [Responses](../responses/), and
[Validation](../validation/), a 422 body carries the field-keyed messages
you can assert against.

## Testing models

Models work normally against the test database. They're the same classes
production uses:

```ts
import { Post } from "../src/models/post.model.js";

it("post.relations.author() resolves the owning user via belongsTo", async () => {
  const created = await alice.client.postJson<{ id: string }>("/posts", { body: "Whose post?" });
  const post = await Post.findOrFail(created.body.id);

  const author = await post.relations.author().first();
  expect(author?.id).toBe(alice.id);
});
```

Two approaches, and they compose:

**Create through the API, assert through the model.** This proves the
controller, the form request, and the model layer together, and it's what
the example above does.

**Create through the model, assert through the API.** Faster for setting
up state that has no endpoint, and it's how you test read paths against
data you fully control:

```ts
const post = await Post.create({ id: "log-post-1", user_id: alice.id, parent_id: null, body: "hi", deleted_at: null });
const { body } = await client.getJson<PostJson>(`/posts/${post.id}`);
```

Factories are the third option and usually the best for bulk fixtures.
See [Migrations](../migrations/#factories).

For anything the model layer hides (a soft-delete marker, a counter
column, an internal flag), drop to
[`assertDatabaseHas`](#database-assertions).

## Testing jobs, events, and the scheduler

Registration itself is worth asserting, because a provider hook that
silently doesn't run is invisible until production:

```ts
it("registers posts:log-created via PostsServiceProvider's jobs() hook", () => {
  const registry = testApp.app.make<JobRegistry>(JOB_REGISTRY_TOKEN);
  expect(registry.has("posts:log-created")).toBe(true);
});
```

Scheduled tasks are testable without waiting for a clock. `isDueAt()`
takes a `Date`, and `run()` takes the app:

```ts
const schedule = testApp.app.make<Schedule>(SCHEDULE_TOKEN);
const task = schedule.all().find((t) => t.getDescription() === "auth-gc")!;

expect(task.getCronExpression()).toBe("0 0 * * *");
expect(task.isDueAt(new Date(2026, 0, 1, 0, 0))).toBe(true);
expect(task.isDueAt(new Date(2026, 0, 1, 12, 0))).toBe(false);

await expect(task.run(testApp.app)).resolves.toBeUndefined();
```

Three separate assertions, deliberately: the cron expression is the
declaration, `isDueAt()` is the schedule logic, and `run()` is the task
body against a real database. See [Scheduling](../scheduling/).

Jobs registered inside a test need adding to the registry first:

```ts
class CaptureUserJob extends Job {
  constructor(public readonly user: User) { super(); }
  handle(): void { received = this.user; }
}

testApp.app.make<JobRegistry>(JOB_REGISTRY_TOKEN).register("test:capture-user", CaptureUserJob);
await testApp.app.make<QueueManager>(QUEUE_TOKEN).dispatch(new CaptureUserJob(user));
```

## Freezing time

```ts
import { DateTime } from "@mahiframework/datetime";

afterEach(() => DateTime.setTestNow(null));

it("expires a token after seven days", async () => {
  DateTime.setTestNow("2026-08-20T12:00:00Z");
  const token = await issueToken(user);

  DateTime.setTestNow("2026-08-28T12:00:00Z");
  expect(await tokenIsValid(token)).toBe(false);
});
```

`DateTime.setTestNow()` freezes everything that reads the current time
through one code path, so `now`, `today`, `isPast`, and `diffForHumans`
freeze together, and so do model timestamps, token expiries, and queue
stamps, since they all go through `DateTime.now("UTC")`.

It's process-wide static state; release it in an `afterEach`. See
[Dates & times](../datetime/#the-test-clock).

## Testing without HTTP

`createTestApplication()` doesn't require an HTTP kernel. A package or a
subsystem test can boot a minimal application with just the providers it
needs:

```ts
async function bootstrapFixtureApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", { default: "sqlite", connections: { sqlite: { filename: process.env.DB_FILENAME! } } });
  app.register(DatabaseServiceProvider);
  app.register(WidgetsProvider);
  await app.bootstrap();
  return app;
}

const testApp = await createTestApplication(bootstrapFixtureApp);
```

A provider's `migrations()` hook supplies its own migration directory, so
fixture schema comes along with the fixture provider. `request()` throws
if you call it; everything else works.

That fixture only knows SQLite, so `{ database: "postgres" }` or
`MAHI_TEST_ENGINE` would have no connection to select. To run it on
every engine, configure it the way the template does: read
`DB_CONNECTION` for the default and declare `sqlite`, `mysql` and `pgsql`
connections from the `DB_*` variables.

## Gotchas

**`cleanup()` is not optional.** Without it, `mkdtemp` directories
accumulate in `$TMPDIR` across runs, the sqlite handle or server pool
stays open, a scratch MySQL/Postgres database is left on the server, and
`DB_FILENAME`/`DB_*` are left pointing at it for every test file that
runs after it in the same worker. `afterAll(() => testApp.cleanup())`.

**The application is unusable after `cleanup()`.** It has been
terminated: its connections are closed and `app()` no longer resolves it.
Create a new one rather than reviving it.

**Clean up in reverse.** If a file creates two test applications, clean
the second up before the first, `terminate()` restores the global
`app()` and env keys, and unwinding in creation order restores them out
of sequence.

**One database per file by default, not per test.** Every `it()` in a file
shares state unless you call `clearDatabase()` in a `beforeEach`.

**`clearDatabase()`/`resetDatabase()` don't reset the fakes.** Call
`testApp.queue?.reset()`, `testApp.events?.reset()`,
`testApp.mail?.reset()`, and `testApp.notifications?.reset()` alongside
them.

**`clearDatabase()`/`resetDatabase()` wipe `beforeAll` fixtures.** If you
use either, create fixtures in `beforeEach` too.

**`resetDatabase()` in a `beforeEach` is slow on a server engine.** It
re-runs every migration. Use `clearDatabase()` unless the test changes
the schema.

**A server-engine test is skipped, not failed, when the server is down**,
if you gate it with `testEngineAvailable()`. Set `CI_STRICT_MODE=true`
wherever the server is supposed to be running.

**`fakeQueue`/`fakeEvents` are silent no-ops when the provider isn't
registered.** `testApp.queue` is `undefined` and `assertPushed` was never
reachable, a test that "passes" this way asserted nothing.

**Give every simulated client its own `x-forwarded-for`.** Otherwise every
request in the suite shares one rate-limiter key and failures become
order-dependent.

**There is no bare `get()`/`post()` on `TestClient`.** Everything is
`*Json`. Use `testApp.request()` for non-JSON responses, header
assertions, and `204`s.

**`assertDatabaseCount()` ignores criteria**. It counts the whole table.
Use `countDatabaseRows()` for a filtered count.

**Database assertions take column names, not model attributes**, and
`null` is translated to `is null` for you.

**`FakeQueueDriver` records the *serialized* state.** A job carrying a
model has `{ __model, __id }` in `state`, not the instance.

**Assert by job class, not by name string.** A renamed job breaks the
class form at compile time and silently un-matches the string form.

**`Process.fake()` leaks without `Process.restore()`**, and
`Process.ran()` records real runs too.

**`Tui.fake()` leaks without `restore()`**. It swaps module-level output
and stdin wiring.

**`DateTime.setTestNow()` leaks without `setTestNow(null)`.**

**`APP_KEY` is set with `??=`.** A stale `APP_KEY` in your shell
environment is used instead of a fresh one, which is fine but worth
knowing if encryption assertions behave oddly.

**`process.env.DB_FILENAME`, `DB_CONNECTION`, the other `DB_*` keys and
`NODE_ENV` are mutated globally.** Each `createTestApplication()`
overwrites them for the whole process; files
running in parallel workers are isolated by vitest's per-worker processes,
but two calls in one file leave the *last* value in `process.env`.

## Related

- [Installation](../installation/): `npm test` in a generated app
- [Console](../console/): `./artisan test`, and testing commands
- [Queues](../queues/): jobs, chains, and what `fakeQueue` records
- [Events](../events/): dispatching, listeners, and `Event.suppress()`
- [Migrations](../migrations/): factories and seeders for fixtures
- [Cache](../cache/): the rate limiter the `x-forwarded-for` trick works around
- [Dates & times](../datetime/): `DateTime.setTestNow()`
- [Helpers](../helpers/): `Process.fake()`, `Tui.fake()`
