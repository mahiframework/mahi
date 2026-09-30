# Database

`@mahiframework/database` is the whole data layer: connection management, a
query builder, an Active Record `Model`, relations, migrations,
factories, and seeders. This page covers the bottom of that stack,
connections, the `DB` facade, raw access, and transactions. The layers
above have their own pages:

- [Models](../models/): attributes, casts, events, serialization
- [Relationships](../relationships/): declaring and eager-loading
- [Queries](../queries/): the query builder in depth
- [Migrations](../migrations/): schema, seeders, factories
- [Pagination](../pagination/): the three paginators

## Configuration

`config/database.ts` returns a `DatabaseConfig`:

```ts
import path from "node:path";
import type { DatabaseConfig } from "@mahiframework/database";
import type { Env } from "./env.js";

// Resolved relative to THIS file, not `process.cwd()`: `config/` under
// source (tsx) or `dist/config/` once compiled, so it points at the
// matching `.ts` in development and the runnable `.js` in `dist/`. Using
// `database_path("migrations")` here would resolve to the source tree even
// under `node dist/bin/console.js`, which either throws
// `ERR_UNKNOWN_FILE_EXTENSION` or silently migrates nothing in production.
const migrationsPath = path.join(import.meta.dirname, "..", "database", "migrations");

export function databaseConfig(env: Env): DatabaseConfig & { migrationsPath: string } {
  return {
    default: "sqlite",
    migrationsPath,
    connections: {
      sqlite: {
        filename: env.DB_FILENAME,
      },
    },
  };
}
```

The `DatabaseConfig` interface itself is deliberately minimal:

```ts
interface DatabaseConfig {
  default: string;
  connections: Record<string, unknown>;
}
```

`connections` values are `unknown` because each driver defines its own
config shape. `SqliteDriver` takes `SqliteConnectionConfig`
(`{ filename }`), `MysqlDriver` and `PostgresDriver` take host/port/
credentials. The manager hands the raw value to the driver factory
registered under that name; the factory is where the cast happens.

A MySQL or Postgres connection is configured the same way, naming the
driver explicitly when it differs from the connection name:

```ts
connections: {
  sqlite: { filename: env.DB_FILENAME },
  mysql: {
    driver: "mysql",
    host: env.DB_HOST,
    port: 3306,
    database: env.DB_DATABASE,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
  },
  analytics: {
    driver: "postgres",
    host: env.PG_HOST,
    database: "analytics",
    username: env.PG_USERNAME,
    password: env.PG_PASSWORD,
    searchPath: "public",
  },
}
```

`migrationsPath` is not part of `DatabaseConfig`. It's an extra key the
CLI reads via `app.config.get("database.migrationsPath")`, defaulting to
`"database/migrations"`. The template resolves it relative to the running
file (`import.meta.dirname`) rather than the working directory, so a
production `node dist/bin/console.js migrate` finds the compiled
`dist/database/migrations/*.js`, the migrator prefers a `.js` over a `.ts`
sibling and warns if it discovers a `.ts` migration under a compiled
entrypoint. See [Migrations](../migrations/) and
[Deployment](../deployment/).

## DatabaseManager

`DatabaseManager` extends `@mahiframework/core`'s `Manager` and is bound as a
singleton at `DATABASE_TOKEN` by `DatabaseServiceProvider`.

| Method | Returns | Notes |
|---|---|---|
| `driver(name?)` | `DatabaseDriver` | Inherited from `Manager`. Resolves and caches. Synchronous. |
| `connection(name?)` | `DatabaseDriver` | Domain-flavoured alias for `driver()`. |
| `table(name, connection?)` | `QueryBuilder<TRow>` | A model-free query builder bound to `name`. |
| `query(connection?)` | `QueryBuilder<TRow>` | A builder with no table bound yet; call `.table(name)`. |
| `schema(name?)` | `SchemaBuilder` | `new SchemaBuilder(this.driver(name).kysely)`, a fresh builder each call. |
| `connectionConfig(name)` | `unknown` | The raw config entry for a named connection. |
| `transaction(callback, driverName?)` | `Promise<T>` | Wraps the standalone `transaction()` helper. |
| `extend(name, factory)` | `this` | Register a driver factory. Inherited from `Manager`. |
| `getDefaultDriver()` | `string` | Reads `config.default`. |

