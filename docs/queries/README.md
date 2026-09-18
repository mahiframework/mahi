# Queries

Two builders, layered.

`QueryBuilder<TRow>` is the low-level, table-scoped builder, Laravel's
`Illuminate\Database\Query\Builder`. No model awareness at all: a table
name, a lazily-resolved connection, and accumulated where/order/limit
state, executed on demand.

`EloquentBuilder<TRow, TRelations>` wraps it by **composition**, adding
model awareness: hydration into instances, `retrieved` events,
`whereKey()`, eager loading, and the relation-existence family. It
manually redefines every chainable method and delegates, no `__call`
forwarding, so renaming a method on `QueryBuilder` is a compile error, not
a runtime surprise.

```ts
Post.query()                 // EloquentBuilder<PostTable, typeof Post.relations>
Post.query().toBase()        // QueryBuilder<PostTable>
```

## Starting a query

Three entry points, in the order you should prefer them:

```ts
Post.query()                 // EloquentBuilder — a model exists for this table
DB.table("post_hashtag")     // QueryBuilder — no model, model-free rows
new QueryBuilder(() => kysely, "posts")   // explicit connection, no container
```

`Model.query()` is the default: hydrated instances, casts, events, eager
loading, relation-existence queries, and any global scopes the model
declares.

`DB.table(name)` hands you the low-level builder directly, for tables with
no model, pivots, reporting views, ad-hoc reads. Everything below applies
to it except the `EloquentBuilder`-only sections. It is model-free in every
sense, which includes **skipping global scopes**:

```ts
await Post.query().get();        // soft deletes apply — live rows only
await DB.table("posts").get();   // every row, including soft-deleted ones
```

Supply a row type to get the same column checking a model builder has;
without one every column is `any`:

```ts
await DB.table("users").where("first_name", "John").get();
await DB.table<UserTable>("users").where("first_name", "John").get();
```

