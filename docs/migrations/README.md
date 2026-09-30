# Migrations

Migrations are schema changes as versioned, ordered files. Seeders
populate a database with fixed data. Factories generate realistic rows on
demand for tests and seeders. All three live in `@mahiframework/database`.

```bash
./artisan make:migration create_posts_table
./artisan migrate
./artisan migrate:status
```

## Where migrations live

Two sources, both collected on every migration command:

1. **The app's own migrations**: the `database/migrations` directory by
   default, configurable via the `database.migrationsPath` config key, or
   a static list under `database.migrationSources` (see
   [Static migration sources](#static-migration-sources)).
2. **Every registered provider's migrations**: via its
   `migrationSources()` hook, or its `migrations()` hook returning an
   absolute directory path.

```ts
export function collectMigrationSources(app: Application): MigrationSource[] {
  const sources: MigrationSource[] = [];

  const appSources = app.config.get<RegisteredMigration[] | undefined>(
    "database.migrationSources",
    undefined,
  );

  if (appSources && appSources.length > 0) {
    sources.push(...appSources);
  } else {
    sources.push(app.config.get<string>("database.migrationsPath", "database/migrations"));
  }

  for (const provider of app.getProviders()) {
    const registered = provider.migrationSources?.();
    if (registered && registered.length > 0) {
      sources.push(...registered);
      continue;
    }

    const dir = provider.migrations?.();
    if (dir) sources.push(dir);
  }

  return sources;
}
```

This is how `@mahiframework/auth` ships `personal_access_tokens`, `sessions` and
`password_reset_tokens`, `@mahiframework/queue` ships `jobs` and `failed_jobs`, and
`@mahiframework/notifications` ships `notifications`, none of them are copied into
your app, and all of them run alongside your own.

To contribute a directory from your own package or provider:

```ts
export class BillingServiceProvider extends ServiceProvider {
  migrations(): string {
    return fileURLToPath(new URL("../database/migrations", import.meta.url));
  }
}
```

Return an **absolute** path. A published package should point at its
compiled `dist/`, not `src/`, the discovery filter handles that (it
excludes `.d.ts` explicitly, which matters when `.js` and `.d.ts` sit side
by side).

Only files matching `{digits}{_ or -}{name}.{ts,js,mts,mjs,cts,cjs}` are
imported. A `helpers.ts` of shared blueprint code or an `index.ts`
re-export can sit in the same directory without being run as a migration
under its own filename.

Migrations from **all** sources are merged and sorted by name **byte-wise**
(not `localeCompare`, which is locale-dependent, under ICU it ignores
punctuation, so `2024_01_01_a` and `2024-01-01-a` collate as *equal* and
their relative order varies by machine). A provider's migration and yours
therefore interleave by timestamp, identically on a laptop, in CI and in
production. Name yours with a later timestamp than anything they depend
on. Names are deduplicated across sources, first occurrence winning, so a
directory and a static registry that overlap do not run anything twice.

## Static migration sources

Directory discovery is `readdir` plus a dynamic `import()` of the file it
finds. Neither survives bundling: a single-file executable has no
`database/migrations` directory to read and no path to import. Worse, the
runner treats an unreadable directory as *nothing to discover* rather than
an error, so a compiled app prints **"Nothing to migrate"** and then
happily runs against an empty database.

An app or package that intends to be compiled supplies its migrations
explicitly instead. A `RegisteredMigration` is just a name paired with the
migration itself:

```ts
// database/registry.ts
import type { RegisteredMigration } from "@mahiframework/database";
import createPostsTable from "./migrations/2026_01_01_000000_create_posts_table.js";

export const MIGRATIONS: RegisteredMigration[] = [
  { name: "2026_01_01_000000_create_posts_table", migration: createPostsTable },
];
```

```ts
// config/database.ts
import { MIGRATIONS } from "../database/registry.js";

export function databaseConfig(env: Env) {
  return {
    default: "sqlite",
    migrationSources: MIGRATIONS,
    connections: { sqlite: { filename: env.DB_FILENAME } },
  };
}
```

A provider does the same through `migrationSources()`:

```ts
export class BillingServiceProvider extends ServiceProvider {
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_invoices_table", migration: createInvoicesTable }];
  }
}
```

`@mahiframework/auth`, `@mahiframework/queue` and `@mahiframework/notifications` all do this, so a
bundled app gets their tables without any filesystem access. They still
implement `migrations()` too, for older consumers; when a provider has
both, `migrationSources()` wins.

**`name` is the compatibility surface.** It is what lands in the
`migrations` table and what orders execution, so keep it byte-identical to
the filename-without-extension the directory form produced. Change it and
every existing database re-runs that migration against tables that already
exist.

The two forms mix freely. An app can keep `migrationsPath` for its own
migrations while consuming providers that register statically, or pass
both during a migration to the static form.

## Writing a migration

A migration is a default-exported object with `up()` and `down()`:

```ts
export interface Migration {
  up(): Promise<void>;
  down(): Promise<void>;
}
```

```ts
import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("posts", (table: Blueprint) => {
      table.string("id").primary();
      table.string("user_id").index();
      table.string("parent_id").nullable().index();
      table.text("body");
      table.timestamp("created_at");
      table.timestamp("updated_at");
      table.softDeletes();
    });
  },

  async down(): Promise<void> {
    await Schema.drop("posts");
  },
};

export default migration;
```

The discovery loader accepts `mod.default ?? mod`, so a module exporting
`up`/`down` as named exports also works, but the default export is the
convention every generator and every shipped migration uses.

The filename **without its extension** is the unique id and the ordering
key. `make:migration` prefixes a `YYYYMMDDHHmmss` timestamp; the shipped
app migrations use a `2026_01_03_000000_` style. Either sorts correctly,
just be consistent within a directory.

Multiple statements in one migration are fine, and order matters for
foreign keys:

```ts
async up(): Promise<void> {
  await Schema.create("hashtags", (table: Blueprint) => {
    table.string("id").primary();
    table.string("name").unique();
    table.timestamp("created_at");
  });

  await Schema.create("post_hashtag", (table: Blueprint) => {
    table.string("post_id");
    table.string("hashtag_id").index();
    table.primary(["post_id", "hashtag_id"]);
  });
},

async down(): Promise<void> {
  await Schema.drop("post_hashtag");   // reverse order
  await Schema.drop("hashtags");
},
```

## Atomicity and the migration lock

**Each migration runs in its own transaction**, together with the
`migrations` row recording it, on SQLite and Postgres, which have
transactional DDL. A migration that throws halfway therefore undoes its
own tables and columns and records nothing, so the next run retries it
cleanly rather than skipping work that never happened (or re-running DDL
against a schema that already has it).

**MySQL is the exception.** Every `CREATE`/`ALTER TABLE` there causes an
implicit commit, so a transaction around a migration would look atomic
without being it. Rather than pretend, MySQL runs each migration
unwrapped. A failed migration leaves partial DDL to clean up by hand,
exactly as it does in Laravel.

Migrations within one run are *separately* atomic, not collectively: if
the third of four fails, the first two stay applied and recorded. That's
the useful granularity, re-running picks up where it stopped.

**A run holds a lock** for its duration, in a `migrations_lock` table with
a single fixed-id row. Two `migrate` processes racing (a deploy starting
two app instances, a CI job overlapping a manual run) would otherwise both
read the same pending list and the same `max(batch)`, then both run
everything, the loser's DDL failing halfway and leaving the schema in a
state neither process's `migrations` rows describe.

The second process gets a clear error instead:

```
Another migration run holds the lock (acquired by pid:4821 at
2026-01-04T09:12:44.001Z). Wait for it to finish, or — if that process
died mid-run — inspect the schema and clear it with:
delete from "migrations_lock".
```

The lock is released on success *and* on failure. A hard crash (SIGKILL,
a lost host) leaves the row behind and the next run refuses to start,
deliberately the safer failure: a stale lock costs one manual `DELETE`,
while a lock that vanished with a dead connection costs a corrupted
schema.

## The `migrations` table

Tracking lives in a table the runner creates on demand:

```ts
await schema.create("migrations", (table) => {
  table.id();
  table.string("name").unique();
  table.integer("batch");
  table.timestamp("migrated_at");
});
```

| Column | Meaning |
|---|---|
| `id` | Auto-increment surrogate key. |
| `name` | Filename without extension. Unique. |
| `batch` | Which `migrate` run applied it. |
| `migrated_at` | UTC ISO-8601 timestamp. |

`ensureMigrationsTable()` runs at the start of `up()`, `rollback()` and
`status()` and no-ops if the table exists. `migrations_lock` (see
[Atomicity and the migration lock](#atomicity-and-the-migration-lock)) is
created the same way, and is empty except while a run is in progress.

**Batches** are how rollback knows what to undo. Every migration applied
by a single `migrate` run gets the same batch number, computed as
`max(batch) + 1`. `migrate:rollback` undoes exactly the highest batch, so
if you ran three migrations in one go, rollback undoes all three; if you
ran them one at a time, rollback undoes only the last (pass
`--step 3` to undo all three).

Within a batch, rollback runs in **reverse filename order**, so
dependencies unwind correctly.

If a migration recorded in the table has no matching source file, rollback
throws rather than skipping:

```
Cannot roll back migration "2026_01_03_000000_create_posts_table": source file not found.
```

## MigrationRunner

```ts
import { MigrationRunner, DatabaseManager, DATABASE_TOKEN } from "@mahiframework/database";

const db = app.make<DatabaseManager>(DATABASE_TOKEN);
const runner = new MigrationRunner(db.driver().kysely);
```

| Method | Returns | Behaviour |
|---|---|---|
| `up(dirs, onEach?)` | `Promise<string[]>` | Runs every pending migration. Returns the names that ran. |
| `rollback(dirs, onEach?)` | `Promise<string[]>` | Undoes the highest batch. Returns the names rolled back. |
| `fresh(dirs, onEach?)` | `Promise<string[]>` | `dropAllTables()`, then `up()`. |
| `status(dirs)` | `Promise<MigrationStatus[]>` | Per-migration `{ name, ran, batch }`. |

```ts
interface MigrationStatus {
  name: string;
  ran: boolean;
  batch: number | null;
}
```

`onEach(name, run)` wraps the execution of each individual migration, the
CLI passes `Tui.task` to print a per-migration status line. It **must**
call and await `run()` itself.

`fresh()` bypasses every `down()` entirely and does a direct schema wipe,
so it works even when a `down()` is missing or broken.
`SchemaBuilder.dropAllTables()` suspends foreign-key enforcement, drops
every non-view table, then restores it in a `finally`, with each engine
using its own mechanism: the `foreign_keys` pragma on SQLite,
`FOREIGN_KEY_CHECKS` on MySQL (pinned to one pooled connection, since it
is a session variable), and `DROP ... CASCADE` on Postgres.

**On Postgres this only drops the current schema's tables**, resolved
from `current_schema()`, a database shared with another schema is left
alone.

## Schema

`Schema` is a facade over `SchemaBuilder`, bound at `SCHEMA_TOKEN`.

| Method | Purpose |
|---|---|
| `Schema.create(table, callback)` | Create a table. |
| `Schema.table(table, callback)` | Alter a table. |
| `Schema.drop(table)` | Drop it. Errors if absent. |
| `Schema.dropIfExists(table)` | Drop it if present. |
| `Schema.rename(from, to)` | Rename a table. |
| `Schema.hasTable(table)` | `Promise<boolean>` |
| `Schema.hasColumn(table, column)` | `Promise<boolean>` |
| `Schema.dropAllTables()` | Every user table. Used by `migrate:fresh`. |

The callback receives a `Blueprint`, collects definitions, and compiles
them to Kysely schema statements on `execute()`.

For a second connection, construct the builder yourself:

```ts
const schema = DB.schema("analytics");
await schema.create("events", (table) => { /* ... */ });
```

## Blueprint: column types

Every method below exists. The right column shows the SQLite affinity it
compiles to (SQLite has five storage classes, so length and precision
arguments are recorded but ignored there). On MySQL and Postgres the
same definitions compile to that engine's real types. `string(col, 64)`
is `varchar(64)`, `decimal(col, 12, 4)` is `decimal(12, 4)`, and
`timestamp()` carries its fractional-second precision.

### Auto-incrementing keys

| Method | Affinity |
|---|---|
| `id(column = "id")` | `integer`: alias for `bigIncrements` |
| `increments(column = "id")` | `integer`: alias for `integerIncrements` |
| `integerIncrements(column = "id")` | `integer` |
| `tinyIncrements(column = "id")` | `integer` |
| `smallIncrements(column = "id")` | `integer` |
| `mediumIncrements(column = "id")` | `integer` |
| `bigIncrements(column = "id")` | `integer` |

All seven set `autoIncrement`, `primary` and `unsigned` on the definition.

### Strings and text

| Method | Affinity |
|---|---|
| `string(column, length = 255)` | `text` |
| `char(column, length = 255)` | `text` |
| `text(column)` | `text` |
| `tinyText(column)` | `text` |
| `mediumText(column)` | `text` |
| `longText(column)` | `text` |

### Integers

| Method | Affinity |
|---|---|
| `integer(column)` | `integer` |
| `tinyInteger(column)` | `integer` |
| `smallInteger(column)` | `integer` |
| `mediumInteger(column)` | `integer` |
| `bigInteger(column)` | `integer` |
| `unsignedInteger(column)` | `integer` (`.unsigned()`) |
| `unsignedTinyInteger(column)` | `integer` (`.unsigned()`) |
| `unsignedSmallInteger(column)` | `integer` (`.unsigned()`) |
| `unsignedMediumInteger(column)` | `integer` (`.unsigned()`) |
| `unsignedBigInteger(column)` | `integer` (`.unsigned()`) |
| `foreignId(column)` | `integer`: alias for `unsignedBigInteger` |

### Numbers and booleans

| Method | Affinity |
|---|---|
| `boolean(column)` | `integer`: SQLite has no native boolean |
| `float(column, precision?)` | `real`: precision ignored |
| `double(column, total?, places?)` | `real`: args ignored |
| `decimal(column, total = 8, places = 2)` | `numeric` |

Pair a `boolean` column with `Cast.boolean()`, and a `decimal` column with
`Cast.decimal(places)` from `@mahiframework/database`. See
[Models](../models/#casts). A `boolean` attribute without a cast is a
compile error, precisely because the column comes back as `0`/`1`.

### Dates and times

| Method | Affinity |
|---|---|
| `date(column)` | `text` |
| `dateTime(column, precision?)` | `text` |
| `dateTimeTz(column, precision?)` | `text` |
| `time(column, precision?)` | `text` |
| `timeTz(column, precision?)` | `text` |
| `timestamp(column, precision?)` | `text` |
| `timestampTz(column, precision?)` | `text` |
| `year(column)` | `text` |

On SQLite all of these are ISO-8601 text and the `Tz` variants compile
identically. On MySQL/Postgres they compile to the engine's real
temporal types, and the `Tz` variants become `timestamp with time zone`
/ `time with time zone`.

**`precision` defaults to 3 (milliseconds)**, not Laravel's 0. SQLite
stores whatever text it is handed and the framework stamps timestamps
with millisecond precision, so a `timestamp(0)` column on MySQL/Postgres
would round that away, the same `create()` would round-trip exactly on
SQLite and lose its milliseconds elsewhere. Pass `0` explicitly for
whole-second columns.

### Structured and specialised

| Method | Affinity |
|---|---|
| `json(column)` | `text` |
| `jsonb(column)` | `text` |
| `uuid(column)` | `text` |
| `ulid(column)` | `text` |
| `binary(column)` | `blob` |
| `enum(column, allowed)` | `text`: `allowed` recorded, **not enforced** |
| `ipAddress(column)` | `text` |
| `macAddress(column)` | `text` |
| `rememberToken()` | `string("remember_token", 100).nullable()` |

`enum()` does not generate a `CHECK` constraint. Validate in the
application layer. See [Validation](../validation/).

### Helper groups

| Method | Adds |
|---|---|
| `timestamps(precision?)` | Nullable `created_at` + `updated_at`. Alias for `nullableTimestamps`. |
| `nullableTimestamps(precision?)` | Same. |
| `timestampsTz(precision?)` | Nullable `created_at` + `updated_at` as `timestampTz`. |
| `datetimes(precision?)` | Alias for `timestamps`. |
| `softDeletes(column = "deleted_at", precision?)` | Nullable `timestamp`. |
| `softDeletesTz(column = "deleted_at", precision?)` | Nullable `timestampTz`. |
| `softDeletesDatetime(column = "deleted_at", precision?)` | Nullable `dateTime`. |

`timestamps()` returns `void`, not a `ColumnDefinition`. You can't chain
modifiers onto it. Declare the columns individually if you need to (the
shipped `posts` migration does exactly that for non-nullable timestamps).

### Morph groups

| Method | Adds |
|---|---|
| `morphs(name, indexName?)` | `{name}_type` string + `{name}_id` unsignedBigInteger + composite index |
| `nullableMorphs(name, indexName?)` | Same, both nullable |
| `uuidMorphs(name, indexName?)` | `{name}_type` string + `{name}_id` uuid + index |
| `ulidMorphs(name, indexName?)` | `{name}_type` string + `{name}_id` ulid + index |
| `numericMorphs(name, indexName?)` | Same as `morphs` |

These are the only place in the framework that *does* derive column names
from a base name, the relation declarations themselves require explicit
column names. See [Relationships](../relationships/).

## Blueprint: column modifiers

Every modifier returns the `ColumnDefinition` for chaining.

| Modifier | Effect |
|---|---|
| `nullable(value = true)` | Omits `NOT NULL`. Columns are **non-null by default**. |
| `default(value)` | `DEFAULT ?`. Booleans normalise to `1`/`0`. |
| `useCurrent()` | `DEFAULT CURRENT_TIMESTAMP`. Beats `default()`. |
| `primary()` | Marks it the primary key. |
| `autoIncrement()` | Sets auto-increment **and** primary. |
| `from(startingValue)` | Seeds `sqlite_sequence`. Create only. |
| `unsigned()` | Recorded; no effect on SQLite affinity. |
| `unique(indexName?)` | Creates a unique index after the table. |
| `index(indexName?)` | Creates a non-unique index after the table. |
| `comment(text)` | Recorded; not emitted. |
| `after(column)` | Recorded; not emitted (SQLite can't reposition). |
| `first()` | Recorded; not emitted. |
| `storedAs(expression)` | `GENERATED ALWAYS AS (expr) STORED`. |
| `virtualAs(expression)` | `GENERATED ALWAYS AS (expr)`. |
| `change()` | Marks for modification. **`Schema.table()` only.** |
| `references(column)` | Starts a foreign key. Returns `ForeignKeyDefinition`. |
| `constrained(table?, column = "id")` | `references(column).on(table ?? inferred)`. |

**Columns are `NOT NULL` unless you call `nullable()`.** That's the
opposite of raw SQL's default and matches Laravel.

`constrained()` infers the table from the column name, `user_id` →
`users`, by stripping `_id` and appending `s` unless it already ends in
`s`. This is the framework's one bit of naming inference outside `morphs`,
and it's naive: `person_id` infers `persons`, `category_id` infers
`categorys`. Pass the table explicitly when the guess is wrong.

`comment()`, `after()` and `first()` are recorded on the definition but
never emitted. They exist for API parity, not effect.

## Blueprint: indexes

| Method | Notes |
|---|---|
| `primary(columns, name?)` | Composite primary key constraint. |
| `unique(columns, name? \| options?)` | |
| `index(columns, name? \| options?)` | |
| `fullText(columns, name?)` | **MySQL only**: throws on SQLite and Postgres. |
| `spatialIndex(columns, name?)` | **Throws on every dialect.** |

`columns` is a string or a string array.

`unique()` and `index()` take either an index name or an `IndexOptions`
object in their second argument. `primary()` takes only a name: a
`PRIMARY KEY` is a table constraint rather than a free-standing index, so
it cannot be partial or pick a method.

```
fullText indexes are not supported on sqlite.
spatialIndex is not supported on postgres.
```

They throw at compile time, before any DDL runs.

Index names default to Laravel's scheme, `{table}_{col1}_{col2}_{type}`,
lowercased, with `-` and `.` replaced by `_`:

```
posts_user_id_index
users_email_unique
post_hashtag_post_id_hashtag_id_primary
```

Declaring a composite `primary()` switches off per-column primary key
emission, so the constraint is added once as a table-level constraint:

```ts
await Schema.create("post_hashtag", (table) => {
  table.string("post_id");
  table.string("hashtag_id").index();
  table.primary(["post_id", "hashtag_id"]);
});
```

Indexes are created as separate `CREATE INDEX` statements **after** the
table, both for `.unique()`/`.index()` column modifiers and for
table-level `unique()`/`index()` calls.

## Blueprint: index options

```ts
interface IndexOptions {
  name?: string;
  where?: string;                      // partial index predicate
  using?: "btree" | "hash" | "gin" | "gist" | string;
  opclass?: Record<string, string>;    // per-column operator class
  nullsNotDistinct?: boolean;          // Postgres 15+
}
```

| Option | sqlite | mysql | postgres |
|---|---|---|---|
| `where` | yes | **throws** | yes |
| `using` | **throws** | `btree`/`hash` only | yes |
| `opclass` | **throws** | **throws** | yes |
| `nullsNotDistinct` | **throws** | **throws** | yes |

Like `fullText()`, an option the engine cannot do **throws at compile
time, before any DDL runs**, rather than quietly creating a weaker index:

```
Partial indexes (the "where" option, on unique(torrent_id)) are not supported on mysql.
Index methods (the "using" option, on index(criteria)) are not supported on sqlite.
Index method "gin" (on index(criteria)) is not supported on mysql, which has only btree and hash.
Operator classes (the "opclass" option, on index(title)) are not supported on sqlite.
"nullsNotDistinct" (on unique(torrent_id)) is not supported on sqlite; it needs Postgres 15 or newer.
```

A silently-downgraded index is a performance cliff nobody finds; a throw
is found on the first migration run.

### Partial indexes (`where`)

```ts
await Schema.create("downloads", (table) => {
  table.id();
  table.unsignedBigInteger("torrent_id").nullable();
  table.unique("torrent_id", { where: "torrent_id is not null" });
});
```

```sql
CREATE UNIQUE INDEX downloads_torrent_id_unique
  ON downloads (torrent_id) WHERE torrent_id is not null;
```

This one is **not an optimisation**. A plain `unique()` on a nullable
column permits many nulls on SQLite and Postgres, which is usually what
you want, but "at most one non-null, unlimited nulls" has no non-partial
spelling. It is a correctness constraint.

> ⚠️ `where` is raw SQL, embedded verbatim, exactly like `storedAs()` and
> `virtualAs()`. **Never build it from request input.** Index predicates
> cannot be parameterised on any engine — a database restriction, not a
> choice here — so there is no safe-binding form to fall back on.

The inverse case, "nulls collide like any other value", is
`nullsNotDistinct` below. Nullable-unique is really two capabilities that
want opposite things, so neither is a default.

### Index methods (`using`) and operator classes (`opclass`)

```ts
// containment queries on jsonb
table.index("criteria", { using: "gin" });

// the index that makes a substring search fast
table.index("title", { using: "gin", opclass: { title: "gin_trgm_ops" } });
```

```sql
CREATE INDEX profiles_criteria_index ON profiles USING gin (criteria);
CREATE INDEX metas_title_index ON metas USING gin (title gin_trgm_ops);
```

`opclass` is keyed by column name; columns absent from the map are
emitted as plain references, so the two mix in one index. A key naming a
column that is not part of the index throws, rather than being dropped in
silence.

Postgres `using` values are **not** validated, so `brin`, `spgist` and
extension-provided methods pass through. MySQL's are, because its list is
closed and short.

> ⚠️ `gin_trgm_ops` additionally needs `CREATE EXTENSION pg_trgm`, which
> stays your own explicit statement. Creating an extension is a
> privileged, database-wide side effect that a table blueprint should not
> perform implicitly; the framework only lets the *index* reference the
> opclass.

### `nullsNotDistinct`

```ts
table.unique("torrent_id", { nullsNotDistinct: true });
```

Makes nulls collide like any other value, so a second `NULL` is a unique
violation. Unique indexes only (it throws on a non-unique one, as
Postgres would) and Postgres 15+ only — on 14 and older the server raises
its own syntax error rather than this layer version-detecting.

## Blueprint: expression indexes

An entry in the column list may be an `indexExpression()` instead of a
column name, making it a *functional* index — one over a computed value
rather than a stored one. Every engine supports these.

```ts
import { indexExpression } from "@mahiframework/database";

await Schema.create("users", (table) => {
  table.id();
  table.string("email");
  table.unique([indexExpression(`lower("email")`)], {
    name: "users_email_lower_unique",
  });
});
```

That is case-insensitive uniqueness: `A@example.com` and
`a@EXAMPLE.com` collide, which a plain `unique("email")` would permit.

Expressions mix with plain columns in one index:

```ts
table.unique(["tenant", indexExpression(`lower("slug")`)], {
  name: "posts_tenant_slug_lower_unique",
});
```

**An expression index must be named.** The `{table}_{cols}_{type}`
convention has only column names to work from, and feeding an expression
through it would produce `metas_to_tsvector('english', title)_index` — an
identifier that is mangled and impossible for a `down()` to reproduce. So
omitting `name` is an error:

```
An index on the expression `lower("title")` (on "metas") needs an explicit name:
pass { name: "..." }, since the index naming convention has only column names to work from.
```

> ⚠️ An expression is emitted verbatim, like `where` and `storedAs()`.
> **Never build one from request input.** Index expressions cannot be
> parameterised: a bound value compiles to a `$1` placeholder that DDL
> cannot fill, and Postgres rejects it (`bind message supplies 1
> parameters, but prepared statement requires 0`). Quoting identifiers
> inside the expression is yours to do.

A plain string is **never** reinterpreted as SQL — `index(["lower(email)"])`
still means "a column named `lower(email)`", which is wrong but safe.
`indexExpression()` is a distinct type precisely so the two cannot be
confused.

`primary()` accepts no expressions: a `PRIMARY KEY` is a table
constraint, so there is nothing to put one on.

### Substring search on Postgres

A trigram index is what makes `whereLike("title", "%ncep%")` fast, and it
needs nothing but the options above:

```ts
await Schema.create("metas", (table) => {
  table.id();
  table.string("title");
  table.index("title", { using: "gin", opclass: { title: "gin_trgm_ops" } });
});
```

Plus the extension, once, as its own statement:

```ts
import { sql } from "kysely";

await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(DB.connection().kysely);
```

### Postgres full-text search

`fullText()` is MySQL-only and stays that way by design: MySQL's
`FULLTEXT` indexes existing columns, and one method should not mean two
different things. Postgres full-text is a **GIN index over
`to_tsvector(...)`**, which expression indexes now express directly — no
generated column, and no `tsvector` column type needed:

```ts
const vector = `to_tsvector('english', coalesce("title", '') || ' ' || coalesce("body", ''))`;

await Schema.create("docs", (table) => {
  table.id();
  table.string("title");
  table.text("body");
  table.index([indexExpression(`(${vector})`)], {
    name: "docs_searchable",
    using: "gin",
  });
});
```

Query it with the same expression:

```ts
await sql`
  select title from docs where ${sql.raw(vector)} @@ to_tsquery('english', 'dream')
`.execute(DB.connection().kysely);
```

The expression is parenthesised because Postgres requires it for a
single-expression index. Word matching is `to_tsvector`/`to_tsquery` as
above; for substring matching, use the trigram index instead.

## Blueprint: foreign keys

```ts
table.foreign(columns, name?): ForeignKeyDefinition
```

Or start from a column: `.references(column)` / `.constrained(table?)`.

| Method | Effect |
|---|---|
| `references(columns)` | Referenced column(s). Defaults to `["id"]`. |
| `on(table)` | Referenced table. **Required.** |
| `name(name)` | Constraint name. |
| `onDelete(action)` / `onUpdate(action)` | |
| `cascadeOnDelete()` / `cascadeOnUpdate()` | |
| `restrictOnDelete()` / `restrictOnUpdate()` | |
| `nullOnDelete()` / `nullOnUpdate()` | `SET NULL` |
| `noActionOnDelete()` / `noActionOnUpdate()` | |

```ts
type ReferentialAction = "cascade" | "restrict" | "set null" | "set default" | "no action";
```

```ts
await Schema.create("posts", (table) => {
  table.id();
  table.foreignId("user_id").constrained().cascadeOnDelete();
  table.text("body");
});

// Or explicitly:
await Schema.create("posts", (table) => {
  table.string("id").primary();
  table.string("user_id");
  table.foreign("user_id").references("id").on("users").cascadeOnDelete();
});
```

Missing `.on()` throws:

```
Foreign key on posts(user_id) is missing .on(table).
```

Foreign keys are actually enforced because `SqliteDriver` sets
`PRAGMA foreign_keys = ON`. Without it they'd be decorative.

## Blueprint: drop and rename

| Method | Notes |
|---|---|
| `dropColumn(...columns)` | Accepts strings and arrays; flattened. |
| `dropColumns(...columns)` | Alias. |
| `renameColumn(from, to)` | |
| `dropIndex(index)` | Array → derives the conventional name. |
| `dropUnique(index)` | Same, with the `unique` suffix. |
| `dropPrimary(index?)` | **Throws on SQLite**; supported on MySQL/Postgres. |
| `dropForeign(index)` | **Throws on SQLite**; supported on MySQL/Postgres. |
| `dropTimestamps()` | `dropColumn("created_at", "updated_at")`. |
| `dropSoftDeletes(column = "deleted_at")` | |
| `dropMorphs(name, indexName?)` | Drops the index and both columns. |
| `dropRememberToken()` | |
| `rename(to)` | Renames the table. |

## SQLite limitations in `Schema.table()`

These restrictions are **SQLite-only**, MySQL and Postgres support all
of them natively through real `ALTER TABLE` statements.

`compileAlter()` rejects several operations up front, before touching the
database:

| Operation | Error |
|---|---|
| Adding a foreign key | `Adding foreign keys via Schema.table() is not supported on SQLite. Define foreign keys in Schema.create() instead.` |
| Dropping a foreign key | `Dropping foreign keys via Schema.table() is not supported on SQLite (requires a table rebuild).` |
| Dropping a primary key | `Dropping primary keys via Schema.table() is not supported on SQLite.` |
| Adding a primary key | `Adding a primary key via Schema.table() is not supported on SQLite.` |
| Adding a primary/auto-increment **column** | `Adding a primary key column via Schema.table() is not supported on SQLite.` |
| `.change()` in `Schema.create()` | `Column.change() is only valid inside Schema.table(), not Schema.create(), for "x".` |

The workaround for all of them is the standard SQLite one: create a new
table with the shape you want, copy the data across, drop the old one,
rename. Write that explicitly in a migration.

### `change()` rebuilds the table

`.change()` **is** supported, and it triggers a full table rebuild,
introspect the current schema, create `__temp__{table}` with the modified
columns, `INSERT ... SELECT` every row across, drop the original, rename
the temp table, then recreate any non-constraint indexes:

```ts
await Schema.table("posts", (table) => {
  table.text("body").nullable().change();
});
```

Foreign keys are turned off for the rebuild and restored in a `finally`.
Existing unique constraints, foreign keys and primary keys are carried
over from introspection.

Changing a column that doesn't exist throws:

```
Cannot change column "body" on "posts": column does not exist.
```

**On a large table this rewrites every row.** Budget for it.

### Operation order in `Schema.table()`

Regardless of the order you call them, `compileAlter()` runs:

1. Add columns
2. Rebuild for `.change()` columns
3. Rename columns
4. **Drop indexes**
5. Drop columns
6. Create indexes (including a composite primary key)
7. Add foreign keys
8. Drop foreign keys
9. Drop primary keys
10. Rename the table

Split into separate migrations if you need a different order.

Indexes are dropped **before** columns so the mirror-image `down()` works:

```ts
async down() {
  await Schema.table("jobs", (table) => {
    table.dropIndex(["queue", "available_at"]);
    table.dropColumn("queue");   // the index covered this
  });
}
```

> Until recently this ran the other way round and the above failed on
> SQLite with `error in index ... after drop column: no such column`.
> MySQL and Postgres drop a covering index implicitly with its column, so
> the same migration passed there. Which is why the cross-engine test for
> it matters more than the SQLite one.

## Commands

### The production guard

Every command on this page that writes to the database (`migrate`,
`migrate:fresh`, `migrate:refresh`, `migrate:reset`, `migrate:rollback`,
`db:wipe`, `db:seed`) is
guarded when `APP_ENV=production`. So are the destructive queue commands,
`queue:clear` and `queue:flush`.

| Situation | Behaviour | Exit code |
|---|---|---|
| Not production | Runs. No prompt, a local `migrate:fresh` stays one keystroke. | 0 |
| Production, terminal attached | Prompts `Do you really wish to run this command?`, defaulting to **no**. | 0 either way |
| Production, no terminal (CI, deploy script) | **Refuses.** Pass `--force`. | **1** |
| `--force` | Runs, no prompt. | 0 |

Failing closed without a TTY is the actual safety property: an
unattended pipeline should not be able to drop a production schema
because nobody was watching the terminal. Note the app treats an
*unknown* `APP_ENV` as production, so the guard defaults to on.

The two refusals differ in exit code on purpose. No terminal exits **1**,
because nobody was asked and a deploy that continues against an unmigrated
schema is worse than one that stops. A human answering "no" exits 0. That
is a decision, not a failure.

"Terminal attached" means stdin *and* stdout, so `./artisan migrate | tee
deploy.log` counts as unattended.

`--pretend` is exempt. It cannot change anything.

### `migrate`

```bash
./artisan migrate
./artisan migrate --pretend
```

| Flag | Effect |
|---|---|
| `--pretend` | List what would run, run nothing. |
| `--force` | Skip the production confirmation. |

Runs every pending migration across all collected directories. Prints a
per-migration task line. `Nothing to migrate.` when up to date.

`--pretend` lists the pending migration *names*; it does not print SQL.
A migration here is arbitrary TypeScript rather than a declarative list
of statements, so the only way to know its SQL would be to run it,
and a migration that branches on a query result would take a different
path under a pretend connection, or do real non-DDL work. Reporting the
names is the part that is both useful and true.

### `migrate:fresh`

```bash
./artisan migrate:fresh
./artisan migrate:fresh --seed
```

| Flag | Effect |
|---|---|
| `--seed` | Run `db:seed` afterwards. |
| `--force` | Skip the production confirmation. |

Drops **every** table, bypassing `down()` entirely, then re-runs
everything from scratch. Works even if a `down()` is missing or broken.
Destroys all data.

### `migrate:refresh`

```bash
./artisan migrate:refresh
./artisan migrate:refresh --seed
```

| Flag | Effect |
|---|---|
| `--seed` | Run `db:seed` afterwards. |
| `--force` | Skip the production confirmation. |

Rolls back **every batch**, then re-runs everything. Unlike `fresh`,
this exercises your `down()` methods. Which is the point, and also the
risk: a broken `down()` stops it partway.

### `migrate:reset`

```bash
./artisan migrate:reset
./artisan migrate:reset --pretend
```

| Flag | Effect |
|---|---|
| `--pretend` | List what would roll back, run nothing. |
| `--force` | Skip the production confirmation. |

Rolls back **every** migration, newest batch first, and stops there,
`migrate:refresh` without the re-migrate. Like `refresh` and unlike
`fresh`, it runs each migration's `down()`, so it exercises them and
correspondingly fails partway on one that is broken.

The migrations table itself survives; the migrations are simply marked
un-run. Use `db:wipe` when you want the ledger gone too.

### `db:wipe`

```bash
./artisan db:wipe
```

| Flag | Effect |
|---|---|
| `--force` | Skip the production confirmation. |

Drops every table and stops, `migrate:fresh` without the re-migrate. No
`down()` is involved, so nothing in the migrations can object, and it
works on a schema whose migrations no longer exist.

This removes the **migrations table too**, so afterwards there is no
record that anything ever ran. That is the point when you are about to
restore a dump, and a trap otherwise: a subsequent `migrate` re-runs
everything from the beginning.

| Command | Empties via | Keeps history | Re-migrates |
|---|---|---|---|
| `migrate:reset` | `down()` | yes | no |
| `migrate:refresh` | `down()` | yes | yes |
| `db:wipe` | drop table | **no** | no |
| `migrate:fresh` | drop table | yes* | yes |

\* `fresh` drops the ledger too, but immediately re-migrates, so the
history is rebuilt as a single fresh batch.

### `migrate:rollback`

```bash
./artisan migrate:rollback
./artisan migrate:rollback --step 3
./artisan migrate:rollback --pretend
```

| Flag | Effect |
|---|---|
| `--step <count>` | Roll back this many **batches**, newest first. Default 1. |
| `--pretend` | List what would roll back, roll back nothing. |
| `--force` | Skip the production confirmation. |

Rolls back the most recent batch by default. `Nothing to roll back.`
when the table is empty.

`--step` counts *batches*, not individual migrations, matching Laravel:
a batch is what was applied together, so it is what can be undone
together without leaving a half-applied deploy. A `--step` larger than
the number of batches rolls back everything rather than erroring.

Within the rollback, order is newest batch first and, inside each batch,
the reverse of the order it was applied, a `down()` can depend on
everything applied before it still existing.

### `migrate:status`

```bash
./artisan migrate:status
```

```
Migration                                Status
2026_01_01_000000_create_users_table     Ran (batch 1)
2026_01_03_000000_create_posts_table     Pending
```

### `db:seed`

```bash
./artisan db:seed
```

| Flag | Effect |
|---|---|
| `--force` | Skip the production confirmation. |

Runs every seeder returned by every provider's `seeders()` hook, in
provider registration order. There is no `--class` flag, run a single
seeder from a custom command if you need to.

`migrate:fresh --seed` and `migrate:refresh --seed` call this directly
and pass their own confirmation through, so you are asked once for the
whole operation rather than twice.

### `db:show`

```bash
./artisan db:show
```

Every table with its column count and row count, via Kysely's
introspection.

### `db:table`

```bash
./artisan db:table posts
```

```
Column      Type     Nullable  Auto-increment
id          TEXT     no        no
user_id     TEXT     no        no
body        TEXT     no        no
```

### Generators

| Command | Default directory | Flags |
|---|---|---|
| `make:migration <name>` | `database/migrations` | `-d, --dir <dir>` |
| `make:model <name>` | `src/models` | `-d, --dir`, `-m, --migration`, `-f, --factory` |
| `make:factory <name>` | `database/factories` | `-d, --dir <dir>` |
| `make:seeder <name>` | `database/seeders` | `-d, --dir <dir>` |
| `make:resource <name>` | `src/http/resources` | `-d, --dir <dir>` |
| `make:request <name>` | `src/http/requests` | `-d, --dir <dir>` |
| `make:policy <name>` | `src/policies` | `-d, --dir <dir>` |
| `make:event <name>` | `src/events` | `-d, --dir <dir>` |
| `make:listener <name>` | `src/listeners` | `-d, --dir <dir>` |
| `make:job <name>` | `src/jobs` | `-d, --dir <dir>` |
| `make:provider <name>` | `src` | `-d, --dir <dir>` |

```bash
./artisan make:model Post -m -f
```

Scaffolds `src/models/post.model.ts`, a
`database/migrations/<timestamp>_create_posts_table.ts`, and
`database/factories/post-factory.ts`. Note `-m`/`-f` always write to the
default directories, ignoring `-d`.

`make:migration` derives the table name from a `create_{table}_table`
name; anything else gets a `"..."` placeholder. Names are normalised to
`StudlyCase` with the expected suffix appended if absent, `make:factory
post` and `make:factory PostFactory` both produce `PostFactory`.

## Seeders

```ts
export abstract class Seeder {
  constructor(protected app: Application) {}
  abstract run(): Promise<void>;
}
```

```ts
import { Seeder } from "@mahiframework/database";
import { User } from "../../src/models/user.model.js";

export class DatabaseSeeder extends Seeder {
  async run(): Promise<void> {
    await User.factory().times(10).create();
  }
}
```

Register in a provider:

```ts
export class AppServiceProvider extends ServiceProvider {
  seeders() {
    return [DatabaseSeeder];
  }
}
```

`db:seed` instantiates each with the `Application` and awaits `run()`.
Seeders run in provider registration order, then declaration order within
each provider's array. There's no dependency graph, order your array so
parents come before children.

Composing seeders is a plain instantiation:

```ts
export class DatabaseSeeder extends Seeder {
  async run(): Promise<void> {
    await new UserSeeder(this.app).run();
    await new PostSeeder(this.app).run();
  }
}
```

Keep each seeder focused on one table or feature. For a large demo
dataset, a dedicated console command is often clearer than a seeder. See
[Console](../console/).

## Factories

A `Factory` generates realistic model instances on demand. Seeders and
tests are the audience.

```ts
import { Factory } from "@mahiframework/database";
import { Post, type PostAttributes } from "../../src/models/post.model.js";

export class PostFactory extends Factory<typeof Post> {
  protected model = Post;

  protected definition(): Partial<PostAttributes> {
    return {
      user_id: "",
      parent_id: null,
      body: `Post ${Math.random().toString(36).slice(2, 8)}`,
      deleted_at: null,
    };
  }
}
```

Two required members: `protected model` and `protected definition()`.

`definition()` is **synchronous** and returns a **model-shape** row, the
same shape the instance accessors deal in, which is what its type
(`Partial<Post>`) says. It goes through `forceFill()`, so each column's
cast is applied on the way in: write `published: true` and
`meta: { … }`, not `1` and a JSON string.

(Casts are idempotent, so a DB-shape value still works if you have one
in hand. `forceFill` rather than `fill` means `fillable`/`guarded` are
deliberately bypassed. A factory is trusted fixture code and must be
able to set a guarded `id`.)

Note what's omitted: `id` (filled by the model's `keyType` key strategy on
insert) and the timestamps (stamped automatically). Only include them if
you need a specific value.

**No faker library is bundled.** `definition()` is a plain function
returning a row; add `@faker-js/faker` yourself if you want it.

### Wiring it to the model

```ts
export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
}) {
  static override factory(): PostFactory {
    return new PostFactory();
  }
}

await Post.factory().times(10).create();
```

The override's return type **is** the declaration, `createOne()` narrows
to `Post`, `create()` to `Post[]`, with no companion marker to keep in
sync.

This creates a model → factory → model import cycle, which is safe here:
the factory is referenced only inside `factory()`'s body (call time), and
`protected model = Post` is an instance field initializer (construction
time). Neither side touches the other during module evaluation.

**A static field would not be safe.** `static Factory = PostFactory`
evaluates at class-definition time and hits a TDZ `ReferenceError` when
the factory module is the entry into the cycle. This is exactly why
`factory()` is an overridable method rather than a static property.

Without an override, `Model.factory()` throws:

```
Post has no factory — override "static factory()" to return a Factory instance.
```

### The API

| Method | Returns | Notes |
|---|---|---|
| `times(n)` | `this` | Ignored by `makeOne`/`createOne`. |
| `state(partial \| resolver)` | `this` | Composes in call order. |
| `afterMaking(callback)` | `this` | Stacks. |
| `afterCreating(callback)` | `this` | Stacks. |
| `make(overrides?)` | `Promise<M[]>` | In-memory. **Always an array.** |
| `makeOne(overrides?)` | `Promise<M>` | One instance, ignores `times()`. |
| `create(overrides?)` | `Promise<M[]>` | Build + insert. **Always an array.** |
| `createOne(overrides?)` | `Promise<M>` | One row, ignores `times()`. |
| `createQuietly(overrides?)` | `Promise<M[]>` | `create()` with events suppressed. |
| `createOneQuietly(overrides?)` | `Promise<M>` | |

`make()` and `create()` always return an array even for `times(1)`. Use
the `*One` variants when you want a single instance.

### Attribute precedence

```
definition() → each state() in call order → the overrides argument
```

The overrides argument always wins.

### States

```ts
export class PostFactory extends Factory<typeof Post> {
  protected model = Post;
  protected definition(): PostTable { /* ... */ }

  deleted(): this {
    return this.state({ deleted_at: DateTime.now("UTC").toISOString() });
  }

  replyTo(parent: Post): this {
    return this.state({ parent_id: parent.id, user_id: parent.user_id });
  }
}

await Post.factory().deleted().createOne();
```

A resolver form receives the attributes built so far:

```ts
this.state((attributes) => ({ slug: Str.slug(attributes.title) }));
```

### Lifecycle callbacks

```ts
await Post.factory()
  .afterMaking((post) => { post.body = post.body.trim(); })
  .afterCreating(async (post) => {
    await PostHashtag.create({ post_id: post.id, hashtag_id: tagId });
  })
  .createOne();
```

`afterMaking` runs on every instance right after it's built, **including
for `make()`/`makeOne()`**, before any DB write. `afterCreating` runs
after insert.

Both may be sync or async, and both stack rather than replacing.

### Insert behaviour

`insertRows()` mirrors `Model.create()` exactly, so factory rows aren't a
special case:

1. Stamp timestamps (unless already supplied).
2. Fire `saving` per row.
3. `assignGeneratedPrimaryKey()`: run the model's key strategy if the key
   is client-generated and still empty.
4. Fire `creating` per row.
5. Insert.
6. `markPersisted()`: `exists = true`, `wasRecentlyCreated = true`, and
   the dirty snapshot synced, so a factory-made model reports itself
   exactly as a `create()`d one does.
7. Fire `created` then `saved` per row, then run `afterCreating`.

**The insert strategy depends on the model's `keyType`:**

- a client-generated key, `keyType: "uuid"`, `snowflake()`, or any custom
  `KeyStrategy` (the common factory case), **one batch insert** for the
  whole set. `times(50).create()` is one round trip.
- `keyType: "increment"` (the default, DB-generated): **row by row.**
  Kysely's `InsertResult.insertId` only reports the *last* row's generated
  id for a multi-row `VALUES`, so there's no way to read back every key
  from a batched insert. Correctness wins over the batching guarantee.

If you're generating thousands of rows, a client-generated primary key
(UUID or Snowflake) makes seeding dramatically faster.

### `createQuietly()`

```ts
await Post.factory().times(50).createQuietly();
```

Wraps in `Model.withoutEvents()`, so no observers, no `on()` listeners, no
`dispatchesEvents`, no generic lifecycle events.

Rows still get their timestamps and their generated keys, suppression
covers event dispatch only. `afterMaking`/`afterCreating` still run;
they're `Factory`'s own hooks, not model lifecycle events.

Use it when seeding a large dataset whose observers would queue jobs, send
notifications, or hit a search index.

### The pre-computed hash trick

The generated `UserFactory` does this, and you should copy the pattern:

```ts
export const TEST_PASSWORD = "password";
export const TEST_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$pZO4pLrdNfk2w2KmDzQeSw$EHiOq+hyokw8u+vyKYGeCjxNq2GXIsdKdm7bS9PpRzM";

export class UserFactory extends Factory<typeof User> {
  protected model = User;

  protected definition(): UserTable {
    const token = randomUUID();
    return {
      name: `User ${token.slice(0, 8)}`,
      email: `user-${token}@example.com`,
      password: TEST_PASSWORD_HASH,
      deleted_at: null,
    } as UserTable;
  }
}
```

Two reasons:

1. **`definition()` is synchronous.** `Hash.make()` is async. You cannot
   await it here.
2. **argon2 is deliberately slow.** ~100ms per hash by design. A test
   creating 10 users would pay a full second of pure hashing for a value
   nothing asserts on.

The constant is the argon2 hash of `"password"`. Tests that need to log in
import `TEST_PASSWORD` and post that:

```ts
const user = await User.factory().createOne();
await client.post("/auth/login", { email: user.email, password: TEST_PASSWORD });
```

When a test needs a *different* password, hash it in the test (where
`await` is available) and pass it as an override:

```ts
const user = await User.factory().createOne({ password: await Hash.make("hunter2") });
```

The same trick applies to any expensive-but-uninteresting default: compute
it once as a module constant, override when a test cares.

See [Testing](../testing/) for the wider testing story.