```ts
import { DatabaseManager, DATABASE_TOKEN } from "@mahiframework/database";

const db = app.make<DatabaseManager>(DATABASE_TOKEN);

db.connection();                 // the default connection
db.connection("analytics");      // a second, independently resolved connection
db.connectionConfig("sqlite");   // { filename: "database/database.sqlite" }
```

**"Default" means "the one used when you don't name one", not "the only
one."** Several named connections can be resolved and live at the same
time; `Manager` caches each independently. What is *not* supported yet is
binding a `Model` to a named non-default connection, every `Model`
currently resolves the default driver (see `Model.resolveConnection()`).
For a secondary connection, query it through `DB.table(name, "analytics")`
or drop to `DB.connection("analytics").kysely`.

### Drivers

A driver is anything with a Kysely instance on it:

```ts
interface DatabaseDriver<DB = any> extends Partial<Connectable> {
  readonly kysely: Kysely<DB>;
}
```

`Connectable` (from `@mahiframework/core`) is `{ connect(): Promise<void>;
disconnect(): Promise<void> }` and is **optional**. This is the
framework-wide "synchronous driver resolution" rule: `manager.driver()`
never returns a promise, because constructing a driver handle is cheap.
Drivers that genuinely need async warm-up implement `Connectable`, and
`DatabaseServiceProvider.boot()` calls `connect()` on the resolved default
driver if `isConnectable(driver)`.

`SqliteDriver` deliberately does **not** implement it. Better-sqlite3 is
fully synchronous and has no async API at all:

```ts
export class SqliteDriver<DB = any> implements DatabaseDriver<DB> {
  readonly kysely: Kysely<DB>;
  private readonly db: BetterSqlite3.Database;

  constructor(config: SqliteConnectionConfig) {
    this.db = new BetterSqlite3(config.filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.kysely = new Kysely<DB>({
      dialect: new SqliteDialect({ database: this.db }),
    });
  }
}
```

Two pragmas are set on every connection, and both matter:

- **`journal_mode = WAL`.** Write-ahead logging, so readers don't block
  the writer. Without it a single slow write stalls every concurrent read
  in the process. WAL creates `-wal` and `-shm` sidecar files next to the
  database file. Both are expected, both should be gitignored.
- **`foreign_keys = ON`.** SQLite does not enforce foreign keys by
  default. Without this, `onDelete("cascade")` in a migration is decorative.

`filename` may be `":memory:"` for an in-memory database that vanishes
when the process exits. This is what the test suite uses, and what you
want for a fast isolated test database:

```ts
manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
```

### Registering a driver

Built-in drivers are registered exactly the way a plugin would register
one. There is no string-to-method dispatch (`createSqliteDriver()`) and
no special-casing:

```ts
manager.extend("sqlite", () => {
  const config = manager.connectionConfig("sqlite") as SqliteConnectionConfig;
  return new SqliteDriver(config);
});
```

To add a driver of your own, call `extend()` on the resolved manager from
your provider's `register()`, then point `database.default` (or a named
connection) at it.

## Dialect support

SQLite, MySQL (8.0+, and MariaDB) and PostgreSQL (12+) are all
supported across the whole stack, schema/migrations, the query builder,
models, relations and factories. The model and query suites run against
all three, so the same application code is expected to behave identically
on each.

The engines genuinely differ in a handful of places. Everything below is
handled for you; it is listed because the differences are observable.

| Area | SQLite | MySQL | Postgres |
|---|---|---|---|
| Row locks (`lockForUpdate()`) | **No-op**: no row-level locking | `FOR UPDATE` / `FOR SHARE` | `FOR UPDATE` / `FOR SHARE` |
| Generated key read-back | `RETURNING` | `LAST_INSERT_ID()` | `RETURNING` |
| Timestamps written as | ISO-8601 | `YYYY-MM-DD HH:MM:SS.mmm` | ISO-8601 |
| Upsert | `ON CONFLICT` | `ON DUPLICATE KEY UPDATE` | `ON CONFLICT` |
| `enum` column | text | native `enum` | `varchar` + `CHECK` |
| `fullText` index | unsupported | supported | unsupported |
| `spatialIndex` | unsupported | unsupported | unsupported |
| Partial index (`where`) | supported | unsupported | supported |
| Index method (`using`) | unsupported | `btree`/`hash` | supported |
| Operator class (`opclass`) | unsupported | unsupported | supported |
| `nullsNotDistinct` | unsupported | unsupported | supported (15+) |

### Documented limitations

