# Models

`Model` is an Active Record base class. Reads return hydrated instances,
attribute access goes through a per-instance `Proxy` so casts apply
transparently, and instances carry change tracking in both directions,
pre-save (`getDirty()`) and post-save (`getChanges()`/`wasChanged()`),
plus `save()`/`refresh()`/`replicate()`.

```ts
import { Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

export interface PostAttributes {
  id: string;
  user_id: string;
  body: string;
  created_at: DateTime;
  updated_at: DateTime;
}

export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  keyType: "uuid",
}) {}
```

```ts
const post = await Post.find(id);          // Post | undefined
const posts = await Post.all();            // Collection<Post>
const created = await Post.create({ user_id, body });
```

Access is **static** for queries, `Post.all()`, `Post.find(id)`,
`Post.query()`, not `new Post(db).all()`. The connection is resolved
internally through the global `app()` container lookup, which means
`app.bootstrap()` must have run before any static `Model` method is
called.

## One interface describes the whole model

A model is described by **one** interface. Columns are plain types,
relations are markers, computed attributes are markers, and everything
else (the instance shape, the row shape, the builder, the finder return
types, the primary-key type) is derived from it. There is exactly one
declaration to keep in sync.

```ts
import { Model, Cast, belongsTo, accessor } from "@mahiframework/database";
import type { BelongsTo, Computed } from "@mahiframework/database";

interface PostAttributes {
  id: string;
  user_id: string;
  body: string;
  published: boolean;            // a boolean column needs a cast — see below
  author: BelongsTo<User>;       // a relation
  excerpt: Computed<string>;     // an accessor
}

export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  casts: { published: Cast.boolean() },
}) {
  static override relationships = {
    author: belongsTo(() => User, { foreignKey: "user_id" }),
  };

  static override accessors = {
    excerpt: accessor((post: Post) => post.body.slice(0, 120)),
  };
}
```

`Post` is now the *only* type you ever need to name. `Post.find(id)`
returns `Post | undefined`, `Post.query()...firstOrFail()` returns
`Post`, and `this` inside a `Post` method is a `Post`, all of them the
same type, cast types included.

### Why `Model<A>()(config)` is curried

The empty `()` in the middle is required. TypeScript has no partial
type-argument inference: you cannot write `Model<PostAttributes>(config)`
and still have `config` inferred `const` (which is what preserves the
literal `"id"` in `primaryKey: "id"` so the primary key's *type* is
known). Splitting it in two, one call that fixes `A` explicitly, a
second that infers `C`, gets both.

Read it as: "a model over `PostAttributes`, configured like this".

### The type-lint

Five mistakes are rejected at the class declaration rather than at the
call site that trips over them:

```ts
interface BadAttributes {
  id: string;
  active: boolean;               // no cast declared
}
// Error: boolean column needs a Cast.boolean(): active
class Bad extends Model<BadAttributes>()({ table: "bad" }) {}
```

| Rule | Why |
|---|---|
| A `boolean` column needs `Cast.boolean()` | SQLite/MySQL return `0`/`1`, so it would read back as a number, and `0` is falsy but `Number(0)` boxed is truthy. |
| A `DateTime` column needs `Cast.datetime()` | The driver hands back a string, so `post.published_at.addDays(1)` throws `not a function` while the type says it's fine. |
| A column may not use a reserved member name | `save`, `delete`, `fill`, `relations`, `toJSON`, …. The attribute would shadow the method. |
| `keyType` must agree with the key's type | `"uuid"` and a `KeyStrategy` both assign strings, so `id: number` is a guaranteed mismatch on insert. |
| The soft-delete column must be nullable | `restore()` writes `null` to it. |

Timestamp and soft-delete columns are exempt from the `DateTime` rule,
the framework installs those casts implicitly from `timestamps` /
`softDeletes`, including when you rename the columns.

Errors are an intersection rather than a chain, so a model breaking two
rules reports both at once.

`primaryKey` naming a relation or a computed key is rejected too, but by
the config's own type (the field is `ColumnKeys<A>`), so you get a plain
"not assignable" error rather than a lint message.

**At runtime**, a separate validator checks the config *object*,
whether `casts` entries are really `Cast`s, whether `keyType` is one of
the valid forms, whether the array options are arrays, whether
`fillable` and `guarded: ["*"]` contradict each other. That is for
plain-JS consumers and dynamically-assembled configs. It deliberately
does **not** mirror the rules above: every one of them is a statement
about the attributes *interface*, which does not exist at runtime.

## Configuration

Everything below is a key on the object passed to the factory. Every key
but `table` is optional, and every one is checked against the attributes
map: a column name that isn't a column, a `primaryKey` that isn't a
column, or a cast whose model type disagrees with the declared attribute
type are all compile errors.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `table` | `string` | *(none, required)* | The table name. |
| `connection` | `string` | *(default connection)* | Named connection to resolve. |
| `primaryKey` | *a column of `A`* | `"id"` | Used by `find()`/`whereKey()`. Types `Key<M>`. |
| `keyType` | `"increment" \| "uuid" \| KeyStrategy` | `"increment"` | How the primary key is produced. |
| `timestamps` | `boolean \| { createdAt?, updatedAt? }` | **`true`** | Auto-stamp created/updated columns. |
| `softDeletes` | `boolean \| { column }` | `false` | Enables the soft-delete lifecycle. |
| `casts` | `{ [column]?: Cast }` | `{}` | Per-column bidirectional casts. |
| `fillable` | *columns of `A`* | `[]` | Mass-assignment allow-list. |
| `guarded` | *columns of `A`* `\| "*"` | `[]` | Mass-assignment block-list. |
| `hidden` | *keys of `A`* | `[]` | Attributes omitted from `toJSON()`. |
| `visible` | *keys of `A`* | `[]` | Allow-list for `toJSON()`. Beats `hidden`. |
| `appends` | *computed keys of `A`* | `[]` | Computed attributes included in `toJSON()`. |
| `morphName` | `string` | `undefined` | Stable name for morphs and queued-job serialization. |
| `deleteWhenMissingModels` | `boolean` | `false` | Queue behaviour when a referenced row is gone. |
| `strictRelations` | `boolean` | `false` | Throw on reading a relation that was never loaded. |

Relations, accessors, global scopes and lifecycle-event mappings are
declared as `static override` members on the class body rather than in
this object, because each names types or classes the config object can't
see. Two of these defaults are worth calling out because they bite.

### `keyType` defaults to `"increment"`

**Matching Laravel.** A model with a client-generated primary key, a
UUID, a Snowflake, must say so, or `create()`'s DB-generated-id
read-back path runs against a column nothing auto-increments. That's
harmless (nothing breaks), but no key ever gets generated for it.

```ts
export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  keyType: "uuid",              // id is a client-generated UUID
}) {}
```

`keyType` takes `"increment"`, `"uuid"`, or a `KeyStrategy` object for
anything else, `snowflake()` from `@mahiframework/snowflake` is one:

```ts
import { snowflake } from "@mahiframework/snowflake";

export class Message extends Model<MessageAttributes>()({
  table: "messages",
  keyType: snowflake(),
}) {}
```

### 64-bit keys are `bigint`