See [Database](../database/#dbtable) for connection and transaction
behaviour.

## Two things to know up front

### Every chainable method mutates `this`

```ts
const base = Post.query().where("published", 1);
base.where("featured", 1);   // `base` now has BOTH conditions
```

This matches Laravel's ergonomics and keeps the implementation simple, but
it means a builder is not a value you can branch from freely. `clone()` is
the explicit escape hatch:

```ts
const base = Post.query().where("published", 1);
const featured = await base.clone().where("featured", 1).get();
const recent = await base.orderByDesc("created_at").limit(10).get();
```

### The where store is a tree with no operator precedence

Every `where*()` pushes a node onto a tree. Each node carries its own
`and`/`or` connector, and the list is folded **strictly left to right**:

```ts
let result = compileNode(nodes[0]);
for (let i = 1; i < nodes.length; i++) {
  result = nodes[i].connector === "or"
    ? eb.or([result, expr])
    : eb.and([result, expr]);
}
```

There is no `AND`-binds-tighter-than-`OR` rule. So:

```ts
Post.query().where("a", 1).orWhere("b", 2).where("c", 3);
// ((a = 1 OR b = 2) AND c = 3)   ← left-to-right fold
// NOT: (a = 1 OR (b = 2 AND c = 3))
```

**Grouping is explicit, via a callback.** A callback builds a nested tree
and merges it in as one group node:

```ts
Post.query()
  .where("active", 1)
  .where((q) => q.where("role", "admin").orWhere("role", "owner"));
// WHERE active = 1 AND (role = 'admin' OR role = 'owner')
```

Write the parentheses you mean. Don't rely on precedence that isn't there.

On `EloquentBuilder`, the nested callback receives a **fresh builder of
the same subclass**, constructed off the current builder's own
constructor, so a nested group inside a custom builder can still call that
subclass's own scope methods:

```ts
Post.query().where("published", 1).where((q) =>
  (q as PostBuilder).featured().orWhere("pinned", 1),
);
```

## Where clauses

Every method below exists on both builders with an identical signature.
The `or*` sibling pushes the same node with an `"or"` connector.

### Basic

```ts
where(column, value)                  // implicitly "="
where(column, operator, value)
where(callback)                       // grouped
```

| Method | `or` sibling | Notes |
|---|---|---|
| `where` | `orWhere` | |
| `whereNot` | `orWhereNot` | Wraps the expression in `NOT` |

Operators are a closed union, no arbitrary strings:

```ts
type WhereOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "is" | "is not";
```

`whereNot` also accepts a callback, giving `NOT (...)` over a group.

### Bound values

You do not serialise values yourself. Every place the builder binds a
value, a `where()` comparand, a `whereIn()` list, a `whereBetween()`
bound, a raw binding, a `having()`, an `insert()`/`update()` payload,
accepts a `Bindable`:

```ts
type Bindable = string | number | boolean | null | DateTime | Date | bigint | Model;
```

| Passed | Bound as |
|---|---|
| `DateTime` | ISO text, **always converted to UTC** (MySQL gets its space-separated spelling) |
| `Date` | the same |
| `bigint` | itself — every driver binds one, and it is what a 64-bit column reads back as |
| a model instance | its primary key (`getKey()`) |

So the datetime spelling is just the value:

```ts
// Write this
PersonalAccessToken.query().where("expires_at", "<=", DateTime.now()).delete();

// Not this
PersonalAccessToken.query().where("expires_at", "<=", DateTime.now("UTC").toISOString()).delete();
```

**Datetime columns are assumed to store UTC**, and conversion happens on
the way in, so `DateTime.now()` (which carries the *system* zone) and
`DateTime.now("UTC")` bind identically. This matters more than it looks:
`DateTime.toISOString()` renders in the instance's own zone, so a
hand-serialised `DateTime.now()` in a `+08:00` zone produces
`...T14:30:00.000+08:00`, which MySQL rejects outright and which SQLite
and Postgres `timestamp` store as 14:30 *UTC*, an eight-hour silent
shift. Letting the builder do it removes that class of bug.

A model instance binds as its key, so a foreign-key comparison reads
directly:

```ts
Post.query().where("user_id", user).get();      // same as user.getKey()
Post.query().whereIn("user_id", [alice, bob]).get();
```

Normalisation is **unconditional**. It does not depend on the model
declaring a cast, and it applies to `DB.table()` queries that have no
model at all. It is also independent of the [cast](../models/README.md)
layer: a column declaring `Cast.datetime()` converts through the cast,
everything else through this. Either way the value reaching the driver
is UTC text.

Plain objects and arrays are deliberately *not* auto-serialised, use
`Cast.json()` / `Cast.array()`, so a mistyped value fails loudly instead
of silently landing in the column as `[object Object]`.

`getBindings()` and `toSql()` report values **after** normalisation, so
what you see when debugging is what the driver receives.

### `IN`

```ts
whereIn(column, values)       // values: TRow[K][] | Subquery
orWhereIn
whereNotIn
orWhereNotIn
```

The second argument accepts a plain array **or** a `Subquery`, a
callback, an already-built `QueryBuilder`, or an `Expression`. There is
deliberately no separate `whereInSubquery()` name; this matches Laravel's
own overload.

```ts
Post.query().whereIn("id", ["1", "2", "3"]);

Post.query().whereIn("id", (q) =>
  q.table("post_hashtag").select("post_id").where("hashtag_id", "=", tagId),
);

Post.query().whereIn("user_id", Follow.query().toBase().select("followed_id"));

Post.query().whereIn("id", Expression.raw("select post_id from likes where user_id = ?", [uid]));
```

Inside a subquery callback you get a fresh, unbound `QueryBuilder`. Call
`table()` to bind it (the equivalent of Kysely's `selectFrom()`) and
`select()` to project a single column. A single-column projection is what
makes the compiled SQL valid as an `IN (...)` operand. The callback's
return value is ignored; the passed-in builder's final state is what
compiles.

**An empty array is safe.** `in ()` is a syntax error on MySQL and
Postgres, so an empty list compiles to a constant instead (matching
Laravel): `whereIn` with nothing to match matches nothing, and
`whereNotIn` matches everything.

```ts
await Post.query().whereIn("id", []).get();      // []
await Post.query().whereNotIn("id", []).get();   // every row
```

This matters because these lists usually come from user input, a filter
built from an empty selection shouldn't 500.

### `NULL`

```ts
whereNull(column)        orWhereNull
whereNotNull(column)     orWhereNotNull
```

### `BETWEEN`

```ts
whereBetween(column, min, max)       orWhereBetween
whereNotBetween(column, min, max)    orWhereNotBetween
```

### Column comparison

```ts
whereColumn(first, operator, second)     orWhereColumn
```

Operator is required here. There's no two-argument form.

### `EXISTS`

```ts
whereExists(subquery)        orWhereExists
whereNotExists(subquery)     orWhereNotExists
```

Same `Subquery` union as `whereIn`.

### Raw

```ts
whereRaw(sql, bindings?)     orWhereRaw
```

`?` placeholders are matched positionally against `bindings` and always
sent as real parameters, never string-interpolated.

A `?` counts as a placeholder only when it is **outside quotes** and isn't
part of a multi-character operator, so these all mean what they look like:

```ts
whereRaw("note like '%?%'")                 // literal ? inside a string
whereRaw(`"tags" ?| '{a,b}'`)               // Postgres JSON "has any key"
whereRaw(`"tags" ?? 'urgent'`)              // `??` escapes a literal ?
whereRaw("name != 'it''s ? here'")          // escaped quote inside a literal
```

`'...'` string literals and `"..."`/`` `...` `` identifiers are all
recognised, with a doubled quote read as an escape rather than the end of
the region.

**A mismatched count throws** rather than silently producing wrong SQL:

```
whereRaw(): 2 binding(s) provided but the SQL has 1 "?" placeholder(s).
```

The same validation applies to `orderByRaw()`, `groupByRaw()`,
`havingRaw()`, `selectRaw()` and `Expression.raw()`. They all share
`buildRawSqlExpression()`.

### Date parts

```ts
whereDate(column, value)      whereDate(column, operator, value)      orWhereDate
whereTime(column, value)      whereTime(column, operator, value)      orWhereTime
whereDay(column, value)       whereDay(column, operator, value)       orWhereDay
whereMonth(column, value)     whereMonth(column, operator, value)     orWhereMonth
whereYear(column, value)      whereYear(column, operator, value)      orWhereYear
```

Each engine extracts the component with its own function; the value is
always compared as a zero-padded string, so the same call behaves
identically everywhere.

| Method | Compared against | SQLite | MySQL | Postgres |
|---|---|---|---|---|
| `whereDate` | `2026-01-31` | `strftime('%Y-%m-%d', c)` | `date(c)` | `cast(c as date)` |
| `whereTime` | `12:00:00` | `strftime('%H:%M:%S', c)` | `time(c)` | `cast(c as time)` |
| `whereDay` | `05` | `strftime('%d', c)` | `lpad(day(c), 2, '0')` | `lpad(extract(day …), 2, '0')` |
| `whereMonth` | `09` | `strftime('%m', c)` | `lpad(month(c), 2, '0')` | `lpad(extract(month …), 2, '0')` |
| `whereYear` | `2026` | `strftime('%Y', c)` | `year(c)` | `extract(year …)` |

All five accept `string | Date` (`whereDay`/`whereMonth`/`whereYear`
also accept `number`).

A `Date` is formatted with **local** getters (`getFullYear()`,
`getMonth()`, …), while the stored column is read as UTC. If your
timezone isn't UTC, pass a pre-formatted string rather than a `Date`.

```ts
Post.query().whereYear("created_at", 2026);
Post.query().whereDate("created_at", ">=", "2026-01-01");
```

### JSON

```ts
whereJsonContains(column, value)          orWhereJsonContains
whereJsonDoesntContain(column, value)     orWhereJsonDoesntContain
whereJsonContainsKey(column)              orWhereJsonContainsKey
whereJsonDoesntContainKey(column)         orWhereJsonDoesntContainKey
whereJsonLength(column, value)            orWhereJsonLength
whereJsonLength(column, operator, value)  orWhereJsonLength
```

`column` may reference a nested path with `->`, Laravel's convention:

```ts
Post.query().whereJsonContains("meta->tags", "release");
Post.query().whereJsonContainsKey("meta->author");
Post.query().whereJsonLength("meta->tags", ">", 2);
```

`"meta->tags"` splits into field `meta` and the path segment `tags`.
Compiled SQL:

| Method | SQLite | MySQL | Postgres |
|---|---|---|---|
| `whereJsonContains` | `exists (select 1 from json_each(col, path) where value is ?)` | `json_contains(col, ?, path)` | `(col->'tags')::jsonb @> ?::jsonb` |
| `whereJsonContainsKey` | `json_type(col, path) is not null` | `ifnull(json_contains_path(col, 'one', path), 0)` | `(col->'tags')::jsonb is not null` |
| `whereJsonLength` | `json_array_length(col, path)` | `json_length(col, path)` | `jsonb_array_length((col->'tags')::jsonb)` |

Only `->` segments are supported, no bracket or array-index syntax.

On Postgres the path is cast to `jsonb`, so these work against both
`json` and `jsonb` columns (`@>` and `jsonb_array_length()` are
`jsonb`-only).

### `whereKey()`: EloquentBuilder only

```ts
whereKey(id)   // where(model.primaryKey, id)
```

The primary-key shorthand `find()` uses.

## Ordering, grouping, projection, limits

| Method | Notes |
|---|---|
| `orderBy(column, direction?)` | `direction` defaults to `"asc"`. Accumulates. |
| `orderByDesc(column)` | |
| `latest(column?)` | `orderBy(column, "desc")`, defaults to `"created_at"`. |
| `oldest(column?)` | `orderBy(column, "asc")`, defaults to `"created_at"`. |
| `orderByRaw(sql, bindings?)` | |
| `inRandomOrder()` | `RANDOM()`, or `RAND()` on MySQL. |
| `reorder(column?, direction?)` | **Clears every ordering**, then optionally adds one. |
| `reorderDesc(column)` | |
| `distinct()` | |
| `groupBy(...columns)` | Accumulates across calls. |
| `groupByRaw(sql, bindings?)` | |
| `having(column, value)` / `having(column, operator, value)` | |
| `orHaving(...)` | |
| `havingRaw(sql, bindings?)` / `orHavingRaw(...)` | |
| `selectRaw<TExtra>(sql, bindings?)` | Appends an aliased expression; **widens** the row type. |
| `select(...columns)` | Replaces the projection. Accepts `table.*` wildcards. |
| `table(name)` | **QueryBuilder only.** Rebinds the table. |
| `alias(name)` | **QueryBuilder only.** Renames the table (`posts as parent`). |
| `limit(n)` / `take(n)` | |
| `offset(n)` / `skip(n)` | |
| `lock(value?)` / `lockForUpdate()` / `sharedLock()` | `FOR UPDATE`/`FOR SHARE` on MySQL and Postgres; **no-ops on SQLite.** |

### `selectRaw()` widens the row type

The one place `TRow` is deliberately widened rather than narrowed:

```ts
const posts = await Post.query()
  .selectRaw<{ comments_count: number }>(
    "(select count(*) from comments where comments.post_id = posts.id) as comments_count",
  )
  .get();

posts.first()!.comments_count;   // number — typed, not `any`
posts.first()!.body;             // still typed from PostTable
```

The SQL **must** alias its result. There's no separate alias argument.
Use a correlated subquery rather than a join, so the result stays one row
per table row with no ambiguous column names.

### `table()` is QueryBuilder-only

`table()` isn't redefined on `EloquentBuilder`, on purpose. A model
builder is bound to `model.table`. Reach it through `toBase()`, which is
what the subquery callbacks do, or start from `DB.table()`.

`table()` returns `QueryBuilder<Record<string, any>>` rather than `this`,
switching tables invalidates the original `TRow`, so column names widen to
accept anything afterwards.

`select()` **is** available on both, because a join makes an explicit
projection necessary rather than optional (see below).

## Joins

| Method | Row type becomes |
|---|---|
| `join<TJoined>(table, first, second)` | `TRow & TJoined` |
| `join<TJoined>(table, (j) => …)` | `TRow & TJoined` |
| `leftJoin<TJoined>(...)` | `TRow & Partial<TJoined>` |
| `crossJoin<TJoined>(table)` | `TRow & TJoined` |

A join mixes columns from two tables into one row, so it widens the row
type, the same thing `selectRaw<TExtra>()` already does, for the same
reason:

```ts
const articles = await Article.query()
  .join<{ author_name: string }>("authors", "articles.author_id", "authors.id")
  .select("articles.*", "authors.name as author_name")
  .orderBy("id")
  .get();

articles.first()!.author_name;   // string — typed
```

`TJoined` is **explicit, never inferred**. The builder has no schema to
read column types from, so you describe what the join projects, exactly as
with `selectRaw()`.

### `leftJoin` widens with `Partial`

An unmatched left row nulls every joined column, so the honest type is
`Partial<TJoined>`. The joined fields are possibly-`undefined`:

```ts
const rows = await Article.query()
  .leftJoin<{ author_name: string }>("authors", "articles.author_id", "authors.id")
  .select("articles.*", "authors.name as author_name")
  .get();

rows.first()!.author_name;   // string | undefined
```

### Multi-condition joins

The callback form takes a `JoinClause`, which mirrors the where-tree
design, each condition carries its own `and`/`or` connector:

| Method | Compares |
|---|---|
| `onRef(first, operator, second)` | two **columns** |
| `orOnRef(...)` | two columns, `OR` |
| `on(column, value)` / `on(column, operator, value)` | a column against a **bound value** |
| `orOn(...)` | a bound value, `OR` |

```ts
await DB.table("tags")
  .join<{ pivot_weight: number }>("taggables", (j) =>
    j.onRef("taggables.tag_id", "=", "tags.id").on("taggables.taggable_type", "post"),
  )
  .select("tags.*", "taggables.weight as pivot_weight")
  .get();
```

`JoinClause` is deliberately narrower than Laravel's, which is a full
query builder accepting every `where*()` method. A join predicate complex
enough to need `whereIn`/`whereExists` is a filter, put it in the outer
`where()`.

### Aliases and self-joins

`alias(name)` renames the table this builder selects from, which is what
makes a self-join expressible:

```ts
await DB.table("articles as child")
  .join<{ parent_title: string }>("articles as parent", "child.parent_id", "parent.id")
  .select("child.id as id", "parent.title as parent_title")
  .get();
```

Both `table("posts as parent")` and `.alias("parent")` work; the explicit
method exists for call sites where the alias is meaningful rather than
cosmetic. Column references made after aliasing must use the alias.

### Projection on a joined query

`select()` accepts wildcards alongside named columns, matching Laravel:

```ts
.select("articles.*", "authors.name as author_name")
```

Without an explicit `select()`, a joined query returns every column from
every table and duplicate names collide. Always project explicitly when
the two tables share a column name (`id` and `created_at`, usually).

On an `EloquentBuilder`, rows are still hydrated into **this** model's
instances, joined columns land as ordinary attributes, not a nested
object. For a relation you want as a real instance, use `with()`.

### Joins are select-only

`insert()`/`update()`/`delete()` on a joined or aliased builder **throw**.
SQLite supports neither an aliased `UPDATE` target nor `UPDATE ... JOIN`,
and silently dropping the join would emit a statement that quietly writes
the wrong rows. Filter with `whereIn(subquery)`/`whereExists()` instead.

## Unions

```ts
const rows = await DB.table("posts")
  .where("published", 1)
  .union((q) => q.table("drafts").where("author_id", userId))
  .get();
```

| Method | Notes |
|---|---|
| `union(subquery)` | Deduplicates |
| `unionAll(subquery)` | Keeps duplicates |

Takes the same `Subquery` shapes as `whereIn`/`whereExists`, a callback,
a built `QueryBuilder`, or an `Expression`.

Both sides must project the same column set in the same order. The builder
has no schema to verify that with, so a mismatch surfaces as a database
error, same as Laravel. `TRow` is unchanged: a union appends rows, never
columns.

`orderBy()`/`limit()`/`offset()` apply to the **combined** result, matching
SQL's own semantics.

### Locks are real on MySQL/Postgres, no-ops on SQLite

`lock()`, `lockForUpdate()` and `sharedLock()` compile to `SELECT ...
FOR UPDATE` / `FOR SHARE` on MySQL and Postgres. The standard
read-modify-write guard against two transactions both reading a balance
before either writes it back:

```ts
await DB.transaction(async () => {
  const account = await Account.query().whereKey(id).lockForUpdate().first();
  await Account.update(id, { balance: account.balance - amount });
});
```

Only meaningful **inside a transaction**: a lock taken by an
autocommitted statement is released the moment it finishes.

A string is emitted verbatim for engine-specific modifiers the builder
doesn't model: `lock("for update skip locked")`,
`lock("for update nowait")`.

**On SQLite the clause is not emitted at all.** The database is a single
file with one writer, there is no row-level lock to take, and the engine
rejects the syntax; Laravel's own `SQLiteGrammar::compileLock()` returns
`''` for the same reason. The intent is still recorded, so the same code
runs unchanged against SQLite in tests and MySQL/Postgres in production,
but **do not rely on `lockForUpdate()` for correctness on SQLite**.
Use a transaction, or an atomic `UPDATE ... WHERE` that encodes the
precondition.

## Terminals

Everything below executes.

### Reads

| Method | `QueryBuilder` returns | `EloquentBuilder` returns |
|---|---|---|
| `get()` | `Promise<TRow[]>` | `Promise<Collection<Post>>` |
| `first()` | `Promise<TRow \| undefined>` | `Promise<Post \| undefined>` |
| `count()` | `Promise<number>` | same |
| `exists()` | `Promise<boolean>` | same |
| `doesntExist()` | `Promise<boolean>` | same |
| `min(column)` | `Promise<number \| null>` | same |
| `max(column)` | `Promise<number \| null>` | same |
| `sum(column)` | `Promise<number \| null>` | same |
| `avg(column)` | `Promise<number \| null>` | same |
| `countBy(column)` | `Promise<Map<TRow[K], number>>` | same |

`EloquentBuilder.get()` hydrates each row into an instance, fires
`retrieved` per instance, then runs any queued `with()` loads. `first()`
does the same for one row. See [Models](../models/#model-events).

### Which clauses each terminal honours

This trips people up, so it's a table:

| Terminal | wheres | groupBy | having | orderBy | limit / offset | distinct | selectRaw |
|---|---|---|---|---|---|---|---|
| `get()` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `first()` | ✓ | ✓ | ✓ | ✓ | own `LIMIT 1`, offset ✓ | ✓ | ✓ |
| `count()` | ✓ | ✓ | ✓ | **✗** | **✗** | ✓ | ✗ |
| `exists()` | ✓ | ✗ | ✗ | ✗ | own `LIMIT 1` | ✗ | ✗ |
| `min`/`max`/`sum`/`avg` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `countBy()` | ✓ | own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `update()` / `delete()` | ✓ | — | — | — | **✗** | — | — |

Three consequences worth stating plainly:

**`count()` ignores `orderBy`/`limit`/`offset`.** This is what makes
pagination's "total across all pages" correct even though the same builder
also carries a page-sized `limit`/`offset` for the data fetch. It mirrors
Laravel's `getCountForPagination()`. It also means
`.limit(10).count()` returns the *full* matching count, not `10`.

It does honour `groupBy`/`having`/`distinct`/`union`, by wrapping the
whole query as a subquery (`select count(*) from (…)`). So
`.groupBy("author_id").count()` is the number of **groups**, and
`paginate()` reports the right `total` for a grouped or distinct query.

**`first()` compiles its own `LIMIT 1`.** Kysely's `executeTakeFirst()`
is `const [row] = await execute()`, without the limit the database
materialises and ships the entire result set to discard all but one row.
`offset` is honoured, so `.offset(10).first()` is the eleventh row.

**`update()`/`delete()` ignore `limit`.** Only the where conditions apply.
Be deliberate.

### `countBy()`

`GROUP BY column` + `COUNT(*)` returned as a map. This framework's own
addition. Eloquent has no single-call equivalent:

```ts
const counts = await Like.query().whereIn("post_id", ids).countBy("post_id");
counts.get(post.id) ?? 0;
```

It's the batched answer to "counts per parent" without an N+1, for cases
outside a declared relation. For a filtered count of a *declared*
relation, `withCount()` takes a constraining callback,
`withCount({ comments: (q) => q.where("approved", 1) })`. See
[Relationships](../relationships/#withcount).

### Iteration

| Method | Signature |
|---|---|
| `chunk(size, callback)` | `callback(rows)`; return `false` to stop |
| `each(callback, size?)` | `callback(row, index)`; `size` defaults to `1000` |
| `lazy(size?)` | `AsyncGenerator<TRow>` |
| `cursor(size?)` | Alias for `lazy()` |

```ts
await Post.query().orderBy("id").chunk(500, async (posts) => {
  for (const post of posts) await reindex(post);
});

for await (const post of Post.query().orderBy("id").lazy()) {
  await reindex(post);
}
```

**These are not true streaming.** All four use `LIMIT size OFFSET n`
paging internally, issuing one query per page until a short page comes
back. `cursor()` is a plain alias for `lazy()`, better-sqlite3 has no
incremental cursor API through Kysely, and exists so call sites stay
portable if a streaming driver ever lands.

Consequences:

- **Always set an explicit `orderBy`.** Offset paging without a stable
  ordering can skip or repeat rows.
- **Mutating rows mid-iteration shifts the window.** Deleting rows as you
  chunk means later pages skip records. There is no `chunkById()`. Fetch
  the ids up front if you're mutating.
- A pre-set `limit`/`offset` is ignored. These methods manage them.

On `EloquentBuilder` all four hydrate each row into an instance and fire
`retrieved`. **They do *not* run queued `with()` relations**. Chunking is
for large batch processing, not display. Call `loadMany()` per page if you
need relations:

```ts
await Post.query().orderBy("id").chunk(200, async (posts) => {
  await loadMany(posts, "author");
  // ...
});
```

### Writes

| Method | Returns | Notes |
|---|---|---|
| `insert(values)` | `Promise<TRow>` | Returns the values passed in. No `insertId` read-back. |
| `update(values)` | `Promise<number>` | Affected rows. |
| `delete()` | `Promise<number>` | Affected rows. |
| `updateOrInsert(attrs, values?)` | `Promise<boolean>` | |
| `upsert(values, uniqueBy, update?)` | `Promise<number>` | |
| `increment(column, amount?, extra?)` | `Promise<number>` | `amount` defaults to `1`. |
| `incrementEach(columns, extra?)` | `Promise<number>` | One `UPDATE`. |
| `decrement(column, amount?, extra?)` | `Promise<number>` | |
| `decrementEach(columns, extra?)` | `Promise<number>` | |

**`insert()` does not read back a generated id** on any engine, and
stays that way deliberately, the model layer's
`insertAndReadGeneratedId()` handles the read-back for `Model.create()`
(via `RETURNING` on SQLite/Postgres, `LAST_INSERT_ID()` on MySQL).
Bypassing the model means bypassing that.

**`update()`/`delete()` with no `where` hit every row.** There is no
guard. Be deliberate.

`updateOrInsert()` returns `true` even when `values` is empty and nothing
was written, matching Laravel. It adds its `attributes` predicates to a
**clone**, so calling it doesn't permanently narrow the builder it was
called on (this builder mutates in place. See [Every chainable method
mutates `this`](#every-chainable-method-mutates-this)).

`upsert()` compiles to `ON CONFLICT (cols) DO UPDATE` on SQLite and
Postgres, and to `ON DUPLICATE KEY UPDATE` on MySQL. `uniqueBy` needs a
real unique index or constraint. `update` defaults to every column in the
first row; an empty `update` array becomes `DO NOTHING` (`INSERT IGNORE`
on MySQL):

```ts
await Hashtag.query().toBase().upsert(
  [{ id: "1", name: "release" }, { id: "2", name: "beta" }],
  "name",
  ["id"],
);
```

One dialect difference worth knowing: MySQL's form names no conflict
target, so **any** unique index on the table triggers the update there,
not only the columns named in `uniqueBy`.

`increment`/`decrement` compile to `SET col = col ± ?`, so they're atomic
at the SQL level. `extra` sets additional plain columns in the same
statement:

```ts
await Post.query().whereKey(id).increment("view_count", 1, { last_viewed_at: now });
```

### `raw()`

```ts
raw(): SelectQueryBuilder<any, any, any>
```

**QueryBuilder only.** The underlying Kysely SELECT builder with every
accumulated clause already applied, the escape hatch for joins, window
functions, and anything else not modelled here:

```ts
const rows = await Post.query()
  .where("published", 1)
  .toBase()
  .raw()
  .innerJoin("users", "users.id", "posts.user_id")
  .select(["posts.id", "users.name as author"])
  .execute();
```

For a builder with no model attached, start from `DB.table(name)`. For a
fully raw query with no builder at all, go straight to
`DB.connection().kysely`. See [Database](../database/#the-db-facade).

## Introspection and cloning

| Method | Returns |
|---|---|
| `toSql()` | Compiled SQL with `?` placeholders |
| `toRawSql()` | Compiled SQL with values inlined, **debugging only** |
| `getBindings()` | `readonly SqlBinding[]`, in placeholder order |
| `clone()` | An independent copy |

```ts
const q = Post.query().where("published", 1).orderByDesc("created_at").limit(10);

q.toSql();
// select * from "posts" where "published" = ? order by "created_at" desc limit ?

q.getBindings();   // [1, 10]
```

**Never execute a `toRawSql()` string.** It string-substitutes parameters
(escaping single quotes only) and exists purely for logging.

All three compile the SELECT, so they reflect the state at the moment you
call them, and because chaining mutates, calling `toSql()` mid-chain
shows a partial query.

`clone()` copies every accumulated array by value, so mutating the clone
or the original doesn't affect the other. `EloquentBuilder.clone()`
constructs off the builder's own constructor, so a custom builder subclass
clones into its own type, and it also copies the queued eager-load names.

## `when()` / `unless()`

Laravel's `Conditionable`, minus the `HigherOrderWhenProxy` magic form.

```ts
Post.query()
  .when(hashtag, (q, tag) => q.whereIn("id", (sq) =>
    sq.table("post_hashtag").select("post_id").where("hashtag_id", "=", tag),
  ))
  .when(request.query("sort") === "old", (q) => q.oldest())
  .unless(includeDrafts, (q) => q.where("published", 1));
```

A function `value` is invoked with the builder to produce the condition;
anything else is used as-is. The callback's return is kept when it isn't
`null`/`undefined`, otherwise the builder is returned, so a `void`
callback still chains. Both accept an optional third `default` callback
for the else branch.

On `EloquentBuilder` the callback receives `this` (the Eloquent builder),
so it can call `with()`, scopes, and other model-aware methods.

## `Expression.raw()`

A standalone, reusable raw SQL fragment, the port of Laravel's
`DB::raw()`. Unlike `whereRaw()` and friends, which are bolted onto a
specific clause, an `Expression` is a *value* you can pass anywhere a
subquery is accepted:

```ts
import { Expression } from "@mahiframework/database";

const recent = Expression.raw(
  "select post_id from likes where user_id = ? and created_at > ?",
  [userId, since],
);

await Post.query().whereIn("id", recent).get();
await Post.query().whereExists(recent).get();
```

Same `?`-placeholder convention, same count validation:

```
Expression.raw(): 1 binding(s) provided but the SQL has 2 "?" placeholder(s).
```

When compiled into an `IN`/`EXISTS` position, an `Expression` is
explicitly wrapped in `(...)`. A hand-written fragment has no
parentheses of its own, unlike a compiled `QueryBuilder` subquery.

`toKysely()` exposes the underlying Kysely expression. It's for
`QueryBuilder` internals; app code shouldn't need it.

## What EloquentBuilder adds

| Method | Purpose |
|---|---|
| `whereKey(id)` | Primary-key equality |
| `with(...names)` | Queue relations for batched loading |
| `withCount(...names)` | Correlated `{name}_count` columns |
| `whereHas(name, constrain?)` | `WHERE EXISTS (correlated)` |
| `orWhereHas`, `has` | |
| `whereDoesntHave(name, constrain?)` | `WHERE NOT EXISTS (correlated)` |
| `orWhereDoesntHave`, `doesntHave` | |
| `toBase()` | The underlying `QueryBuilder` |

It forwards `join()`/`leftJoin()`/`crossJoin()`/`union()`/`unionAll()`/
`select()`, widening `TRow` exactly as `QueryBuilder` does.

Plus behaviour changes to inherited methods:

- `get()`/`first()` hydrate into instances, fire `retrieved`, run queued
  `with()` loads.
- `chunk()`/`each()`/`lazy()`/`cursor()` hydrate and fire `retrieved`, but
  **skip queued `with()` loads**.
- `where(callback)` nests into a fresh builder of the same subclass.
- `clone()` preserves the builder subclass and the eager-load queue.

It also **omits** `table()` and `raw()`, reach those via `toBase()`.

See [Relationships](../relationships/) for `with`, `withCount` and the
existence family in detail.

## Custom builder classes

Subclass `EloquentBuilder` to add per-model scopes:

```ts
// src/builders/post.builder.ts
import { EloquentBuilder } from "@mahiframework/database";
import type { PostAttributes } from "../models/post.model.js";

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

The builder is parameterised by the model's attributes interface, the same
one the model itself is declared over. There is no separate row type to
keep in sync.

Wire it up on the model by overriding `static query()`, the single builder
override point:

```ts
export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
}) {
  static query(): PostBuilder {
    this.bootIfNotBooted();
    const builder = new PostBuilder(this);
    for (const scope of this.scopes) scope.apply(builder);
    return builder;
  }
}

await Post.query().forFeed(authorIds).limit(20).get();
```

Overriding `query()` is all it takes: every other entry point that builds
a query (a nested `where(callback)` group, a `clone()`) constructs a fresh
builder of the *same* subclass off the instance's own constructor, so your
scope methods stay available throughout the chain.

Return `this`, not `EloquentBuilder<...>`, from scope methods so chaining
stays typed as the subclass.

## Deliberate non-goals

**No `dynamicWhere()`.** Laravel's magic `whereName("Ada")` methods can't
be typed and are exactly the hidden dispatch this codebase avoids.

**No `whereRowValues` / `whereAll` / `whereAny` / `whereNone`.**

**No full-text or vector search operators.**

**No `insertGetId()`.** `QueryBuilder.insert()` deliberately has no
read-back; that lives in the model layer.

**Locks compile to nothing on SQLite** (only there). See above.

`toBase()`, `DB.table()`, `raw()`, `Expression.raw()` and
`DB.connection().kysely` are the escape hatches, in increasing order of
drasticness.