- **`lockForUpdate()`/`sharedLock()` do nothing on SQLite.** The clause
  is not emitted at all (the engine has no row locks and rejects the
  syntax). Code that depends on a lock for correctness needs MySQL or
  Postgres. See [Queries](../queries/#locks-are-real-on-mysqlpostgres-no-ops-on-sqlite).
- **MySQL upserts have no conflict target.** `ON DUPLICATE KEY UPDATE`
  fires for *any* unique index on the table, not only the columns passed
  as `uniqueBy`.
- **Timestamp precision defaults to milliseconds** (`timestamp(3)`),
  not Laravel's whole seconds, so values round-trip identically on all
  three engines. Pass a precision explicitly (`t.timestamp("at", 0)`)
  to change it.
- **`bigint` values beyond 2^53** are returned as strings rather than
  silently-rounded numbers. Ids inside the safe range are numbers on
  every engine.
- **Postgres `enum` columns are `varchar` + a `CHECK`**, not a native
  `CREATE TYPE` enum, so adding an allowed value is an ordinary column
  change rather than a type migration.
- **`migrate:fresh` on Postgres only drops the current schema's
  tables**, resolved from `current_schema()` / the connection's
  `searchPath`.
- **An index option the engine cannot do throws**, rather than silently
  creating a weaker index. `unique(cols, { where })` on MySQL, or
  `{ using: "gin" }` on SQLite, fails at compile time before any DDL
  runs. See [Migrations](../migrations/#blueprint-index-options).
- **`fullText()` is MySQL-only by design, and Postgres full-text is not
  yet reachable.** MySQL indexes existing columns; Postgres needs a
  stored `tsvector` column, and `Blueprint` has no `tsvector` type. The
  GIN index half works — the column type is the missing piece. Substring
  search is served by a trigram index today.

## The DB facade

`DB` is a hand-written facade over the `DatabaseManager` singleton:

| Method | Returns |
|---|---|
| `DB.table(name, connection?)` | `QueryBuilder<TRow>` |
| `DB.query(connection?)` | `QueryBuilder<TRow>` |
| `DB.connection(name?)` | `DatabaseDriver` |
| `DB.schema(name?)` | `SchemaBuilder` |
| `DB.transaction(callback, connectionName?)` | `Promise<T>` |

Plus `DB.instance()`, inherited from the `Facade` mixin, which returns the
`DatabaseManager` itself.

### `DB.table()`

The model-free entry point into the [query builder](../queries/):

```ts
import { DB } from "@mahiframework/database";

await DB.table("users").count();
await DB.table("users").where("first_name", "John").get();
await DB.table("post_hashtag").where("post_id", id).delete();
```

`TRow` defaults to `Record<string, any>`, so every column is `any` and any
column name is accepted. Supply it to get the same checking a model
builder has:

```ts
await DB.table<UserTable>("users").where("first_name", "John").get();
// where("frist_name", ...) is now a compile error, and `rows` is UserTable[]
```

This returns a plain `QueryBuilder`, the low-level, table-scoped builder.
**No models are involved**, which means no hydration into instances, no
casts, no lifecycle events, no relations (`with()`, `whereHas()`), and
**no global scopes**:

```ts
await Post.query().get();        // SoftDeletes applies — live rows only
await DB.table("posts").get();   // every row, including soft-deleted ones
```

Prefer `Model.query()` whenever a model for the table exists. `DB.table()`
is for tables that don't have one, pivots, reporting views, ad-hoc reads.

#### Connections and transactions

| Call | Connection |
|---|---|
| `DB.table("users")` | The default connection, or the transaction open **on it** |
| `DB.table("users", "analytics")` | The `analytics` connection, or the transaction open **on it** |

Either way the connection is resolved first and the transaction looked up
by it, exactly like a static `Model` call: a query inside a
`DB.transaction()` on that connection participates and rolls back with it.
Resolution is lazy. It happens when the query executes, not when the
builder is constructed, so a builder created before the transaction opens
still runs inside it.

Because the transaction context is keyed **per connection**, the two
directions both behave sensibly:

```ts
await DB.transaction(async () => {
  await DB.table("events", "analytics").insert(row);  // joins THIS transaction
  await Post.create({ ... });                         // default connection — NOT in it
}, "analytics");
```

A model bound to the default connection is untouched by a transaction on
`analytics`, and vice versa. Two connections cannot share a transaction,
so this is the only correct reading, and a rollback on `analytics` leaves
the default connection's writes alone.

### `DB.query()`

A builder with no table bound yet. Call `.table(name)` before any terminal,
or that terminal throws:

```ts
await DB.query().table("users").count();
await DB.query().get();   // Error: no table bound — call table(name)
```

`DB.table(name)` is the direct form and is what you want unless the table
genuinely isn't known at construction. Note that `QueryBuilder.table()`
returns `QueryBuilder<Record<string, any>>` rather than `this`, switching
tables invalidates the row type, so a generic passed to `DB.query()` is
discarded by the `.table()` call that follows:

```ts
DB.table<UserTable>("users");            // typed
DB.query<UserTable>().table("users");    // NOT typed — the generic is dropped
```

### Raw access

For anything the builder deliberately doesn't model, joins, window
functions, CTEs, drop to Kysely:

```ts
const rows = await DB.connection().kysely
  .selectFrom("posts")
  .innerJoin("users", "users.id", "posts.user_id")
  .select(["posts.id", "posts.body", "users.name as author_name"])
  .where("posts.deleted_at", "is", null)
  .execute();
```

See [Queries](../queries/) for the deliberate non-goals and the less
drastic escape hatches (`builder.toBase()`, `builder.raw()`,
`Expression.raw()`).

### When to use the facade at all

Prefer injecting `DatabaseManager` via `DATABASE_TOKEN` where that's
practical, inside a `ServiceProvider` or a `Command`, which already
receives `app`. `DB` exists for call sites where threading `app` through
is genuinely inconvenient, the same guidance as `app()` itself.

## Transactions

```ts
import { DB } from "@mahiframework/database";

await DB.transaction(async (trx) => {
  const post = await Post.create({ user_id: userId, body });
  await Hashtag.create({ id: tagId, name: "release" });
  await trx.insertInto("post_hashtag").values({ post_id: post.id, hashtag_id: tagId }).execute();
});
```

Three equivalent entry points, all landing in the same place:

```ts
import { transaction, DB, DatabaseManager } from "@mahiframework/database";

await transaction(kysely, callback);           // standalone, explicit connection
await db.transaction(callback, "analytics");   // DatabaseManager, resolves the driver for you
await DB.transaction(callback);                // facade over the above
```

The implementation wraps Kysely's own transaction API with an
`AsyncLocalStorage` context keyed by connection, plus a savepoint path for
nesting (see below). If the callback throws, the transaction rolls back and
the error propagates to the caller unchanged.

### Static Model calls join automatically

This is the part worth internalising. `Model.resolveConnection()` resolves
its connection and then looks up any transaction open on it:

```ts
static resolveConnection(): Kysely<any> {
  const connection = app().make<DatabaseManager>(DATABASE_TOKEN).driver().kysely;
  return getActiveTransaction(connection) ?? connection;
}
```

So every static `Model` call made anywhere inside the callback, including
inside functions the callback calls, and across `await` boundaries,
participates in the transaction, with no `.withConnection(trx)` ceremony:

```ts
await DB.transaction(async () => {
  const user = await User.create({ name, email, password: hash });
  await createDefaultBookmarks(user.id);   // nested — still in the transaction
  // if anything below throws, BOTH of the above roll back
});
```

Connection resolution happens **at execution time, not construction
time**, so a builder created outside a transaction and executed inside one
still picks up the transactional connection:

```ts
const builder = Post.query().where("user_id", userId);   // built outside

await DB.transaction(async () => {
  await builder.delete();   // executed inside — runs on the transaction
});
```

The context is keyed **by connection**, so a transaction on one connection
never captures queries bound to another. See
[Connections and transactions](#connections-and-transactions).

### After-commit callbacks

Work that must not happen unless the transaction actually commits,
dispatching a job that reads the rows being written, notifying an external
system, registers with `afterCommit()`:

```ts
import { afterCommit } from "@mahiframework/database";

await DB.transaction(async () => {
  const order = await Order.create({ ... });
  await afterCommit(() => notifyWarehouse(order.id));
});
```

The callback runs once, after the outermost commit, with the data visible
to every other connection. If the transaction rolls back it never runs at
all, `afterRollback()` callbacks run instead.

| | Behaviour |
|---|---|
| No transaction open | Runs immediately, and `afterCommit()` awaits it. |
| Committed | Runs once, after the commit, in registration order. |
| Rolled back | Never runs. |
| Registered in a nested `transaction()` | Waits for the **outermost** commit. A released savepoint isn't durable. |
| Registered in a savepoint that rolls back | Discarded; the enclosing transaction's callbacks are untouched. |
| A callback throws | Logged; the remaining callbacks still run. The commit can't be undone. |

`afterCommitOn(connection, cb)` is the same thing scoped to one
connection, for code that knows which connection its work is on, a
transaction open on a *different* connection is then correctly ignored.

The queue builds on this: `Bus.dispatch(job, { afterCommit: true })` holds
the push until commit, which is what removes the "worker popped the job
before the row it references was committed" race. See
[Queues](../queues/#dispatching-inside-a-transaction).

### After-commit dispatch for events, jobs, mail & notifications

By default an event, job, mail, or notification dispatched **inside** a
transaction fires immediately, so one dispatched inside a `transaction()`
callback that later rolls back has already notified every listener, and a
job can be popped by a worker before the rows it references are committed.
Each producer can opt into deferring that work until the transaction
commits (and dropping it on rollback), with no change at the dispatch site:

| Producer | Opt in with | Explicit per-call form |
|---|---|---|
| Events | `static shouldDispatchAfterCommit = true` on the event class | `Events.dispatchAfterCommit(event)` |
| Model events | `static dispatchesEventsAfterCommit = true` on the `Model` (defers `created`/`updated`/`saved`/`deleted`/`restored`, the `-ing` hooks still run inline) | — |
| Jobs | `afterCommit = true` on the `Job`, or connection config `afterCommit: true` | `Bus.dispatch(job, { afterCommit: true })` |
| Mail | `afterCommit()` on the `Mailable`, or mail config `afterCommit: true` | — |
| Notifications | `afterCommit()` on the `Notification` | — |
| Broadcasting | `static broadcastAfterCommit = true` (or the `ShouldBroadcastAfterCommit` marker) on the event | — |

All of these are built on `afterCommit()` above, so they share its rules:
run once after the outermost commit, dropped on rollback, hoisted out of
nested savepoints. Outside a transaction they dispatch immediately, so
marking a class costs nothing when there is no transaction open.

```ts
class OrderPlaced extends AbstractEvent {
  static shouldDispatchAfterCommit = true;
  constructor(public readonly order: Order) { super(); }
}

await DB.transaction(async () => {
  const order = await Order.create({ ... });
  await Events.dispatch(new OrderPlaced(order));   // held until commit
});
```

If you'd rather not mark the class, the same three manual patterns still
work, defer with `afterCommit()`, dispatch after the transaction
resolves, or suppress model events inside and fire your own afterwards:

```ts
// 1. Defer explicitly, keeping the write and announcement in one block:
await DB.transaction(async () => {
  const post = await Post.create({ user_id, body });
  await afterCommit(() => Events.dispatch(new PostPublished(post)));
});

// 2. Dispatch after the transaction resolves:
const post = await DB.transaction(async () => Post.create({ user_id, body }));
await Events.dispatch(new PostPublished(post));

// 3. Suppress model events inside, fire your own afterwards:
const created = await DB.transaction(() =>
  Post.withoutEvents(() => Post.create({ user_id, body })),
);
```

Accept the immediate default only when at-least-once-even-on-rollback is
genuinely what you want.

### The other footgun: fire-and-forget work escapes the transaction

The `AsyncLocalStorage` context follows the async call stack, so a promise
**created but not awaited** inside the callback inherits the transaction.
And can run its query after that transaction has committed and handed its
connection back to the pool:

```ts
await DB.transaction(async () => {
  await Post.create({ ... });
  void auditLog.record(userId);   // ✗ not awaited
});
// `auditLog.record()` may now be querying a pooled connection that has
// already moved on to someone else's work.
```

On MySQL/Postgres that means executing on a connection doing unrelated
work; on SQLite it means a query against a transaction that no longer
exists. Await everything you start inside the callback, or start it after
the transaction resolves:

```ts
await DB.transaction(async () => {
  await Post.create({ ... });
});
void auditLog.record(userId);   // ✓ outside — runs on the normal connection
```

### Nested transactions

Calling `transaction()` while one is already open **on the same
connection** does not open a second one. The inner call runs inside a
`SAVEPOINT`, matching Laravel's "transaction level" semantics. This is what
makes the ordinary service-layer pattern safe:

```ts
// OrderService.place() wraps itself...
async place(order) {
  return DB.transaction(async () => { ... });
}

// ...and is also called from a controller that wraps a batch:
await DB.transaction(async () => {
  for (const order of orders) await orderService.place(order);
});
```

Two rules follow from the savepoint model:

- **An inner rollback undoes only the inner work.** If the inner callback
  throws and the *caller* catches it, the outer transaction is still
  usable.

  ```ts
  await DB.transaction(async () => {
    await Post.create({ id: "1", ... });

    try {
      await DB.transaction(async () => {
        await Post.create({ id: "2", ... });
        throw new Error("boom");     // rolls back to the savepoint
      });
    } catch { /* recovered */ }

    await Post.create({ id: "3", ... });   // still works
  });
  // rows 1 and 3 exist; row 2 does not
  ```

- **An outer rollback undoes everything, inner work included.** A nested
  `transaction()` resolving is *not* durable on its own, only the
  outermost commit is.

Nesting is per-connection. A `transaction()` on a *different* connection
opens a real, independent transaction (it has to, two connections can't
share a savepoint), and both stay reachable to the models bound to them.

Without this, the inner call either deadlocked (SQLite, whose single
connection is already held by the outer transaction) or took a **second
pooled connection and committed independently** (MySQL/Postgres), so an
outer rollback would leave the inner writes behind, and deep nesting under
load exhausted the pool.

## Service provider hooks

`DatabaseServiceProvider` collects three hooks from every registered
provider. Declare them on your own provider and the framework wires the
rest. See [Service providers](../providers/).

### `migrations(): string`

Returns an **absolute** path to a directory of migration files this
provider contributes. Collected by `migrate`, `migrate:fresh`,
`migrate:refresh`, `migrate:rollback` and `migrate:status` alongside the
app's own `database/migrations`:

```ts
export class BillingServiceProvider extends ServiceProvider {
  migrations(): string {
    return fileURLToPath(new URL("../database/migrations", import.meta.url));
  }
}
```

This is how `@mahiframework/auth`, `@mahiframework/queue` and `@mahiframework/notifications` ship
their own tables (`personal_access_tokens`, `sessions`, `jobs`,
`notifications`, …) without anything being copied into your app.

### `seeders(): Array<new (app: Application) => Seeder>`

Seeder classes to run, in provider registration order, when `db:seed`
runs:

```ts
seeders() {
  return [DatabaseSeeder];
}
```

### `models(): Array<typeof Model>`

Model classes this provider makes serializable inside queued job
payloads. Each must declare a `static morphName`. Collected during
`DatabaseServiceProvider.boot()` into the `ModelRegistry`, so a worker
process, which may never have imported the model directly, can rehydrate
a `{ __model, __id }` reference:

```ts
models(): Array<typeof Model> {
  return [User, Post];
}
```

Registering a class with no `morphName` throws, as does registering two
different classes under the same `morphName`. Registering the same class
twice is a harmless no-op, so a model listed by two providers doesn't
error. See [Queues](../queues/).

## What DatabaseServiceProvider binds

| Token | Bound as | Value |
|---|---|---|
| `DATABASE_TOKEN` (`@mahiframework/core`) | singleton | `DatabaseManager`, with `"sqlite"` pre-registered |
| `SCHEMA_TOKEN` (`"db.schema"`) | binding | `manager.schema()`, a fresh `SchemaBuilder` per resolve |
| `MODEL_REGISTRY_TOKEN` (`"db.models"`) | singleton | `ModelRegistry` |

`DATABASE_TOKEN`'s canonical definition lives in `@mahiframework/core`'s
well-known tokens (the CLI's migration commands and the queue's database
driver resolve it cross-package) and is re-exported from
`@mahiframework/database` so this package's public API is unchanged.

On `boot()`, the provider also:

1. Collects every provider's `models()` into the `ModelRegistry`.
2. Connects the default driver if it implements `Connectable`.
3. Registers the `exists` / `unique` presence resolver with
   `@mahiframework/validation`, so those rules work in jobs and CLI commands
   without an HTTP request in flight. See [Validation](../validation/).

## Testing against a database

Point the connection at `":memory:"` and build the schema in
`beforeEach`:

```ts
const app = new Application();
const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
app.instance(DATABASE_TOKEN, manager);
setCurrentApp(app);
```

`setCurrentApp()` matters because static `Model` access resolves its
connection through the global `app()` lookup, the one deliberate piece of
magic the framework allows, and the reason `app.bootstrap()` must have run
before any static `Model` method is called. See [Testing](../testing/) for
the higher-level `TestApplication` that does all of this for you.