A snowflake is a 64-bit integer, which does not fit a JS `number`:
`440463260157395208` rounds to `...200` as a double. So ids are
`bigint`, the attribute is declared `id: bigint`, and the column is
`bigInteger()`. The same applies to an auto-increment key, which is
64-bit on every supported engine (`bigserial`, `BIGINT AUTO_INCREMENT`,
a SQLite rowid).

```ts
interface MessageAttributes {
  id: bigint;      // not string, not number
  body: string;
}
```

`JSON.stringify` throws on a `bigint` rather than rounding it, so the
framework converts at each boundary that leaves the process, always to a
**decimal string** (a 19-digit JSON number would lose precision in any
client that parses it as a double):

| Boundary | Becomes |
|---|---|
| a JSON response | `"440463260157395208"` |
| a queue payload | restored to a `bigint` before `handle()` runs |
| a pagination cursor | restored to a `bigint` when decoded |
| a broadcast frame | `"440463260157395208"` |

Inside your own code an id stays a `bigint`, so compare with `===`
against another `bigint` (`id === 42n`), not against a number.

This replaces the old `static incrementing = false` + `HasSnowflake`
mixin pair: one key now says both *whether* the database generates the
key and *what* generates it instead. (`Model.incrementing` still exists
as a read-only getter derived from `keyType`, for code that asks.)

When the key is DB-generated, `create()` reads back the generated key
and merges it into the row, via `RETURNING` on SQLite/Postgres and
`LAST_INSERT_ID()` on MySQL, which has no `RETURNING`. **Unless** the
caller already supplied that column explicitly, in which case the DB
generated nothing and the caller's value passes through.

The key comes back as a `number` on every engine for ids inside JS's
safe integer range, and as a decimal `string` beyond it (a `bigint` past
2^53 cannot be a `number` without silently addressing a different row).

### `timestamps` defaults to `true`

**Defaults to `true`, matching Laravel.** A model whose table has
`created_at`/`updated_at` gets them stamped automatically. A model whose table
has *no* timestamp columns must set `timestamps: false`, or the insert
writes columns that don't exist and SQLite errors.

A table with only one of the two keeps timestamps on and nulls the
missing side:

```ts
export class Like extends Model<LikeAttributes>()({
  table: "likes",
  // append-only: inserted or deleted, never updated
  timestamps: { updatedAt: null },
}) {}
```

Explicit values always win. If the caller passes `created_at`, stamping
skips that column.

### Writing a key strategy

Anything beyond `"increment"` and `"uuid"` is a `KeyStrategy` object:
`type` declares whether the key is a string or a number (validated
against the primary-key column's declared type), and `generate` produces
the value.

```ts
import type { KeyStrategy } from "@mahiframework/database";

function prefixed(prefix: string): KeyStrategy<string> {
  return {
    type: "string",
    generate: ({ modelName }) => `${prefix}_${modelName}_${crypto.randomUUID()}`,
  };
}

export class Invoice extends Model<InvoiceAttributes>()({
  table: "invoices",
  keyType: prefixed("inv"),
}) {}
```

`generate` may be async, and receives the model class name. Which is
what `@mahiframework/snowflake` uses as its per-model sequence group.

Timing matters: it runs **after** `saving` and **before** `creating`. So a
`saving` hook can still supply an explicit key and win, and both `creating`
and the actual insert see the generated value.

### `morphName` and `deleteWhenMissingModels`

`morphName` is a stable, deploy-durable name used to serialize a model
reference inside a queued job payload, persisted as `{ __model, __id }`
and looked up in the `ModelRegistry` to rehydrate `Class.findOrFail(id)`
before `handle()` runs.

It is deliberately decoupled from `table` (renaming a table must not break
in-flight jobs) and from the JS class name (survives minification). Treat
values as append-only, like an enum member, changing one invalidates
every job already enqueued against it.

```ts
static override morphName = "Post";
```

`undefined` by default, meaning the model cannot appear in a job payload;
the codec throws loudly at dispatch rather than silently persisting a full
attribute dump.

`deleteWhenMissingModels` controls what happens when that reference no
longer resolves at run time:

- `false` (default): rehydration throws `ModelNotFoundError` and the job
  fails/retries like any other error. A missing row is usually a genuine
  bug.
- `true`: the job is silently, successfully removed from the queue
  without ever calling `handle()`. Right for "send welcome email to user"
  when the user has since been deleted.

If *any* referenced model is missing and this is `true`, the whole job is
skipped.

### `strictRelations`

Off by default. When on, reading a **declared** relation that was never
loaded throws `RelationNotLoadedError` instead of returning `undefined`,
Laravel's `preventLazyLoading()`, per model.

```ts
export class Post extends Model<PostAttributes>()({
  table: "posts",
  strictRelations: true,
}) {
  static override relationships = {
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
  };
}

const post = await Post.findOrFail(id);
post.comments;                 // throws — never loaded
```

The point is N+1 detection. `undefined` and "loaded, and genuinely
empty" are otherwise the same value, so an N+1 reads as an empty list
and ships. All three ways of getting the data legitimately still work:

```ts
(await Post.query().with("comments").firstOrFail()).comments;  // eager
await post.load("comments"); post.comments;                    // lazy
await post.relations.comments().count();                       // explicit query
```

Only relation names are affected, and only when no real column shadows
the name, a `withCount()` alias or a genuine `comments` column reads
through untouched. The natural posture is on in development and test,
off in production:

```ts
strictRelations: !app().isProduction(),
```

### `connection`

The named `DatabaseManager` connection this model reads and writes
through. `undefined` (the default) means the manager's default driver.

```ts
export class Event extends Model<EventAttributes>()({
  table: "events",
  connection: "analytics",     // never touches the primary database
}) {}
```

Every query, timestamp and transaction lookup on the model funnels
through it, so a transaction opened on a *different* connection
correctly does not capture this model's writes:

```ts
await DB.transaction(async () => {
  await Order.create({ ... });    // default connection — rolls back
  await Event.create({ ... });    // "analytics" — outside this transaction
  throw new Error("boom");
});
```

### `routeParamName()`

```ts
static routeParamName(): string {
  return (this.morphName ?? this.name).toLowerCase();
}
```

The default route parameter name for explicit route-model binding.
`request.model(Post)` reads `{post}`. Derived from `morphName` when set,
otherwise the lowercased class name. Override for an irregular binding
name. See [Requests](../requests/).

### `fillable` / `guarded` precedence

Mass assignment means `new Model({...})`, `create()`, `fill()`,
`firstOrNew()`, `firstOrCreate()`, `updateOrCreate()` and
`updateInstance()`. The rules, in `isFillable()`:

```ts
static isFillable(key: string): boolean {
  if (this.fillable.length > 0) return this.fillable.includes(key);
  if (this.guarded.includes("*")) return false;
  return !this.guarded.includes(key);
}
```

1. A non-empty `fillable` is an allow-list and **wins outright**. `guarded`
   is not consulted at all.
2. Otherwise `guarded` is a block-list. `["*"]` blocks everything.
3. The framework default (both `[]`) makes every key fillable.

A disallowed key is normally **silently dropped**. The exception is a
*totally guarded* model, `fillable = []` **and** `guarded` includes
`"*"`, where `fill()` throws `MassAssignmentError` instead, so the
mistake surfaces loudly:

```ts
static totallyGuarded(): boolean {
  return this.fillable.length === 0 && this.guarded.includes("*");
}
```

```
Add [user_id] to the "fillable" property to allow mass assignment on "Post".
```

Direct attribute writes (`post.user_id = x`, through the proxy's `set`
trap) and internal hydration (`hydrate()`, `setRawAttributes()`,
`forceFill()`) bypass this entirely. It guards *mass* assignment only,
never a deliberate single-column assignment.

## Shared behaviour

There is no mixin system. The behaviours that used to arrive through
`Model.use(...)` are now either configuration or ordinary subclassing.

The two built-ins are config keys:

```ts
export class Post extends Model<PostAttributes>()({
  table: "posts",
  softDeletes: true,       // was Model.use(SoftDeletes)
  keyType: snowflake(),    // was Model.use(HasSnowflake)
}) {}
```

This is a deliberate trade. A mixin had to *generate a class* to add
methods, which is what forced the old `RowOf`/`BuilderOf` indirection:
the finders could not simply return "this class" because the class you
wrote was not the class that ran. Making the two built-ins configuration
removes that, and with it the whole generated-subclass type layer. Which
is why a model is now exactly one type.

For behaviour of your own, subclass. A model class is an ordinary class,
so shared statics and methods are inherited the ordinary way, and
because the finders are this-polymorphic, `Post.findBySlug()` below still
returns a `Post`, not the base:

```ts
class Sluggable extends Model<PostAttributes>()({ table: "posts", primaryKey: "id" }) {
  static async findBySlug(slug: string) {
    return this.query().where("slug", slug).first();
  }
}

export class Post extends Sluggable {
  static override boot(): void {
    this.on("creating", (post) => {
      post.slug ??= Str.slug(post.title);
    });
  }
}
```

`static boot()` is your one-time per-class hook. It runs once per class
per isolate from `bootIfNotBooted()` (called by `query()` and
`queryWithoutScopes()`), parents first, and re-entry from a query issued
during boot is a no-op. You do not call `super.boot()`.

## Static finders and writers

| Method | Returns |
|---|---|
| `all()` | `Promise<Collection<Post>>` |
| `find(id)` | `Promise<Post \| undefined>` |
| `findMany(ids)` | `Promise<Collection<Post>>`: one `whereIn`, never N queries |
| `findOrFail(id)` | `Promise<Post>`: throws `ModelNotFoundError` |
| `first()` | `Promise<Post \| undefined>` |
| `firstOrFail()` | `Promise<Post>`: throws `ModelNotFoundError` |
| `create(values)` | `Promise<Post>` |
| `firstOrNew(attrs, values?)` | `Promise<Post>`: **unsaved** if not found |
| `firstOrCreate(attrs, values?)` | `Promise<Post>`: creates if not found |
| `updateOrCreate(attrs, values?)` | `Promise<Post>` |
| `update(id, values)` | `Promise<void>` |
| `delete(id, preloaded?)` | `Promise<void>` |
| `hydrate(row)` | `Post`: an existing instance from a raw row |
| `query()` | a builder terminating in `Post` |
| `queryWithoutScopes()` | a builder terminating in `Post` |
| `newModelQuery()` | a builder terminating in `Post`: the **persistence** builder (no scopes) |
| `withoutGlobalScope(ScopeClass)` | a builder terminating in `Post` |
| `withoutGlobalScopes(ScopeClasses?)` | a builder terminating in `Post` |
| `paginate(page, perPage)` | `Promise<LengthAwarePaginationResult<Post>>` |
| `simplePaginate(page, perPage)` | `Promise<SimplePaginationResult<Post>>` |
| `cursorPaginate(options)` | `Promise<CursorPaginationResult<Post>>` |
| `observe(ObserverClass)` | `void` |
| `on(event, listener)` | `void` |
| `withoutEvents(callback)` | `Promise<T>` |
| `factory()` | `Factory`: throws unless overridden |
| `newEloquentBuilder()` | `EloquentBuilder`: low-level construction hook; override `query()` for a custom builder |
| `resolveConnection()` | `Kysely<any>` |
| `addGlobalScope(scope)` | `void` |
| `isFillable(key)` / `totallyGuarded()` | `boolean` |

Notes on the less obvious ones:

**`findMany(ids)`** returns rows for whatever ids matched; missing ids are
simply absent (same as Eloquent). Returns an empty `Collection` for an
empty `ids` array without hitting the DB.

**`firstOrNew()`** builds an **unsaved** instance if nothing matches. It
never writes. Call `.save()` on the result yourself.

**`updateOrCreate()`** routes through `existing.updateInstance(values)`
when a row matches, so timestamps and events apply.

**`hydrate(row)`** stores values as-is in DB shape (no cast-in), snapshots
them for dirty tracking, and marks the instance as existing. Use it to
lift a plain row into an instance. `Auth.user()` returns row data, so
`User.hydrate(user).relations.posts().count()` is the way to reach the
relation namespace from it.

**`factory()`** has no default implementation and throws:

```
Post has no factory — override "static factory()" to return a Factory instance.
```

Unlike `query()`, there's no sensible generic `Factory` to fall back to,
a `definition()` is inherently model-specific, and a missing override is a
development-time mistake worth failing loudly on. See
[Migrations](../migrations/) for factories.

### Static `update()` and `delete()` event payloads

`Model.update(id, values)` builds `{ ...values, [primaryKeyColumn]: id }`
and passes **that same object reference** to `saving` and `updating`
before running the `UPDATE`. Mutating it in a hook changes what gets
written, and hooks always know which row without a separate `id`
parameter.

`Model.delete(id)` **loads the row first** so the `deleting`/`deleted`
payload is the real, fully-attributed instance, matching Laravel, whose
delete events always receive the model. A listener can read any column,
not just the key. When no row matches, the events get a minimal
`{ [primaryKeyColumn]: id }` object and no `DELETE` runs.

The optional second argument (`preloaded`) lets `deleteInstance()` pass
the model it already holds, avoiding a redundant read. External callers
pass just the id.

## Instance API

### Attributes and change tracking

An instance tracks change in **two windows**. Before a save, `getDirty()`
answers "what is about to be written". After one, `getChanges()` answers
"what was just written", the question an `updated` observer needs and
which `syncOriginal()` would otherwise have destroyed.

| Method | Returns | Notes |
|---|---|---|
| `getAttribute(key)` | `any` | Casted (model-shape). Relations and appends resolve here too. |
| `setAttribute(key, value)` | `void` | Converts model shape → DB shape via the cast. |
| `getRawAttribute(key)` | `any` | Bypasses casts. Used for relation keys. |
| `setRawAttribute(key, value)` | `void` | Sets one attribute in DB shape, bypassing the cast. Still dirty-tracked. |
| `setRawAttributes(attrs)` | `void` | Replaces the whole store, no casts, no dirty-tracking reset. |
| `hasAttribute(key)` | `boolean` | |
| `unsetAttribute(key)` | `void` | |
| **Pre-save** | | |
| `getDirty()` | `Record<string, any>` | DB-shape values differing from the snapshot, exactly what the next `save()` writes. |
| `getDirtyAttributes()` | `Record<string, any>` | Same set, cast to model shape. |
| `isDirty(key?)` | `boolean` | No arg → any. A key, or a list of keys (**OR**, not AND). |
| `isClean(key?)` | `boolean` | Inverse of `isDirty()`. |
| `originalIsEquivalent(key)` | `boolean` | The per-key comparison `getDirty()` is built on. See below. |
| `discardChanges()` | `Model` | Throws away unsaved changes, restoring the snapshot. Also clears `getChanges()`. |
| **Post-save** | | |
| `getChanges()` | `Record<string, any>` | DB-shape attributes the **last** `save()` wrote. Empty after an insert. |
| `getChangedAttributes()` | `Record<string, any>` | Same set, cast to model shape. |
| `wasChanged(key?)` | `boolean` | No arg → any. A key, or a list of keys (**OR**). |
| `wasRecentlyCreated` | `boolean` | **Property, not a method.** Whether the last `save()` was an INSERT. |
| **Snapshot** | | |
| `getOriginal(key?)` | `any` | Last-synced value **cast to model shape**, or the whole snapshot. |
| `getRawOriginal(key?)` | `any` | Last-synced value in **DB shape** (no cast). |
| `syncOriginal()` | `void` | Copies attributes into the snapshot. |
| `syncChanges()` | `Model` | Copies the current dirty set into `changes`. Runs inside `save()`. |
| `markPersisted()` | `void` | `exists = true`, `wasRecentlyCreated = true`, `syncOriginal()`. |
| `exists()` | `boolean` | |
| `getKey()` | `SqlBinding` | The raw primary-key value. |
| `toObject()` | `Record<string, any>` | Plain DB-shape object. No casts, no relations. |
| `toJSON()` | `Record<string, any>` | Model-shape, honours `hidden`/`visible`, serializes relations. |

#### Create vs update semantics

|  | `wasRecentlyCreated` | `getChanges()` | `wasChanged()` |
|---|---|---|---|
| New instance, never saved | `false` | `{}` | `false` |
| After `create()` / insert `save()` | `true` | `{}` | `false` |
| After an update `save()` | unchanged | the written columns + stamped `updated_at` | `true` |
| After a **no-op** `save()` (nothing dirty) | unchanged | **unchanged**, the previous save's | unchanged |
| After `refresh()` | `false` | `{}` | `false` |
| After `discardChanges()` | unchanged | `{}` | `false` |
| Hydrated / finder result | `false` | `{}` | `false` |

`getChanges()` being **empty after a create** is Laravel's behaviour, not
an oversight: a create didn't *change* anything, it brought the row into
existence, and `wasRecentlyCreated` is the flag for that branch.

A no-op `save()` leaves `changes` alone rather than clearing it, so a
re-save inside a hook can't erase the record the hook exists to inspect.

The static `Model.update(id, attrs)` and the builder's `update()` operate
without an instance, so **neither participates in change tracking**.
There is nothing to record it on. `firstOrCreate()` / `updateOrCreate()`
return instances with `wasRecentlyCreated` set correctly.

```ts
const user = await User.firstOrCreate({ email });
if (user.wasRecentlyCreated) await sendWelcomeEmail(user);
```

#### What counts as a change

`originalIsEquivalent(key)` is the single comparison behind
`getDirty()`/`isDirty()`. A plain `Object.is` on stored values is right
for most columns and wrong for three that matter, so the check is
layered: identity, then, for a column with a `Cast`, equality of the
two **model-shape** values, then instant equality for a declared temporal
column, then Laravel's numeric-string rule.

| Case | Verdict | Why |
|---|---|---|
| `post.meta = { ...post.meta }` (equal contents) | **not** changed | Compared as parsed JSON, key order ignored. |
| `post.meta = { tags: ["a", "b"] }` over `{ tags: ["a"] }` | changed | Different contents. |
| `"2026-09-02 07:31:37"` vs `"2026-09-02T07:31:37.000Z"` | **not** changed | Same instant, two engines' spellings. |
| `views = 1` over a driver-returned `"1"` | **not** changed | MySQL/PG return `BIGINT`/`DECIMAL` as strings. |
| `price = 10` over `"10.00"` (`decimal(2)`) | **not** changed | Normalised through the cast. |
| A key absent from the snapshot | changed | Nothing to be equal to. |
| A value the cast can't decode | changed | Reported as changed rather than throwing. The write still happens. |

Without this, every `save()` after a read on MySQL would rewrite every
timestamp column and fire `updated` for it.

### `save()`: exact behaviour

`save()` branches on `exists()`. Both paths call `bootIfNotBooted()` first.

**Update path** (`exists() === true`):

1. If `getDirty()` is empty, **return immediately**: no query, no events.
2. If `timestamps` and `updatedAtColumn !== null` and that column isn't
   already dirty, stamp it with the current UTC time, spelled the way
   the connection's engine accepts (see
   [Dialect support](../database/#dialect-support), MySQL rejects the
   ISO `Z` suffix).
3. Fire `saving`, then `updating`: payload is the instance.
4. `UPDATE ... SET <dirty columns only> WHERE pk = ?`.
5. `syncChanges()`: while the dirty window is still open.
6. Fire `updated`, then `saved`.
7. `syncOriginal()`.

**Insert path** (`exists() === false`):

1. If `timestamps`, stamp `createdAtColumn` and `updatedAtColumn` (each
   only if `null`-disabled and not already set) with the same timestamp.
2. Fire `saving`.
3. **`assignGeneratedPrimaryKey()`**: if `incrementing === false` and the
   primary key is null/empty, call `newUniqueId()` and assign it.
4. Fire `creating`.
5. If `incrementing`: insert and read back the generated key, merging it
   in unless the caller supplied it. Otherwise: plain insert via
   `query().toBase().insert()`.
6. `exists = true`, `wasRecentlyCreated = true`, `changes = {}`,
   `syncOriginal()`.
7. Fire `created`, then `saved`.

The `newUniqueId()` placement between `saving` and `creating` is
deliberate. See [`newUniqueId()`](#newuniqueid) above.

Order is `saving → creating → insert → created → saved` and
`saving → updating → update → updated → saved`. `Model.create()` is
literally `new this(values)` followed by `save()`, so it runs the identical
path.

#### Why the update path syncs the snapshot *last*

Steps 5–7 above are ordered to mirror Laravel's `finishSave()`, and the
ordering is what makes the past-tense hooks useful. Inside `updated`,
`getChanges()` reports what was just written **and** `getOriginal()` still
reports the value it was written over, so a hook can compare the two:

```ts
Order.on("updated", (order) => {
  if (order.wasChanged("status")) {
    notify(order.getOriginal("status"), order.status);   // from → to
  }
});
```

Syncing before the events would collapse `getOriginal()` onto the new
value and make that comparison impossible to express. The `-ing` hooks
see the mirror image: `updating` gets `isDirty("status")` and a mutable
instance whose changes still reach the `UPDATE`.

The cost is that the instance still reads as **dirty** inside `updated`
and `saved` (the snapshot hasn't moved yet), so calling `save()` on the
same instance from one of those hooks re-issues the write instead of
no-opping. Mutate in `saving`/`updating` instead.

The insert path syncs *before* its events because there is no prior value
to compare against, every attribute's original is the value just
inserted, so a `created` hook correctly sees a clean instance.

### Writing, reloading, copying

| Method | Returns | Notes |
|---|---|---|
| `fill(attrs)` | `Model` | Mass-assigns, honouring `fillable`/`guarded`. Casts in. |
| `forceFill(attrs)` | `Model` | Same, bypassing the policy. |
| `save()` | `Promise<Model>` | See above. |
| `updateInstance(attrs)` | `Promise<Model>` | `fill()` then `save()`. |
| `deleteInstance()` | `Promise<void>` | Routes through the **static** `delete()`. |
| `refresh()` | `Promise<Model>` | Re-reads the row, replaces attributes + snapshot. |
| `replicate()` | `Model` | Unsaved copy, primary key and timestamps stripped. |

`deleteInstance()` calling the static `delete()` is what makes an instance
delete on a `SoftDeletes` model *soft*-delete: `SoftDeletes` overrides the
static, and the instance method routes through it. It also sets
`exists = false` afterwards.

`refresh()` is a no-op if the row is gone. It leaves the instance
untouched rather than blanking it.

`replicate()` strips `primaryKeyColumn` and, if `timestamps`, both
timestamp columns. The returned instance is fresh and unsaved, so
`save()` on it inserts.

### Relations on an instance

| Method | Returns |
|---|---|
| `load(...names)` | `Promise<Model>`: batched via the eager loader |
| `loadMissing(...names)` | `Promise<Model>`: skips already-loaded relations |
| `setRelation(name, value)` | `Model` |
| `unsetRelation(name)` | `Model`: clears a loaded relation |
| `getRelation(name)` | `unknown` |
| `relationLoaded(name)` | `boolean` |
| `relations` (getter) | `Record<string, () => EloquentBuilder>`, reads *and* [writes](../relationships/#writing-relationships) |

See [Relationships](../relationships/) for the full picture.

### Appended attributes

An "appended attribute" is a named non-column value attached to an
instance:

```ts
post.append("likesCount", 42);
post.setAppended("likedByCurrentUser", true);   // identical; append() calls this
post.hasAppended("likesCount");                 // true
post.getAppended("likesCount");                 // 42
post.likesCount;                                // 42 — reads through the proxy
```

The value reads back off the instance and is available to a `Resource` via
`whenAppended(name)`, but it is deliberately **not** part of `toJSON()`'s
default column serialization, shaping the wire format is the resource's
job, not the model's.

The canonical use is a per-page batched value that a per-row computation
couldn't derive without an N+1, aggregate counts, current-user flags:

```ts
const [likesCounts, repostsCounts] = await Promise.all([
  Like.query().whereIn("post_id", ids).countBy("post_id"),
  Repost.query().whereIn("post_id", ids).countBy("post_id"),
]);

for (const post of posts) {
  post.setAppended("likesCount", likesCounts.get(post.id) ?? 0);
  post.setAppended("repostsCount", repostsCounts.get(post.id) ?? 0);
}
```

### `toObject()` vs `toJSON()`

They are not interchangeable.

| | `toObject()` | `toJSON()` |
|---|---|---|
| Shape | DB shape (raw) | Model shape (casts applied) |
| `hidden` / `visible` | Ignored | Honoured |
| Loaded relations | Excluded | Included, recursively serialized |
| Appended values | Excluded | Excluded |

`toObject()` is what you hand to something that wants row data, a
policy, a raw insert. `toJSON()` is what `JSON.stringify(instance)` uses,
and therefore what any JSON response serializing an instance directly
produces.

`visible` beats `hidden`: when `visible` is non-empty, only its members
appear and `hidden` is not consulted at all.

```ts
const include = (key: string): boolean =>
  visible.length > 0 ? visible.includes(key) : !hidden.has(key);
```

The filter applies to loaded relation names too, so `hidden = ["author"]`
strips a loaded `author` relation from the output.

### `toJsonResource()`

Returns this model's default `Resource` instance, or `undefined` (the
base implementation). Consumed by `Resource`'s output normalization, so a
loaded relation model automatically serializes through its own resource:

```ts
export class Post extends Model<PostAttributes>()({ table: "posts" }) {
  override toJsonResource(): PostResource {
    return new PostResource(this);
  }
}
```

Plain `this` is correct here. See the proxy section immediately below.
See [Responses](../responses/) for resources.

## The proxy: read this section

Every `Model` instance is wrapped in a `Proxy`. That's what makes
`post.body` and `post.published` read and write casted attributes
directly, and what makes loaded relations and appended values resolve as
plain property reads. It is a small, deliberate use of a `Proxy` and the
payoff is real. One sharp edge remains.

### `this` inside an instance method

The `get` trap binds every function it returns to the **receiver**, the
proxy, when that is what the caller holds:

```ts
get(target, prop, receiver) {
  if (prop in target) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== "function") return value;
    if (prop === "constructor") return value;
    return value.bind(receiver ?? target);
  }
  if (target.relationLoaded(prop)) return target.getRelation(prop);
  if (target.hasAppended(prop)) return target.getAppended(prop);
  return target.getAttribute(prop);
}
```

So inside an instance method `this` is the proxy, and attribute reads off
`this` **do** go through the casting layer. This is what lets a method
read its own columns:

```ts
class Post extends Model<PostAttributes>()({ table: "posts", casts: { published: Cast.boolean() } }) {
  isLive(): boolean {
    return this.published && this.published_at !== null;   // both casted
  }
}
```

`this.toObject()` is the right call when the consumer wants plain
row data rather than a live instance, policies, gates, raw inserts.

### Enumeration sees columns only: not relations or appends

```ts
ownKeys(target) {
  return Object.keys(target.toObject());
}
```

`ownKeys` supplies the *names* (the model's real columns) while
`getOwnPropertyDescriptor` supplies the *values*, and that one casts. So
enumerating an instance gives model-shape values, consistently:

```ts
Object.keys(post);          // ["id", "user_id", "published", ...]
{ ...post };                // published is `false`, not 0 — casts applied
Object.entries(post);       // same
```

What enumeration does *not* include is **loaded relations and appended
values**, because neither is a column and neither appears in
`toObject()`:

```ts
const post = await Post.query().with("comments").firstOrFail();
post.comments;              // the loaded Collection — a direct read works
{ ...post }.comments;       // undefined — not enumerable
post.toJSON().comments;     // present
```

Use `toJSON()` when you want the serialisable model shape *including*
relations and appends, and `toObject()` when you want the raw DB row.
Spreading sits between the two and is rarely what you want.

### What the other traps do

| Trap | Behaviour |
|---|---|
| `set` | Unknown string key → `setAttribute()` (casts in). Known key → normal set. |
| `has` | `true` for any stored attribute, else `Reflect.has`. |
| `deleteProperty` | Removes a stored attribute, else `Reflect.deleteProperty`. |

Note that `set` writing through `setAttribute()` **bypasses
`fillable`/`guarded`**, mass-assignment protection covers `fill()`, not
deliberate single-column assignment.

## Casts

A `Cast` is a plain object carrying both directions of a conversion plus,
via its two type parameters, the model-facing and database-facing types:

```ts
interface Cast<ModelType, DbType> {
  toModelType(dbValue: DbType): ModelType;
  toDatabaseType(modelValue: ModelType | DbType): DbType;
}
```

Keys are checked against real columns, and each cast's model type must
equal the column's declared type, a `Cast.datetime()` on a `string`
column is a compile error, not a surprise at runtime:

```ts
import { Model, Cast } from "@mahiframework/database";

export class Post extends Model<PostAttributes>()({
  table: "posts",
  casts: {
    published: Cast.boolean(),
    meta: Cast.json(),
    created_at: Cast.datetime(),
  },
}) {}
```

```ts
post.published;    // boolean — the DB stores 0/1
post.meta;         // the parsed object
post.created_at;   // a DateTime instance
```

### Built-in casts

Every cast is a **factory** on the `Cast` namespace, call it:
`published: Cast.boolean()`, `amount: Cast.decimal(2)`.

| Cast | Model type | DB type | Behaviour |
|---|---|---|---|
| `Cast.integer()` | `number` | `number \| string` | `Math.trunc(Number(v))` both directions. |
| `Cast.float()` | `number` | `number \| string` | `Number(v)`, no truncation. |
| `Cast.string()` | `string` | `string \| number` | `String(v)` both directions. |
| `Cast.boolean()` | `boolean` | `number \| boolean` | Reads `!== 0`; writes `1`/`0`. |
| `Cast.decimal(precision)` | `string` | `number \| string` | `Number(v).toFixed(precision)`. |
| `Cast.array<T>()` | `T[]` | `string` | `JSON.parse` / `JSON.stringify`. Already-array passes through. |
| `Cast.json<T>()` | `T` | `string` | Same encoding, not array-specific. |
| `Cast.datetime()` | `DateTime` | `string \| Date` | Reads ISO-8601, MySQL's `YYYY-MM-DD HH:MM:SS`, or a `Date` (all as UTC); writes ISO-8601, **converted to UTC first**. |
| `Cast.enum([...])` | the member union | same | Constrains to the listed members. |

`Cast.decimal()` keeps money-like values as fixed-precision *strings* on
the model side rather than numbers, to avoid binary-float precision loss.

A cast's model type must **equal** the column's declared type. That is
the check that makes `published: boolean` + `Cast.boolean()` agree, and
makes a mismatched pair a compile error rather than a runtime surprise.
So declare the column as what you want to read back:

```ts
interface DocAttributes {
  meta: Record<string, unknown>;
}

// The cast's `T` and the column's declared type have to match.
casts: { meta: Cast.json<Record<string, unknown>>() }
```

`Cast.json<T>()` is a **claim, not a validation**: nothing checks the
parsed value against `T`, exactly as with `JSON.parse`. That is the right
trade for a column the application itself writes, and the wrong one for
untrusted input, which wants a schema rather than a cast.

`Cast.boolean()` stores `0`/`1` because SQLite has no native boolean.
Which is exactly why the type-lint insists a `boolean` column declares
it.

The lenient `DbType` unions are on purpose: `toDatabaseType` accepts
`ModelType | DbType`, so `post.view_count = "34534534"` (a string) is as
valid as `post.view_count = 34534534`.

### `null` passes straight through

**Every built-in short-circuits on `null` and `undefined`, in both
directions.** A nullable column stays nullable regardless of cast. A
`null` `created_at` reads back as `null`, not as an invalid `DateTime`.

Custom casts should do the same:

```ts
function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
```

### Writing a custom cast

Any object matching the interface works. No registration step:

```ts
import type { Cast } from "@mahiframework/database";

/** A comma-separated text column ↔ a string array. */
export const CsvCast: Cast<string[], string> = {
  toModelType(dbValue) {
    if (dbValue === null || dbValue === undefined) return dbValue as never;
    return dbValue === "" ? [] : dbValue.split(",");
  },
  toDatabaseType(modelValue) {
    if (modelValue === null || modelValue === undefined) return modelValue as never;
    return Array.isArray(modelValue) ? modelValue.join(",") : String(modelValue);
  },
};
```

Parameterized casts are functions returning a `Cast`, like `decimal()`:

```ts
export function enumCast<T extends string>(allowed: readonly T[]): Cast<T, string> {
  return {
    toModelType: (v) => v as T,
    toDatabaseType: (v) => String(v),
  };
}
```

### Where casts apply, and where they don't

**Applied** on `getAttribute()` / `setAttribute()`, proxy reads and
writes, `fill()`, `forceFill()`, `new Model({...})`, `toJSON()`, and on
every value the **query builder binds**, in both directions:

```ts
Post.query().where("published", true);              // binds 1
Post.query().whereIn("published", [true, false]);   // binds 1, 0
Post.query().where("published_at", someDateTime);   // binds the ISO string
await Post.query().where(…).update({ published: true, meta: { a: 1 } });
```

So you write model-shape values everywhere and the DB shape is the
framework's problem. This covers `where`/`orWhere`/`whereNot`/
`whereIn`/`whereNotIn`/`whereBetween` and the write path
(`insert`/`update`/`upsert`/`updateOrInsert`/`increment`'s extra
payload), plus `Factory`'s `definition()`. A factory writes model-shape
values too.

Casts are idempotent by contract (`toDatabaseType` accepts
`ModelType | DbType`), so passing a DB-shape value stays correct:
`where("published", 1)` also works.

Casts only fire for a column the model **declares** one for. Underneath
them sits a second, unconditional layer, binding normalisation, which
converts a `DateTime`/`Date` to UTC text, a `bigint` to a key, and a
model instance to its own key, for *any* column, including on a
`DB.table()` query with no model at all:

```ts
// `expires_at` is typed `string` with no cast — normalisation still applies
Token.query().where("expires_at", "<=", DateTime.now()).delete();

Post.query().where("user_id", user);   // binds user.getKey()
```

Datetime columns are assumed to store **UTC**, and both layers convert on
the way in, so `DateTime.now()` (system zone) and `DateTime.now("UTC")`
bind identically. See [queries](../queries/README.md#bound-values).

**Not** applied on: `hydrate()` and `setRawAttributes()` (both store raw
DB values by design), `getRawAttribute()`, `toObject()`, `whereRaw()`
bindings (raw SQL is raw), and `DB.table()`. The low-level builder is
model-unaware, so it has no cast map to consult:

```ts
await Post.query().where("published", true).get();   // ✓ cast applied
await DB.table("posts").where("published", true).get();  // ✗ no model, no cast
```

An uncast column is always left strictly alone, and a column whose name
is not in the cast map (an alias, a `withCount()` result, a raw
expression) passes through untouched.

## Soft deletes

```ts
import { Model } from "@mahiframework/database";

export class Post extends Model<PostAttributes>()({
  table: "posts",
  softDeletes: true,   // PostAttributes must declare `deleted_at`
}) {}
```

The attributes interface needs a nullable `deleted_at` (a
`DateTime | null`), and the table needs the matching column,
`table.softDeletes()` in a migration. Use the object form to name a
different column: `softDeletes: { column: "archived_at" }`.

Configuring soft deletes is also what makes `trashed()`, `restore()` and
`forceDelete()` meaningful on an instance.

The factory installs a `SoftDeleteScope` global scope
(`whereNull("posts.deleted_at")`, qualified with the table, so it
survives a `join()` against another table that also has a `deleted_at`),
so every `query()` excludes trashed rows.

**Static:**

| Method | Behaviour | Events fired |
|---|---|---|
| `delete(id)` | `UPDATE ... SET deleted_at = now()` | `deleting` → `deleted` |
| `forceDelete(id)` | Real `DELETE` | `deleting` → `deleted` |
| `restore(id)` | `UPDATE ... SET deleted_at = null` | `restoring` → `restored` |
| `withTrashed()` | Builder including trashed rows | — |
| `onlyTrashed()` | Builder with `whereNotNull("deleted_at")` | — |

**On the builder** (`Post.query()…`):

| Method | Behaviour |
|---|---|
| `delete()` | Soft-deletes every matching row |
| `forceDelete()` | Real `DELETE` on every matching row |
| `restore()` | Clears `deleted_at` on every matching row |

**On an instance:**

| Method | Behaviour |
|---|---|
| `trashed()` | Whether this instance is soft-deleted (`false` on non-soft-deleting models) |
| `restore()` | Un-deletes it, in the DB and on the loaded attributes |
| `forceDelete()` | Permanently removes the row |
| `deleteInstance()` | Soft-deletes (routes through the static `delete()`) |

Soft delete fires the *same* events as a hard delete, soft delete is
delete lifecycle, just via `UPDATE` instead of `DELETE`. There is no
distinct `softDeleting` event. `forceDelete()` fires them too, because it
bypasses the base `Model.delete()` entirely (which `SoftDeletes` has
overridden) and so needs its own event wrapping.

The static three load the row first (bypassing scopes, so an
already-trashed row still resolves) so the event payload is a real
instance rather than a bare `{ id }` object.

### The builder soft-deletes too

`Post.query().where(...).delete()` is an `UPDATE ... SET deleted_at`, not
a `DELETE`:

```ts
await Post.query().where("user_id", id).delete();       // soft — recoverable
await Post.query().where("user_id", id).forceDelete();  // real DELETE
```

A builder that hard-deleted rows a soft-deleting model promises are
recoverable is silent, unrecoverable data loss, and the failure is
invisible until someone tries to restore. Call `forceDelete()`
explicitly when you mean it.

`restore()` pairs with `onlyTrashed()`/`withTrashed()`, since the default
scope hides exactly the rows it acts on:

```ts
await Post.onlyTrashed().where("user_id", id).restore();
```

### `withTrashed()` drops only the soft-delete scope

```ts
static withTrashed() {
  return this.withoutGlobalScope(SoftDeleteScope);
}
```

Other global scopes still apply: "show me the deleted ones too" is not
"show me every other tenant's rows too". `onlyTrashed()` is the same,
plus `whereNotNull("deleted_at")`. Use `queryWithoutScopes()` when you
genuinely want every scope gone.

### Persistence ignores global scopes

`save()`, `Model.update(id, …)`, `refresh()` and the delete paths go
through `Model.newModelQuery()` (Laravel's name for it), which applies
**no** global scopes, so they work on a trashed instance:

```ts
const post = await Post.find(id);
await Post.delete(id);

post.title = "Renamed";
await post.save();          // ✓ persists — the scope doesn't gate the write
```

Through `query()` these compiled `UPDATE … WHERE id = ? AND deleted_at IS
NULL`, matched zero rows, and silently wrote nothing. The same applied to
any global scope whose column the write itself was changing (a tenancy
scope during a tenant transfer, a publish-state scope during publishing).

Reads keep using `query()`: excluding trashed rows from `find()`/`all()`
is exactly what a global scope is for.

## Global scopes

A cross-cutting default filter applied to every `query()` call:

```ts
interface GlobalScope<TRow = any> {
  apply(builder: EloquentBuilder<TRow>): void;
}
```

`apply()` mutates the builder in place and returns nothing, matching the
builder's own chainable style.

```ts
class TenantScope implements GlobalScope {
  apply(builder: EloquentBuilder<any>): void {
    builder.where("tenant_id", currentTenantId());
  }
}

export class Invoice extends Model<InvoiceAttributes>()({ table: "invoices" }) {
  static override scopes = [new TenantScope()];
}
```

Or install one from `boot()`, which is what soft deletes do:

```ts
export class Invoice extends Model<InvoiceAttributes>()({ table: "invoices" }) {
  static override boot(): void {
    this.addGlobalScope(new TenantScope());
  }
}
```

`addGlobalScope()` clones the array from the parent first when `scopes` is
still inherited, so `this.scopes.push(...)` can't leak onto `Model.scopes`
or a sibling model.

Bypassing:

| Call | Effect |
|---|---|
| `query()` | Every declared scope applied. |
| `queryWithoutScopes()` | No scopes. |
| `newModelQuery()` | No scopes: the name persistence uses. |
| `withoutGlobalScope(TenantScope)` | Every scope except that class. |
| `withoutGlobalScopes([A, B])` | Every scope except those classes. |
| `withoutGlobalScopes()` | No scopes: same as `queryWithoutScopes()`. |

Matching is `scope instanceof ScopeClass`.

Global scopes gate **reads**, not writes: `save()`/`update()`/`refresh()`
and the delete paths all go through `newModelQuery()`. See
[Persistence ignores global scopes](#persistence-ignores-global-scopes).

A scope's `apply()` receives the builder, and `builder.getModel()` gives
it the model class. Which is how `SoftDeleteScope` qualifies its column
with the table name and stays join-safe. Prefer qualifying any column a
scope filters on, for the same reason.

## Model events

### The event names

```ts
type ModelEventName =
  | "retrieved"
  | "creating"  | "created"
  | "updating"  | "updated"
  | "saving"    | "saved"
  | "deleting"  | "deleted"
  | "restoring" | "restored";
```

Ordering by operation:

| Operation | Sequence |
|---|---|
| Insert (`create()`, `save()` on a new instance, `Factory.create()`) | `saving` → `creating` → INSERT → `created` → `saved` |
| Update (`update()`, `save()` on a dirty existing instance) | `saving` → `updating` → UPDATE → `updated` → `saved` |
| Delete (`delete()`, `deleteInstance()`, `forceDelete()`) | `deleting` → DELETE/UPDATE → `deleted` |
| Restore (`SoftDeletes.restore()`) | `restoring` → UPDATE → `restored` |
| Hydration from a query | `retrieved` |

`saving`/`creating` receive the *same object* that is about to be written,
so mutating it in place changes what gets persisted:

```ts
Post.on("creating", (post: any) => {
  post.body = post.body.trim();   // this is what gets inserted
});
```

#### What each hook can see

The `-ing` and past-tense hooks look at opposite windows of the same
write. On an instance-driven save:

| Hook | `isDirty()` | `wasChanged()` | `getOriginal()` |
|---|---|---|---|
| `saving` / `updating` | the pending write | not yet populated | pre-write value |
| `updated` / `saved` | still true (snapshot syncs last) | the written columns | **still the pre-write value** |
| `created` / `saved` (insert) | `false` | `false` (see below) | the inserted value |

That `updated` sees both `wasChanged("status")` and the old
`getOriginal("status")` is deliberate. See
[Why the update path syncs the snapshot last](#why-the-update-path-syncs-the-snapshot-last).
On the insert path `wasRecentlyCreated` is the flag to branch on, not
`wasChanged()`.

Mutate in the `-ing` hooks only. A `save()` from inside `updated`/`saved`
re-issues the write rather than no-opping, because the snapshot has not
synced yet.

### `retrieved` is effectively opt-in

`EloquentBuilder.get()`/`first()`/`chunk()`/`lazy()` call
`fireRetrieved()` per hydrated instance, but that method short-circuits:

```ts
static async fireRetrieved(instance: Model): Promise<void> {
  if (!hasModelListeners(this, "retrieved")) return;
  await dispatchModelEvent(this, "retrieved", instance as never);
}
```

`hasModelListeners()` only checks **observers and `on()` listeners**. It
does *not* account for `dispatchesEvents` or for app-wide
`EventDispatcher` listeners on the generic `ModelRetrieved` class. So a
`dispatchesEvents: { retrieved: ... }` mapping alone will **never fire**.
You must also register an observer or an `on("retrieved", ...)` listener
for the model.

That's deliberate: `retrieved` fires once per hydrated row on every read,
so the guard keeps ordinary query reads cheap. Its use case
(cache-warming, audit-on-read) is opt-in by nature.

### Observers

```ts
import { ModelObserver } from "@mahiframework/database";

class PostObserver extends ModelObserver<Post> {
  override created(post: Post): void {
    searchIndex.add(post.id);
  }

  override deleted(post: Post): void {
    searchIndex.remove(post.id);
  }
}

Post.observe(PostObserver);
```

Every method on `ModelObserver` is optional, override only the ones you
care about. The observer is instantiated **once, immediately**, with no
constructor arguments. Don't hold per-request state on it; it's shared
across every call.

Registration is keyed by **class identity, not `table`**, so a subclass
doesn't inherit its base class's observers or vice versa. Multiple
`observe()` calls stack and run in registration order.

### Ad-hoc listeners

```ts
Post.on("created", (post) => { /* ... */ });
```

A lighter alternative for a one-off or test-only hook. Same payload rules.

### `dispatchesEvents`

Maps a lifecycle event to an `@mahiframework/events` `Event` class dispatched
through the app's `EventDispatcher`:

```ts
class PostCreated extends AbstractEvent {
  constructor(public readonly post: Post) { super(); }
}

export class Post extends Model<PostAttributes>()({ table: "posts" }) {
  static override dispatchesEvents: DispatchesEventsMap = {
    created: PostCreated,
  };
}
```

Only fires when `EventsServiceProvider` has been registered, a model used
in a script that never bootstrapped events support simply never
dispatches, rather than throwing.

### The generic lifecycle events

Independently of `dispatchesEvents`, **every** model write dispatches a
generic `ModelLifecycleEvent` subclass through the `EventDispatcher`:
`ModelRetrieved`, `ModelCreating`, `ModelCreated`, `ModelUpdating`,
`ModelUpdated`, `ModelSaving`, `ModelSaved`, `ModelDeleting`,
`ModelDeleted`, `ModelRestoring`, `ModelRestored`.

Each carries `model` (the class), `payload`, and an `eventName` of
`"model.{table}.{event}"`. This is the seam for app-wide cross-cutting
listeners that want "something was created", not one specific model's
named event:

```ts
class AuditLog implements Listener<ModelCreated> {
  handle(event: ModelCreated) {
    log(`${event.model.name} created`, event.payload);
  }
}
```

### Dispatch order

`dispatchModelEvent()` runs, awaiting each step sequentially:

1. Registered `ModelObserver` methods, in registration order.
2. `Model.on()` listeners, in registration order.
3. The generic `ModelLifecycleEvent` subclass: **only if `EVENTS_TOKEN`
   is bound**. If it isn't, the function returns here and step 4 never
   runs.
4. The model's own `dispatchesEvents[event]` class, if declared.

### Suppression

```ts
await Post.withoutEvents(async () => {
  await Post.create({ ... });   // no observers, no listeners, no dispatch
});
```

Builds a wildcard pattern from `table`, `"model.posts.*"`, and delegates
to `@mahiframework/events`' `Event.suppress()`. It suppresses **only that model's
events**; every other model and every non-model event is unaffected.

Called on the base `Model` class directly (which has no `table`), the
pattern widens to `"model.*"`, every model's events.

It is `AsyncLocalStorage`-scoped, so nested and async calls made inside the
callback also see events suppressed, and patterns **stack** with any
enclosing `suppress()` call rather than replacing it.

**Timestamp stamping is not suppressed**. That's a separate concern.
`Factory.createQuietly()` relies on this: rows still get
`created_at`/`updated_at`, just without firing events.

Suppression is checked in two places, because observers and `on()`
listeners are invoked directly rather than through the `EventDispatcher`:
`dispatchModelEvent()` checks `AbstractEvent.isSuppressed()` itself before
step 1, and the dispatcher checks again for steps 3–4.

### Events and transactions

Model events fired inside a `transaction()` callback that later rolls back
have **already run**. See the footgun section in
[Database](../database/#the-footgun-events-fire-even-on-rollback).

## Custom builders

Override `static query()`:

```ts
// src/builders/post.builder.ts
export default class PostBuilder extends EloquentBuilder<PostAttributes> {
  forFeed(authorIds: string[]): this {
    return this.whereNull("parent_id").where((q) =>
      q.whereIn("user_id", authorIds).orWhereIn("id", (sq) =>
        sq.table("reposts").select("post_id").whereIn("user_id", authorIds),
      ),
    );
  }
}
```

```ts
export class Post extends Model<PostAttributes>()({ table: "posts" }) {
  /** The single builder override point — `Post.query()` returns `PostBuilder`. */
  static query(): PostBuilder {
    this.bootIfNotBooted();
    const builder = new PostBuilder(this);
    for (const scope of this.scopes) scope.apply(builder);
    return builder;
  }
}

await Post.query().forFeed(ids).get();
```

Overriding `static query()` is the single override point: it is what
every other entry point routes through, so the custom builder is what
you get everywhere. The old `declare static Builder` type-only marker is
gone. The override's return type *is* the narrowing now. See
[Queries](../queries/).

## Common errors

**`ModelNotFoundError`**, thrown by `findOrFail()` and `firstOrFail()`:

```
No query results for model "Post" with id "42".
```

**`MassAssignmentError`**, thrown by `fill()` on a totally-guarded model.

**`boolean column needs a Cast.boolean(): x`**, a `boolean` column in
the attributes interface with no cast declared. Add `Cast.boolean()`;
see [the type-lint](#the-type-lint).

**`column collides with a reserved model member: x`**, a column named
after an instance method (`save`, `delete`, `fill`, …). Rename the
column, or map it to a different property.

**`Post has no factory — override "static factory()" ...`**, calling
`factory()` on a model that doesn't override it.

**`Model [Post] cannot be registered for serialization: it has no static
morphName.`**: a provider's `models()` hook listed a model without a
`morphName`.
