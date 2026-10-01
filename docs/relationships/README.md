# Relationships

A relation is declared in **two** places, and both are required: a
*marker* in the model's attributes interface, and a *definition* in
`static override relationships`. It is then consumed two ways off a live
instance, mirroring Laravel's `$post->comments()` (the query) versus
`$post->comments` (the loaded value).

```ts
import { Model, belongsTo, hasMany } from "@mahiframework/database";
import type { BelongsTo, HasMany } from "@mahiframework/database";
import { User } from "./user.model.js";
import { Comment } from "./comment.model.js";

interface PostAttributes {
  id: number;
  user_id: string;
  title: string;

  author: BelongsTo<User>;      // the marker — drives every type
  comments: HasMany<Comment>;
}

export class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
}) {
  static override relationships = {   // the definition — drives the runtime
    author: belongsTo(() => User, { foreignKey: "user_id" }),
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
  };
}
```

```ts
const post = await Post.firstOrFail();

// Query side — a fresh builder scoped to this row. Nothing runs until a terminal.
await post.relations.comments().where("approved", 1).orderBy("created_at").get();
await post.relations.comments().count();
const author = await post.relations.author().first();

// Value side — the LOADED result, populated by with()/load()/loadMissing().
await post.loadMissing("comments");
post.comments;   // Collection<Comment> | undefined
post.author;     // User | undefined
```

**The marker is the type; the definition is the behaviour.** Everything
static, the loaded value's type, the name-checking on `with()` and
`whereHas()`, the `relations.x()` builder's element type, is derived from
the marker in `PostAttributes`. The helper call in `relationships` carries
the runtime key configuration, and the compiler checks the two agree:
declaring `author: BelongsTo<User>` and then pointing the helper at `Tag`
is a compile error, as is omitting a declared name from the map.

The markers are erased at runtime (each is a phantom brand over a `unique
symbol`), so they cost nothing and never appear on an instance. There is
no per-model accessor boilerplate to write.

## The eleven relation types

| Marker | Helper | Where the key lives | Loaded value | Options interface |
|---|---|---|---|---|
| `BelongsTo<R>` | `belongsTo` | This table | `R \| undefined` | `BelongsToOptions` |
| `HasOne<R>` | `hasOne` | Related table | `R \| undefined` | `HasOneOptions` |
| `HasMany<R>` | `hasMany` | Related table | `Collection<R> \| undefined` | `HasManyOptions` |
| `BelongsToMany<R, P?>` | `belongsToMany` | Pivot table | `Collection<R> \| undefined` | `BelongsToManyOptions` |
| `MorphOne<R>` | `morphOne` | Related table (type + id) | `R \| undefined` | `MorphOneOptions` |
| `MorphMany<R>` | `morphMany` | Related table (type + id) | `Collection<R> \| undefined` | `MorphManyOptions` |
| `MorphTo<R>` | `morphTo` | This table (type + id) | `R \| undefined` | `MorphToOptions` |
| `MorphToMany<R, P?>` | `morphToMany` | Pivot table (type + id) | `Collection<R> \| undefined` | `MorphToManyOptions` |
| `MorphedByMany<R, P?>` | `morphedByMany` | Pivot table (type + id), inverse | `Collection<R> \| undefined` | `MorphedByManyOptions` |
| `HasOneThrough<R>` | `hasOneThrough` | Via an intermediate | `R \| undefined` | `HasOneThroughOptions` |
| `HasManyThrough<R>` | `hasManyThrough` | Via an intermediate | `Collection<R> \| undefined` | `HasManyThroughOptions` |

`R` is the related model's **instance** type, the class itself
(`BelongsTo<User>`, not `BelongsTo<typeof User>` or `BelongsTo<UserRow>`).
The optional `P` on the three many-to-many markers is the pivot-attributes
type; supplying it makes the loaded element `R & { pivot: P }`. See
[Pivot columns](#pivot-columns).

Every loaded value includes `| undefined`, because "not loaded yet" is a
real state: only [`with()`](#with-on-a-builder) narrows it away.

`morphTo` **is** declarable, but its query-side accessor is a
[`MorphToBuilder`](#morphtobuilder), not an `EloquentBuilder`, the one
relation whose accessor differs, because its target model isn't known
until the discriminant is read. It also can't be used with
`whereHas()`/`withCount()`; both throw, pointing at `whereHasMorph()`.

## Declaring relations

The two halves of one relation:

```ts
comments: HasMany<Comment>;                                   // in the attributes interface
comments: hasMany(() => Comment, { foreignKey: "post_id" }),  // in `static override relationships`
```

The `override` on `static override relationships` is required, the base
model declares the member, and the compiler checks the map you assign
against the markers in your attributes interface. A name declared as a
marker but missing from the map is a compile error, as is a definition
whose helper points at a different class from the one the marker names:

```ts
interface PostAttributes {
  author: BelongsTo<User>;
}

static override relationships = {
  author: belongsTo(() => Tag, { foreignKey: "user_id" }),   // ✗ compile error
};
```

That check is what the redesign buys over the old single-map form: the
marker and the definition cannot silently disagree.

### `related` is a thunk, and that's the point

`belongsTo(() => User, …)`, never `belongsTo(User, …)`. The thunk is only
invoked when a relation actually runs, so two models can declare relations
pointing at each other without a circular-import ordering problem at
module-evaluation time:

```ts
// post.model.ts
static override relationships = {
  author: belongsTo(() => User, { foreignKey: "user_id" }),
};

// user.model.ts
static override relationships = {
  posts: hasMany(() => Post, { foreignKey: "user_id" }),
};
```

A direct class reference in the argument list would be evaluated at
class-definition time and hit a TDZ `ReferenceError` whichever module the
bundler entered the cycle through. The markers themselves are types, so
they are erased entirely and never participate in the cycle at all.
Self-referential relations work for the same reason:

```ts
// interface PostAttributes { parent: BelongsTo<Post>; replies: HasMany<Post>; ... }
parent:  belongsTo(() => Post, { foreignKey: "parent_id" }),
replies: hasMany(() => Post, { foreignKey: "parent_id" }),
```

### No key-name guessing

Every foreign key is named explicitly. There is no "`post_id` because the
parent class is `Post`" inference, deliberately, matching the framework's
stance against name-derived magic elsewhere (the gate registry requires
`gate.policy(Post, PostPolicy)` rather than guessing; the container has no
auto-wiring).

The **only** defaults are the ones that can't be wrong:
`localKey`/`ownerKey`/`relatedKey`/`secondLocalKey` fall back to the
relevant model's own `primaryKey`.

A polymorphic relation's `type` also defaults, to the declaring model's
[`morphAlias()`](#morph-maps), but that isn't guessing either. It reads a
declared property of the model (a morph-map entry, `morphName`, or
`table`) rather than deriving a name from another name.

## Options by type

### `belongsTo`

The foreign key lives on **this** model's table.

```ts
belongsTo(related, {
  foreignKey: string;    // column on THIS table, e.g. "user_id"
  ownerKey?: string;     // defaults to the related model's primaryKey
});
```

```ts
// interface PostAttributes { author: BelongsTo<User>; ... }
author: belongsTo(() => User, { foreignKey: "user_id" }),
```

A `null` foreign key produces `WHERE owner_key = NULL`, which matches
nothing, `.first()` yields `undefined`, the same answer Eloquent gives,
with no special case.

### `hasMany` / `hasOne`

The foreign key lives on the **related** model's table.

```ts
hasMany(related, {
  foreignKey: string;   // column on the RELATED table
  localKey?: string;    // defaults to this model's primaryKey
});

// hasOne takes the same options.
```

```ts
// interface PostAttributes { comments: HasMany<Comment>; profile: HasOne<Profile>; ... }
comments: hasMany(() => Comment, { foreignKey: "post_id" }),
profile:  hasOne(() => Profile, { foreignKey: "user_id" }),
```

**`hasOne` is `hasMany`.** Identical option shape, identical SQL. On the
instance side the method is literally `return this.hasMany(related,
options)`. The only differences are intent (which the marker and the
helper both record), the loaded value's type (`R | undefined` vs
`Collection<R> | undefined`), and, for the batched loader, whether it
calls `.first()` on the group.

There is **no uniqueness enforcement**. That's the database's job, via a
unique index on the foreign key. If two rows match a `hasOne`, you get an
arbitrary one.

### `belongsToMany`

```ts
belongsToMany(related, {
  pivotTable: string;
  foreignPivotKey: string;   // pivot column pointing at THIS model
  relatedPivotKey: string;   // pivot column pointing at the RELATED model
  localKey?: string;         // defaults to this model's primaryKey
  relatedKey?: string;       // defaults to the related model's primaryKey
});
```

```ts
// interface PostAttributes { hashtags: BelongsToMany<Hashtag>; ... }
hashtags: belongsToMany(() => Hashtag, {
  pivotTable: "post_hashtag",
  foreignPivotKey: "post_id",
  relatedPivotKey: "hashtag_id",
}),
```

#### It compiles to a subquery, not a join

```sql
SELECT * FROM hashtags
WHERE hashtags.id IN (SELECT hashtag_id FROM post_hashtag WHERE post_id = ?)
```

One query either way, but the subquery form keeps the result rows exactly
the related row shape, no pivot columns bleeding in, no ambiguous
duplicate column names, and keeps the return value the related model's
*ordinary* builder, so its global scopes and any further chaining work
unchanged.

Add [`withPivot`](#pivot-columns) to read pivot columns; that switches the
compilation to a join, since the values have to come back with the row.

If the pivot carries enough data to be interesting in its own right,
its own relations, its own lifecycle, it isn't a pivot, it's an entity.
Give it a `Model` and use two hops instead:

```ts
interface SubscriptionAttributes {
  id: string;
  user_id: string;
  plan_id: string;
  user: BelongsTo<User>;
  plan: BelongsTo<Plan>;
}

export class Subscription extends Model<SubscriptionAttributes>()({
  table: "subscriptions",
  primaryKey: "id",
}) {
  static override relationships = {
    user: belongsTo(() => User, { foreignKey: "user_id" }),
    plan: belongsTo(() => Plan, { foreignKey: "plan_id" }),
  };
}

// On User — `subscriptions: HasMany<Subscription>` in UserAttributes:
subscriptions: hasMany(() => Subscription, { foreignKey: "user_id" }),
```

That's a modelling choice, not a workaround: pivot rows are perfectly
writable through [`attach()`/`sync()`](#writing-relationships): the
question is only whether the join row deserves a name.

### `morphOne` / `morphMany`

The owning side. The discriminant and foreign key both live on the
**related** table.

```ts
morphMany(related, {
  morphType: string;   // discriminant column on the RELATED table
  morphId: string;     // FK column on the RELATED table
  type?: string;       // defaults to this model's morphAlias()
  localKey?: string;   // defaults to this model's primaryKey
});

// morphOne takes the same options.
```

```ts
// interface PostAttributes { comments: MorphMany<Comment>; ... }
comments: morphMany(() => Comment, {
  morphType: "commentable_type",
  morphId: "commentable_id",
}),
```

Column names are **explicit**, no `{name}_type` / `{name}_id` guessing,
matching every other relation here.

`type` is the one exception, and only because it isn't a column name. It
defaults to the declaring model's [`morphAlias()`](#morph-maps), so the
discriminant is owned by the model it names rather than restated at every
declaration pointing at it. Supply it explicitly to store something else;
explicit always wins:

```ts
comments: morphMany(() => Comment, {
  morphType: "commentable_type",
  morphId: "commentable_id",
  type: "post",
}),
```

`morphOne` is `morphMany` with a `.first()`, same as `hasOne` is
`hasMany`.

### `morphTo`

The inverse side. The discriminant and foreign key live on **this** table.

```ts
morphTo<R>({
  morphType: string;
  morphId: string;
  types?: Record<string, () => ModelClass>;   // discriminant value -> model thunk
  ownerKey?: string;                          // defaults to the resolved model's primaryKey
});
```

Declare it like any other relation, with two differences: the marker names
a **union** of the possible targets, and the helper takes **no related
thunk**. It points at several models, so there is no single class to
name. The union is passed as the helper's explicit type argument instead,
which is what lets the compiler check it against the marker:

```ts
interface CommentAttributes {
  id: string;
  commentable_type: string;
  commentable_id: string;

  commentable: MorphTo<Post | Video>;
}

static override relationships = {
  commentable: morphTo<Post | Video>({
    morphType: "commentable_type",
    morphId: "commentable_id",
    types: { post: () => Post, video: () => Video },
  }),
};
```

The explicit `morphTo<Post | Video>` is required. Without it the helper's
related type is inferred as `unknown`, which doesn't satisfy a
`MorphTo<Post | Video>` marker, a compile error at the class declaration
rather than a wrong type downstream.

```ts
comment.commentable;                             // Post | Video | undefined (once loaded)
await comment.relations.commentable().first();   // Post | Video | undefined
await Comment.query().with("commentable").get(); // batched
```

The `MorphTo<Post | Video>` marker is what makes that a proper TypeScript
union rather than a bare `Model`, something TS expresses much better than
PHP's duck-typed `morphTo`, whose return is always `Model`.

The `types` map is **optional**, and under the marker-driven surface it is
purely a *runtime* concern: omitted, the discriminant resolves through the
global [morph map](#morph-maps) instead, and the static type is unchanged
because it came from the marker either way.

```ts
// interface NoteAttributes { notable: MorphTo<Post | Video>; ... }
notable: morphTo<Post | Video>({ morphType: "notable_type", morphId: "notable_id" }),
// note.notable: Post | Video | undefined — the marker's claim, resolved via the map
```

The two compose rather than one replacing the other: `types` is consulted
first, the map is the fallback. So a relation can declare the types it
cares about locally and still resolve values it doesn't know about.

The trade is worth stating plainly. With `types` declared, the compiler's
union and the resolvable set are the same list, written once. Relying on
the map alone leaves the marker an unchecked **claim**: the map is a
runtime registry keyed by arbitrary strings, so nothing stops it returning
a class the marker never named, and you'd get a value the type says is
impossible. Declare `types` unless you specifically want central
configuration.

Resolves to `undefined` when either column is null, or when the
discriminant resolves through neither source. That matches `belongsTo`'s
"missing owner resolves to undefined" behaviour: a `*_type` value is data,
and a stale one should behave like a dangling foreign key rather than
throw.

There's also an undeclared form, mirroring how `morphMany()` relates to a
declared `morphMany`:

```ts
const parent = await comment.morphTo({ morphType: "...", morphId: "...", types: { ... } });
```

#### `MorphToBuilder`

`comment.relations.commentable()` returns a `MorphToBuilder`, not an
`EloquentBuilder`. This is the **only** relation whose query-side accessor
differs, and it's forced: the target is a *type*, unknown until the
discriminant is read, so there's no `TRow` to parameterise on and no
single table to query.

It is still a real, chainable builder, deliberately not a `Promise`,
which would break the uniform `relations.x()` call shape:

| Method | Purpose |
|---|---|
| `first()` | Resolve the parent, or `undefined` |
| `exists()` | Whether the parent row exists |
| `targetClass()` | The resolved model class, before querying |
| `constrain(callbacks)` | Per-type constraining callbacks |
| `morphWith(map)` | Per-type nested eager loads. See [`morphWith()`](#morphwith--nested-loading-per-morph-type) |
| `withTrashed()` / `withoutTrashed()` / `onlyTrashed()` | Soft-delete variants |
| `toBuilder()` | The target's real `EloquentBuilder`, or `undefined` |

`constrain()` and `morphWith()` come from a shared `MorphToSpec` base that
the batched eager loader uses too, so the callback in
`with({ commentable: (m) => … })` sees exactly this API whether it runs
against one row or a whole page. Only `first()`/`exists()`, which need a
specific parent row, are unique to `MorphToBuilder`.

Constraints are **per type**, keyed by discriminant, because there's no
column common to the whole union. `Post` has `published`, `Video` may
not:

```ts
await comment.relations
  .commentable()
  .constrain({
    post:  (q) => q.where("published", 1),
    video: (q) => q.where("visibility", "public"),
  })
  .first();
```

Types absent from the map are left unconstrained. Use `toBuilder()` for
anything the surface above doesn't cover (`count()`, a custom builder's
scopes). It returns `undefined` when the discriminant resolves to
nothing.

#### `whereHas()` and `withCount()` don't work on `morphTo`

Both **throw**, pointing you at `whereHasMorph()`:

```
whereHas()/withCount() cannot be used on a morphTo relation — its target
table isn't known until each row's discriminant is read. Use
whereHasMorph() instead.
```

A correlated `EXISTS` needs one table to correlate against. A `morphTo`'s
parents live in several, so the subquery's shape would depend on the data.
`whereHasMorph()` takes the type list explicitly and emits one correlated
disjunct per type.

### `morphToMany` / `morphedByMany`

Polymorphic many-to-many: one pivot table shared by several parent types.
The pivot carries a discriminant naming which.

```ts
// taggables: tag_id, taggable_id, taggable_type, weight
```

The two relations read **the same pivot from opposite ends**:

| | Declared on | Discriminant names | Key pointing at this model |
|---|---|---|---|
| `morphToMany` | the morphed model (`Post`) | **this** model | `morphId` |
| `morphedByMany` | the shared model (`Tag`) | the **related** model | `foreignPivotKey` |

```ts
// On Post — "my tags". `tags: MorphToMany<Tag>` in PostAttributes.
tags: morphToMany(() => Tag, {
  pivotTable: "taggables",
  morphType: "taggable_type",   // pivot column: "post" | "video"
  morphId: "taggable_id",       // pivot -> posts.id
  relatedPivotKey: "tag_id",    // pivot -> tags.id
}),

// On Tag — "posts with this tag", same pivot, read backwards.
// `posts: MorphedByMany<Post>` in TagAttributes.
posts: morphedByMany(() => Post, {
  pivotTable: "taggables",
  morphType: "taggable_type",
  morphId: "taggable_id",       // pivot -> posts.id  (the RELATED model)
  foreignPivotKey: "tag_id",    // pivot -> tags.id   (THIS model)
}),
```

**Which side `type` names is the asymmetry to watch.** It's the single
easiest thing to get wrong here, because the key has the same name on both
interfaces but means opposite things:

- `morphToMany`: `type` is **this** model's discriminant, defaulting to
  the declaring model's `morphAlias()`.
- `morphedByMany`: `type` is the **related** model's, defaulting to the
  related model's `morphAlias()`.

Laravel hides this behind an internal `$inverse` flag. It's surfaced in
the defaulting rules instead, so the option docs state which side each
one means.

Both compile to a subquery filtered by the discriminant:

```sql
select * from tags where id in (
  select tag_id from taggables
  where taggable_id = ? and taggable_type = 'post')
```

That predicate is required: a post and a video with the *same id* both
have rows in `taggables`, and only `taggable_type` separates them.

### Pivot columns

By default a pivot is pure plumbing. The returned rows are exactly the
related model's, with no pivot data readable. Request columns to change
that, in **both** halves of the declaration: `withPivot` in the options
fetches them, and the marker's second type parameter types them.

```ts
interface PostAttributes {
  tags: MorphToMany<Tag, { weight: number; created_at: string }>;
}

tags: morphToMany(() => Tag, {
  pivotTable: "taggables",
  morphType: "taggable_type",
  morphId: "taggable_id",
  relatedPivotKey: "tag_id",
  withPivot: ["weight"],
  withTimestamps: true,     // adds created_at / updated_at
}),
```

```ts
const post = await Post.query().with("tags").firstOrFail();
post.tags.first()!.pivot.weight;       // 5 — number
post.tags.first()!.pivot.created_at;
```

The pivot type rides on the **loaded value**: a marker with pivot
attributes `P` resolves to `Collection<R & { pivot: P }> | undefined`,
where one without resolves to plain `Collection<R> | undefined`. The
query-side accessor is typed as the related model's ordinary builder, so
`post.relations.tags().get()` yields plain `Tag` instances as far as the
compiler is concerned. The `pivot` values are still attached at runtime,
but reading them off that path needs a cast.

Available on `belongsToMany` too. It's the same mechanism:

```ts
// interface PostAttributes { tags: BelongsToMany<Tag, { weight: number }>; ... }
tags: belongsToMany(() => Tag, {
  pivotTable: "post_tag",
  foreignPivotKey: "post_id",
  relatedPivotKey: "tag_id",
  withPivot: ["weight"],
}),
```

The two halves are independent: `withPivot` without the marker parameter
fetches values the type doesn't know about, and the marker parameter
without `withPivot` promises values that never arrive. Declare both.

Three things worth knowing:

**It switches the compiled query.** Without pivot columns the relation is
a subquery; with them it's an inner join projecting
`pivot.{col} as pivot__{col}`, because the values have to travel back with
the row. Omit `withPivot` and nothing changes, no join, no extra columns,
no behavioural difference for existing callers.

**Pivot values are not attributes.** They land under a `pivot` accessor,
not in the model's own columns, so `tag.toObject()` stays exactly the
`tags` table and the values aren't dirty-trackable. A pivot column can't
be accidentally written back to the related table on the next `save()`.

**The same related row can carry different pivot values.** Tag *release*
might be weight 5 on one post and 9 on another. Each attachment therefore
gets its own instance rather than a shared one; comparing them by
identity across parents won't work.

The `pivot__` prefix is what keeps the two tables' column names apart
(both may have `created_at`). It's explicit and documented rather than
defended against: a related table with a real `pivot__x` column would
collide, which is a caller error.

### `hasManyThrough` / `hasOneThrough`

Reaches a distant model via an intermediate one.

```ts
hasManyThrough(related, {
  through: () => ModelClass;   // thunk, e.g. () => User
  firstKey: string;            // FK on THROUGH pointing at this model
  secondKey: string;           // FK on RELATED pointing at through
  localKey?: string;           // defaults to this model's primaryKey
  secondLocalKey?: string;     // defaults to the through model's primaryKey
});

// hasOneThrough takes the same options.
```

A country's posts, via its users:

```ts
// interface CountryAttributes { posts: HasManyThrough<Post>; ... }
posts: hasManyThrough(() => Post, {
  through: () => User,
  firstKey: "country_id",   // users.country_id -> countries.id
  secondKey: "user_id",     // posts.user_id    -> users.id
}),
```

The intermediate model is named only in `through`. It has no marker of
its own, because it never becomes a readable value on this model.

Compiles as a subquery, same reasoning as `belongsToMany`:

```sql
SELECT * FROM posts
WHERE posts.user_id IN (SELECT id FROM users WHERE country_id = ?)
```

Result rows stay exactly the related model's shape, its global scopes
apply, and further chaining works.

## Morph maps

A polymorphic column stores a short string naming the model it points at.
`Model.morphAlias()` decides what that string is, resolving in three steps,
first match wins:

| # | Source | Unique? | Present by default? |
|---|---|---|---|
| 1 | a `Relation.morphMap()` entry | yes | no |
| 2 | `static morphName` | yes. `ModelRegistry` throws on collision | no |
| 3 | `static table` | **no**: two models can share a table | yes |

```ts
Post.morphAlias();   // "post" if mapped, else morphName, else "posts"
```

It always resolves, so a model needs no extra declaration to take part in
a polymorphic relation.

Laravel's fallback is `static::class`, which is always unique. There's no
equivalent here, a JS class name doesn't survive minification, hence a
chain rather than a single fallback.

### Registering a map

In a provider's `register()`, not `boot()`. The map is class metadata
with no container dependencies, and relations may resolve during another
provider's boot:

```ts
import { Relation } from "@mahiframework/database";

register(): void {
  Relation.morphMap({
    post: () => Post,
    user: () => User,
  });
}
```

Note the thunks: `() => Post`, never `Post`. `register()` runs at import
time, so a bare class reference hits the same TDZ trap `related` avoids.

Registering pins the stored values, decoupling what's in your database
from how your code is named. Without a map, renaming a table silently
orphans every existing row that stored the old name.

| Method | Purpose |
|---|---|
| `Relation.morphMap(map?, merge?)` | Register entries, or read the map back with no arguments. Merges by default. |
| `Relation.enforceMorphMap(map, merge?)` | `morphMap()` + `requireMorphMap()` in one call. |
| `Relation.requireMorphMap(require?)` | Make the map mandatory. |
| `Relation.requiresMorphMap()` | Whether it currently is. |
| `Relation.getMorphedModel(alias)` | Alias → class, or `undefined`. |
| `Relation.getMorphAlias(class)` | Class → alias, or `undefined`. The map-only rung. |
| `Relation.resetMorphMap()` | Clear everything. For test teardown. |

### Enforcing it

`requireMorphMap()` disables rungs **2 and 3**, so an unregistered model
throws `ClassMorphViolationError` rather than falling back:

```ts
Relation.enforceMorphMap({ post: () => Post, user: () => User });

Comment.morphAlias();   // throws — Comment isn't in the map
```

This is more meaningful here than in Laravel, where it only disables one
rung. Worth turning on once you have more than one polymorphic model:
adding a third then fails loudly instead of quietly writing a table name
into your database.

### The map is runtime; the marker is compile-time

Three things resolve a polymorphic target, at two different times:

| | Resolves at | Gives you |
|---|---|---|
| the `MorphTo<Post \| Video>` marker | compile time | a precise `Post \| Video` union |
| a relation's local `types` | runtime | which class this relation's discriminant names |
| `Relation.morphMap()` | runtime | the same, registered centrally |

Under the marker-driven surface the union comes from the **marker**, and
both runtime sources feed the same question of which class to instantiate.
`morphMap()` accepts an arbitrary `Record<string, () => ModelClass>`, so it
can't participate in the type at all; a local `types` map at least sits
next to the marker, where the two can be read together and kept honest by
eye:

```ts
notable: MorphTo<Post | Video>;                          // the type
types: { post: () => Post, video: () => Video }          // the resolution
```

Laravel can't express the union at all; its `morphTo` is always `Model`.

### It's process-global

The map is module-level, class metadata, not a service, so it outlives
any single `Application`, exactly as Laravel's static `$morphMap` does.
Two apps in one test process share it. Reset in teardown:

```ts
afterEach(() => Relation.resetMorphMap());
```

## Generic helpers

Every relation type also exists as a generic method, on both the class and
the instance. The `relations` namespace is built on top of the instance
ones.

**Instance form**, takes just options, reads keys off the row:

```ts
post.belongsTo(User, { foreignKey: "user_id" });
post.hasMany(Comment, { foreignKey: "post_id" });
post.hasOne(Profile, { foreignKey: "user_id" });
post.belongsToMany(Tag, { pivotTable, foreignPivotKey, relatedPivotKey });
post.morphOne(Image, { morphType, morphId, type });
post.morphMany(Comment, { morphType, morphId, type });
await post.morphTo({ morphType, morphId, types });
post.hasManyThrough(Post, { through, firstKey, secondKey });
post.hasOneThrough(Profile, { through, firstKey, secondKey });
```

**Static form**, takes a row explicitly:

```ts
Post.belongsTo(User, row, { foreignKey: "user_id" });
Post.hasMany(Comment, row, { foreignKey: "post_id" });
// ... same set
```

All except `morphTo` return the related model's own builder, its custom
builder subclass included, so they chain like any other query and the
related model's global scopes apply. Being unnamed, they are outside the
marker system: the return is typed as a permissive `EloquentBuilder<any>`,
so results come back untyped and you narrow at the call site.

That imprecision is the point of the trade. Use these only for an
ad-hoc, unnamed one-off relation; the declared marker + `relationships`
pair is the intended path, and only declared relations can be
eager-loaded, counted, used in `whereHas()`, or read back with a real
type.

## Writing relationships

The `relations` namespace writes as well as reads. Each accessor carries
the write methods its relation kind supports and no others. A
`belongsToMany` has `attach()`, a `belongsTo` has `associate()`, and
asking for the wrong one is a compile error, not a runtime surprise.

Every column these touch comes from the relation *definition*, so the
no-key-guessing rule holds on the write side too.

### Many-to-many: attach / detach / sync / toggle

Available on `belongsToMany`, `morphToMany` and `morphedByMany`.

```ts
const post = await Post.findOrFail(id);

await post.relations.tags().attach(tag);              // an instance
await post.relations.tags().attach([1, 2, 3]);        // or keys
await post.relations.tags().attach({ 1: { weight: 9 } });   // with pivot data
await post.relations.tags().attach([1, 2], { source: "import" });  // shared payload

await post.relations.tags().detach([1]);   // just these
await post.relations.tags().detach();      // ALL of them
```

`sync()` makes the pivot match a set exactly, and reports what it did in
Laravel's three buckets:

```ts
// currently [2, 3, 4]
const result = await post.relations.tags().sync([1, 2, 3]);
// { attached: [1], detached: [4], updated: [] }

await post.relations.tags().syncWithoutDetaching([5]);          // add only
await post.relations.tags().syncWithPivotValues([1, 2], { weight: 3 });
await post.relations.tags().toggle([1, 2]);   // flip each
await post.relations.tags().updateExistingPivot(1, { weight: 9 });
```

`sync()` and `toggle()` run in a transaction, joining the caller's via a
savepoint when one is open, so a `sync()` inside your own transaction is
rolled back with it rather than committing on its own.

**`sync()` is at most four statements, whatever the size of the set**: the
`SELECT` that reads the current links, then one `UPDATE`, one `INSERT` and
one `DELETE`, each skipped when it has nothing to do. Re-syncing thirty
links with pivot attributes costs the same round trips as re-syncing two,
which matters because that is the shape of a refresh from an upstream
source: attributes for every id, and almost all of them already linked.

Three behaviours worth pinning down:

- **`detach([])` is a no-op, not "detach all".** Only the no-argument
  form detaches everything. This matters: `detach(request.input("ids"))`
  with an empty selection must not wipe the relation.
- **`attach()` does not deduplicate.** Attaching an existing link raises
  the database's own `UniqueConstraintViolationException` (assuming a
  unique index, which a pivot should have). Use
  `syncWithoutDetaching()` when you mean "ensure linked".
- **`updated` only ever lists ids you supplied attributes for.** A plain
  `sync([1,2,3])` says nothing about pivot payloads, so it never rewrites
  or reports them. Nor does a payload have to be complete: `sync({ 1: {
  weight: 9 } })` writes `weight` and leaves that row's other pivot
  columns as they were.

With `withTimestamps: true`, `attach()` stamps `created_at`/`updated_at`
and `updateExistingPivot()`/`sync()` refresh `updated_at`, spelled the way
the connected engine accepts (MySQL rejects the ISO `Z` form). A link's
`created_at` is never rewritten, so re-syncing cannot lose when it was
made.

Pivot attributes are **raw DB-shape values**. A pivot table has no model,
so there are no casts to apply. Laravel behaves the same way.

### The inverse: associate / dissociate

On a `belongsTo`, and on a `morphTo` (where both polymorphic columns are
written):

```ts
post.relations.author().associate(user);
await post.save();

post.relations.author().dissociate();   // nulls the FK
await post.save();

// morphTo sets the discriminant and the id together
comment.relations.commentable().associate(post);
await comment.save();
```

Neither saves. They set attributes on the parent and hand it back, so
several associates and an ordinary field edit share one `UPDATE`. Both
also keep the *loaded* relation honest: `associate()` sets it,
`dissociate()` clears it, so `post.author` never contradicts
`post.user_id`.

A `belongsTo` accepts a bare key as well as an instance (the loaded
relation is then cleared rather than guessed). A `morphTo` requires an
instance. A key alone cannot name the discriminant.

### One-to-many: save / create through the relation

On `hasOne`, `hasMany`, `morphOne` and `morphMany`:

```ts
const post = await user.relations.posts().create({ title: "Hello" });
// post.user_id is already set

await user.relations.posts().createMany([{ title: "A" }, { title: "B" }]);
await user.relations.posts().save(existingPost);   // re-parents and saves
await user.relations.posts().saveMany([a, b]);

// morphMany sets the type and the id
await post.relations.comments().create({ body: "Nice" });
```

`create()` goes through the related model's own `create()`, so its
timestamps, generated-key read-back and `creating`/`created` events all
fire as usual.

### What stays read-only

`hasOneThrough`/`hasManyThrough` have no write methods, in this framework
and in Laravel: writing through one would mean inventing the intermediate
row, and there is no single correct guess.

### Dropping to raw SQL

Still available, and still the right answer for a bulk pivot rewrite or
anything the API above doesn't express:

```ts
await DB.connection().kysely
  .insertInto("post_hashtag")
  .values({ post_id: post.id, hashtag_id: tag.id })
  .execute();
```

If the pivot carries enough data to be interesting in its own right,
consider modelling it as an entity with its own `Model` and two
`belongsTo`s. See the note under [`belongsToMany`](#belongstomany).

## Eager loading

### `with()` on a builder

Queues relation names to be batch-loaded when the terminal runs:

```ts
const posts = await Post.query().with("author", "images").get();

posts.first()!.author;   // User — no `| undefined`, because it was loaded
posts.first()!.images;   // Collection<PostImage>
posts.first()!.comments; // Collection<Comment> | undefined — NOT loaded
```

`with()` only *queues* the names. The batched queries run once inside
`get()` or `first()`, after hydration. It has no effect on `count()`,
`exists()`, or the aggregates.

**The names are checked against the declared relations**, so a typo is a
compile error rather than a runtime one:

```ts
Post.query().with("nope");   // ✗ compile error — no relation named "nope"
```

**And the terminal narrows.** `with("author")` removes the `| undefined`
from that one relation, and only that one, the exported `Loaded<M, K>`
type:

```ts
const post = await Post.query().with("author").firstOrFail();
// post is Loaded<Post, "author">:
//   post.author   -> User            (guaranteed present)
//   post.comments -> Collection<Comment> | undefined  (untouched)
```

`Loaded` is exported, so a function that requires a loaded relation can say
so in its signature rather than asserting inside:

```ts
import type { Loaded } from "@mahiframework/database";

function byline(post: Loaded<Post, "author">): string {
  return post.author.name;   // no `!`, no cast
}
```

### `load()` / `loadMissing()` on an instance

```ts
await post.load("author", "comments");
await post.loadMissing("author");   // skips anything already loaded
```

`loadMissing()` filters to relations where `relationLoaded(name)` is
false, and returns immediately without querying if nothing is missing, a
cheap guard against re-querying what a prior `with()` already attached.

Unlike `with()`, these do **not** narrow the type: they attach onto an
existing instance rather than producing a new one, so `post.author` stays
`User | undefined` afterwards. Use `with()` when you want the narrowing,
and `load()` when you already have the instance.

### `loadMany()` on an array

```ts
import { loadMany } from "@mahiframework/database";

const posts = result.data.toArray();
await loadMany(posts, "author", "images", "hashtags");
```

Laravel's `$collection->load(...)`. One batched query per relation across
the **whole array**, never one per instance, the N+1-free way to attach
relations to a page of rows fetched without `with()`, which is exactly the
situation after `cursorPaginate()`.

It infers the model class from the first instance, and no-ops on an empty
array. Note how it reaches the class:

```ts
const model = Object.getPrototypeOf(instances[0]!).constructor as ModelClass;
```

Not `instances[0].constructor`. A `Model` instance is a `Proxy` whose
`get` trap binds every function-valued property, and a bound function
loses its statics. See the proxy gotchas in [Models](../models/#the-proxy--read-this-section).

Being a free function over an array of unrelated instances, `loadMany()`
takes plain `string` names rather than name-checking against a particular
model's markers. An unknown one throws at runtime like any other.

### Nested loading with dot paths

A dot path loads a relation of a relation, to any depth:

```ts
const post = await Post.firstOrFail();
await post.load("author.team");

post.author.team.name;
```

On a builder, every segment of a dot path is name-checked and the result
is narrowed at each level:

```ts
const post = await Post.query().with("comments.author").firstOrFail();
post.comments; // Collection<Comment & { author: User }>

Post.query().with("author.nope"); // compile error: User declares no "nope"
```

`load()` and `loadMissing()` are free functions over already-built
instances, so they take plain `string` paths and report an unknown
segment at runtime.

A path stops at a `morphTo`. The loader resolves a morph node's children
per discriminant rather than by path, so `with("notable.owner")` throws
even when every target happens to declare `owner`, the type rejects it
for the same reason. Use
[`morphWith()`](#morphwith--nested-loading-per-morph-type) to nest those.

The cost model is **one batched query per relation node**, not per row.
`with("author.team")` over 500 posts is 3 queries (posts, authors, teams)
and would still be 3 over 500,000, nesting never reintroduces N+1.

A path implies every prefix of itself, and repeated prefixes merge into
one node rather than duplicating it:

```ts
Post.query().with("author.team", "author.posts");
// ONE authors query, with two children hanging off it — 4 total, not 5.
```

Merging works across separate `with()` calls too, so
`.with("author").with("author.team")` is the same three queries as
`.with("author.team")` alone. This matches Laravel's `parseWithRelations`.

Related instances are de-duplicated before the loader descends, so twenty
posts sharing one author issue the `teams` query against that single
author, not twenty copies of it.

An unknown segment names the **segment** that failed and the model it was
missing from, rather than echoing the whole path back:

```
with("nope"): no relation named "nope" is declared in authors's "static relations".
```

(The message still says `static relations`. That's the framework's
permanent internal alias for the map you declare as `static override
relationships`. Same map, one runtime spelling.)

`load()` and `loadMissing()` take dot paths as well. `loadMissing()` skips
per *segment*, so on a post that already has its author,
`loadMissing("author.team")` reuses that author and runs only the `team`
query.

#### The typing depth cap

The dot-path type (`RelationPath`, and its `MaxRelationPathDepth` of `5`)
caps type-checking at **five segments** (`"a.b.c.d.e"`). This is a
compile-time budget, not a runtime limit, the loader recurses to any
depth, and a longer path still works; it just isn't narrowed by the type.

The cap exists because the path type is a recursive union over a model
graph that is routinely cyclic (`Post.author.posts.author…`) and
self-referential (`Post.replies.replies…`), which without a floor never
terminates. Five was set from measurement: against a pathological graph,
ten models each declaring a relation to all ten, i.e. 100,000 expressible
paths, `tsc --extendedDiagnostics` checked in 1.10s against a 0.87s
baseline of the same models with the path type unused. That is 0.25s and
roughly 5,300 extra type instantiations to enumerate the entire union; a
realistic graph is far below it. The cap is there because unbounded
recursion over a cyclic graph is a language-server trap, not because five
is near a performance cliff.

### Constraining what gets loaded

Pass an object instead of names to narrow a relation as it loads:

```ts
const posts = await Post.query()
  .with({ comments: (q) => q.where("approved", 1) })
  .get();
```

The closure receives the related model's own `EloquentBuilder` before the
batched `whereIn` runs, the same shape `whereHas()`'s constraint takes.
In `with()`'s object form the parameter is `any`, so the columns aren't
checked; annotate or cast it if you want them to be:

```ts
Post.query().with({
  comments: (q) => (q as unknown as EloquentBuilder<CommentAttributes>).where("approved", 1),
});
```

Both forms compose, including with dot paths:

```ts
Post.query()
  .with({ comments: (q) => q.where("approved", 1) })
  .with("comments.author");

Post.query().with({ "comments.author": (q: any) => q.where("active", 1) });
```

Two sharp edges worth knowing:

**A constraint narrows the relation; it does not error.** Filtering rows
out makes a to-many attach fewer of them and a to-one attach `undefined`.
That's the same value "no match" produces, so a constraint that
accidentally excludes everything looks exactly like an empty relation.
Laravel behaves identically.

**`limit()` inside a constraint throws.** The relation is fetched for
every parent in one batched query, so a `LIMIT` would cap the whole batch
rather than each parent, `.limit(3)` over 100 posts would return 3
comments *in total*, while reading at the call site as "3 per post":

```
with("comments"): limit() isn't supported inside an eager-load constraint.
```

`take()`/`offset()`/`skip()` throw the same way. Per-parent limits need
window functions (`ROW_NUMBER() OVER (PARTITION BY …)`), which Laravel
only gained recently and which aren't implemented here yet. Throwing is
deliberate: silently returning the wrong rows is the worse failure,
because it looks like it worked.

### `morphWith()`: nested loading per morph type

A dot path can't nest through a `morphTo`: the segment after the dot has
to name a relation on *one* related model, and a `morphTo` has several.
`morphWith()` keys the nested loads by discriminant instead:

```ts
const notes = await Note.query()
  .with({
    notable: (m) => m.morphWith({
      post: ["comments", "tags"],
      author: ["team"],
    }),
  })
  .get();
```

A `morphTo`'s constraining callback receives a `MorphToSpec` rather than a
builder, the same `constrain()`/`morphWith()` surface `MorphToBuilder`
exposes, so the callback reads identically whether it runs against one row
or a whole page. The two compose:

```ts
.with({
  notable: (m) => m
    .constrain({ post: (q: any) => q.where("published", 1) })
    .morphWith({ post: ["comments"] }),
})
```

The per-type callbacks are untyped (`q: any`). A morph union has no
common column set to narrow to, which is the whole reason constraints are
keyed by discriminant. Annotate the parameter as the type that branch
selects if you want its columns checked.

A type absent from the map loads no children, not an error, since a mixed
page routinely holds types you have nothing extra to load for. The keys
are the discriminant values from the relation's own `types` map (or the
global morph map) rather than anything the marker names, and `morphWith`
costs no queries beyond the children
themselves, because a `morphTo` already resolves one query per distinct
type.

Dot paths work inside `morphWith`: `morphWith({ post: ["comments.author"] })`.

### What gets batched, and what's attached when empty

Per relation **node**, across every instance passed in. (A node, not a
name: a dot path contributes one node per segment, each batched across
everything the previous segment attached.)

| Type | Queries | Attached when nothing matches |
|---|---|---|
| `belongsTo` | 1 (`whereIn` on the owner key) | `undefined` |
| `hasOne` | 1 (`whereIn` on the FK) | `undefined` |
| `hasMany` | 1 (`whereIn` on the FK) | **empty `Collection`** |
| `morphOne` | 1 (`where` type + `whereIn` id) | `undefined` |
| `morphMany` | 1 (`where` type + `whereIn` id) | **empty `Collection`** |
| `morphTo` | **1 per distinct type** † | `undefined` |
| `belongsToMany` | 2 (pivot, then related) | **empty `Collection`** |
| `morphToMany` | 2 (pivot + type filter, then related) | **empty `Collection`** |
| `morphedByMany` | 2 (pivot + type filter, then related) | **empty `Collection`** |
| `hasOneThrough` | 2 (through, then related) | `undefined` |
| `hasManyThrough` | 2 (through, then related) | **empty `Collection`** |

† **`morphTo` is the one exception to the constant-query-count rule.** Its
parents live in different tables, so the loader groups the page's rows by
discriminant and issues one `whereIn` per distinct type, same as Laravel.
That's bounded by how many types actually appear in the page, not by row
count: 500 comments spanning `post` and `video` cost two queries, not 500.
Rows whose discriminant resolves to nothing cost none.

Parents are keyed by `(type, id)` internally, since ids are only unique
*within* a type, post `1` and video `1` are different parents.

The distinction matters. A to-many relation is **always** set to at least
an empty `Collection`, so `relationLoaded("comments")` is `true` and
`post.comments.count()` is `0` rather than a `TypeError`. A to-one
relation is set to `undefined`, which is indistinguishable from "not
loaded" by reading the value, use `relationLoaded(name)` if you need to
tell the difference.

That's also why every relation marker resolves to a `| undefined` type:
the two states genuinely share a value for a to-one relation, and only
`with()`'s [`Loaded`](#with-on-a-builder) narrowing can rule one out.

Foreign-key values are deduplicated before the `whereIn`, and `null` and
`undefined` are dropped. If every instance's key is null, the loader
attaches the empty value to all of them **without running a query at
all**.

Related rows are hydrated into their own model instances, so
`post.author` is a live `User` with its own casts, relations and methods,
not a bare row.

## `withCount()`

Adds a correlated `{name}_count` subquery column per named relation:

```ts
const posts = await Post.query().withCount("comments", "likes").get();

posts.first()!.comments_count;   // number
posts.first()!.likes_count;      // number
```

The names are checked against the declared relations, exactly as `with()`'s
are.

For the *reads* to typecheck, declare the count columns in the attributes
interface. A count is an ordinary selected column, so it belongs there
like any other:

```ts
interface PostAttributes {
  // ...
  comments_count: number;
  likes_count: number;
}
```

`withCount()` widens the builder's row type with `${name}_count: number`
per name, but the instance type comes from the attributes interface, so an
undeclared count column reads back through
`post.getAttribute("comments_count")` or a cast instead.

The related model's global scopes apply, so a soft-deleting relation
counts only non-trashed rows.

A `belongsTo`/`hasOne` count is 0 or 1; a `hasMany`/`belongsToMany` count
is the full related-row count.

### Self-referential relations work

The correlated subquery always selects from `{related.table} as
{related.table}__sub` and qualifies its own side with that alias, leaving
the outer side qualified by the parent's real table name:

```sql
-- Post.replies is hasMany(() => Post, { foreignKey: "parent_id" })
"posts__sub"."parent_id" = "posts"."id"   -- inner row vs. outer row
```

So `Post.query().withCount("replies")` and
`Post.query().whereHas("replies")` behave exactly as they do for any other
relation. The alias is applied unconditionally rather than only when the
tables collide, so the emitted SQL has one shape to reason about.

### Counting a filtered subset

`withCount()` takes the same object form `with()` does. The callback
receives the related model's builder and narrows the subquery:

```ts
const posts = await Post.query()
  .withCount({ comments: (q) => q.where("approved", 1) })
  .get();

posts.first()!.comments_count;   // only approved comments
```

Unlike `with()`, the names here are single relations rather than dot
paths: the count is a correlated subquery against one related table, and
there's no meaningful "count of a nested relation" to project onto the
parent row.

## Relation existence queries

| Method | SQL | Notes |
|---|---|---|
| `whereHas(name, constrain?)` | `WHERE EXISTS (...)` | |
| `orWhereHas(name, constrain?)` | `OR EXISTS (...)` | |
| `has(name)` | `WHERE EXISTS (...)` | `whereHas(name)` with no constraint |
| `whereDoesntHave(name, constrain?)` | `WHERE NOT EXISTS (...)` | |
| `orWhereDoesntHave(name, constrain?)` | `OR NOT EXISTS (...)` | |
| `doesntHave(name)` | `WHERE NOT EXISTS (...)` | `whereDoesntHave(name)` with no constraint |

```ts
await Post.query().whereHas("comments").get();

await Post.query()
  .whereHas("comments", (q) =>
    (q as unknown as EloquentBuilder<CommentAttributes>).where("approved", 1),
  )
  .get();

await User.query().doesntHave("posts").get();

await Post.query()
  .whereHas("images")
  .orWhereHas("hashtags", (q) =>
    (q as unknown as EloquentBuilder<HashtagAttributes>).where("name", "release"),
  )
  .get();
```

Every `name` argument is checked against the declared relations, so an
undeclared one is a compile error:

```ts
Post.query().whereHas("nope");   // ✗ compile error
```

The `constrain` callback receives the **related model's own
`EloquentBuilder`** at runtime, so its scopes and any custom builder
methods are available. Its *type*, though, is
`EloquentBuilder<RelatedRowOf<…>>`, and a helper definition erases its
related class to a structural model, so the row type resolves to a
permissive bag and no column name typechecks. Route through `unknown` to
name the related model's columns, as above. The cast is a typing
convenience, not a behavioural one.

The correlated subquery starts from `related.query()`, so the related
model's global scopes apply, and a `whereHas("comments")` on a
soft-deleting `Comment` won't match a post whose only comments are
trashed. Its table is aliased `{table}__sub`, which is what makes
self-referential relations work (see above).

A name that slips through an untyped path throws immediately rather than
silently matching nothing:

```
comments: no relation named "comments" is declared in posts's "static relations".
```

## Morph-aware existence queries

`whereHas()` can't work on a `morphTo`: a correlated `EXISTS` needs one
table to correlate against, and a `morphTo`'s parents live in several.
These take the type information explicitly instead.

| Method | SQL |
|---|---|
| `whereMorphedTo(name, instance)` | `WHERE type = ? AND id = ?` |
| `whereNotMorphedTo(name, instance)` | `WHERE NOT (type = ? AND id = ?)` |
| `orWhereMorphedTo` / `orWhereNotMorphedTo` | the same, `OR`-joined |
| `whereHasMorph(name, types, constrain?)` | OR-group of `(type = ? AND EXISTS (...))` |
| `orWhereHasMorph` | the same, `OR`-joined |
| `whereDoesntHaveMorph(name, types, constrain?)` | the negation |
| `orWhereDoesntHaveMorph` | the same, `OR`-joined |

### `whereMorphedTo()`: point at one instance

```ts
const post = await Post.findOrFail(id);
await Comment.query().whereMorphedTo("commentable", post).get();
// where commentable_type = 'post' and commentable_id = <post.id>
```

**No subquery.** Both columns are on the queried table, so this is two
plain predicates, the cheapest way to ask "comments on *that* post", and
it works without knowing which types the relation can point at.

The discriminant comes from the instance's own
[`morphAlias()`](#morph-maps), so it agrees with whatever
`morphMany`/`morphToMany` would have written.

The negated form brackets the pair, so it means "points at anything but
this", not "has a different type but the same id".

### `whereHasMorph()`: parent exists, of a listed type

```ts
await Comment.query().whereHasMorph("commentable", [Post, Video]).get();

await Comment.query()
  .whereHasMorph("commentable", [Post], (q) => q.where("published", 1))
  .get();
```

Each type contributes a disjunct, `(discriminant = alias AND EXISTS
(correlated subquery))`, OR'd together in one group. The grouping is what
keeps each type's constraint bound to its own discriminant; without it a
video would be matched by the post branch's subquery.

The callback receives the discriminant as a second argument, so one
callback can branch per type:

```ts
await Comment.query()
  .whereHasMorph("commentable", [Post, Video], (q, type) => {
    if (type === "post") q.where("published", 1);
  })
  .get();
```

Rows whose parent no longer exists, or whose discriminant isn't in the
list, are excluded. Which makes `whereDoesntHaveMorph()` a way to find
orphaned polymorphic rows.

### The `"*"` wildcard

```ts
await Comment.query().whereHasMorph("commentable", "*").get();
```

Expands to every entry in the global [morph map](#morph-maps), the only
enumerable source of "every type this could be". A relation's local
`types` covers just what one declaration named, and neither can see rows
storing a discriminant nobody registered.

**Throws when the map is empty.** An unregistered map would silently match
nothing, which is the worse failure.

### Name narrowing

These methods narrow `name` to the model's `morphTo` relations, so
`whereMorphedTo("author", …)` on a `belongsTo` is a compile error. The
`MorphTo` marker is what distinguishes the two:

```ts
Comment.query().whereMorphedTo("commentable", post);   // ok
Comment.query().whereMorphedTo("author", user);        // ✗ author is a belongsTo
```

A runtime check backs it up for callers arriving through an untyped path:

```
whereMorphedTo("author"): "author" is not a morphTo relation.
```

## Type-level details

Useful when writing generic helpers over models. Everything here is
exported from `@mahiframework/database`.

**The names you'll actually use:**

| Type | Is |
|---|---|
| `Post` | The model instance type. The class **is** the type. There is no `RowOf`/`WithRelations` wrapper to apply. |
| `Loaded<M, K>` | `M` with the relations named by `K` guaranteed present. What `with()` returns. |
| `Key<M>` | `M`'s primary-key value type, read off its `id` column (`string \| number` when it has none). |

**Deriving from an attributes map `A`:**

| Type | Extracts |
|---|---|
| `RelationKeys<A>` | The relation-marker names in `A`. |
| `ColumnKeys<A>` / `ComputedKeys<A>` | The plain-column / `Computed<>` names. |
| `RelationMarkers<A>` | The relation markers of `A`, keyed by name. |
| `LoadedValueOf<V>` | What one marker resolves to, the single source of the to-one/to-many split. |
| `ResolvedAttributes<A>` | The instance-facing shape: columns as declared, markers as their loaded value, computed as their type. |
| `Relationships<A>` | The shape `static override relationships` must have, derived from `A`'s markers. |
| `LoadedRelationValues<A>` | The value-side accessors, over `LoadedValueOf`. |
| `RelationBuildersFor<A>` | The query-side namespace: `() => EloquentBuilder<…, Related>`, or `() => MorphToBuilder<…>` for a `morphTo`. |
| `ModelInstance<A>` | The base runtime + `ResolvedAttributes<A>` + the `relations` namespace. |
| `BuilderFor<A, I>` | This model's builder, terminating in instance type `I`. |

**Deriving from a single relation definition (the runtime map's shape):**

| Type | Extracts |
|---|---|
| `RelatedRowOf<Def>` | The related model's **row** type. |
| `MorphTargetOf<Def>` | A `morphTo`'s target union, recovered from its `types` map. |
| `MorphToKeys<R>` | The names in `R` whose relation is a `morphTo`. |
| `RelationValueOf<Def>` | What one loaded relation holds, by `type` literal. |
| `RelationWritesFor<Def>` | The [write methods](#writing-relationships) one relation kind adds. `unknown` for the read-only kinds. |
| `EagerLoadResult<R, K>` | What `with(...K)` merges onto the row type, for flat names. |
| `RelationPath<R, D?>` | Every dot path `with()` accepts, to `MaxRelationPathDepth` segments. |
| `NestedEagerLoadResult<R, K>` | The path-aware form of `EagerLoadResult`. |
| `MaxRelationPathDepth` | The dot-path typing cap (`5`). |
| `RelationMarker<K, R, ToMany, Pivot, B>` / `RelationKind` | The marker's underlying phantom payload and its kind union. |

The removed helpers have no replacement because they have no job left.
`RowOf<M>`, `BuilderOf<M>` and `WithRelations<M>` all existed to
reassemble a model's real type from pieces scattered across a declaration
merge, a `declare static Row` marker and a relation map. There is now one
declaration, the attributes interface, and the class derived from it is
the type. Write `Post`.

### The relation markers, precisely

Each marker is a phantom brand carrying five things: the relation kind,
the related **instance** type, whether the loaded value is a collection,
the pivot-attributes type, and an optional custom builder type.

```ts
BelongsTo<R, B = unknown>              // R | undefined
HasOne<R, B = unknown>                 // R | undefined
HasMany<R, B = unknown>                // Collection<R> | undefined
BelongsToMany<R, Pivot = NoPivot, B = unknown>   // Collection<R & { pivot: Pivot }> | undefined
HasOneThrough<R, B = unknown>          // R | undefined
HasManyThrough<R, B = unknown>         // Collection<R> | undefined
MorphTo<R>                             // R | undefined
MorphOne<R, B = unknown>               // R | undefined
MorphMany<R, B = unknown>              // Collection<R> | undefined
MorphToMany<R, Pivot = NoPivot, B = unknown>     // Collection<R & { pivot: Pivot }> | undefined
MorphedByMany<R, Pivot = NoPivot, B = unknown>   // Collection<R & { pivot: Pivot }> | undefined
```

The `{ pivot: P }` intersection only appears when `Pivot` is non-empty, so
a many-to-many with no declared pivot attributes resolves to a plain
`Collection<R> | undefined` like any other to-many.

`MorphTo` is the only marker with no builder parameter, its query-side
accessor is a `MorphToBuilder`, which isn't customisable per relation.

The optional last parameter `B` names a **custom builder** for the
query-side accessor, which is otherwise the related model's default:

```ts
interface PostAttributes {
  comments: HasMany<Comment, CommentBuilder>;
}

post.relations.comments().approved();   // CommentBuilder's own scope, typed
```

### Name-checking, and where it stops

`with()`, `whereHas()`, `withCount()` and the morph-aware methods narrow
their name argument to the declared relation names, off `Model.query()`
with no per-model markers:

```ts
Post.query().with("nope");                       // compile error
Post.query().whereHas("alsoNope");               // compile error
Comment.query().whereMorphedTo("author", post);  // compile error: author is a belongsTo
```

The names come from the **markers** in the attributes interface, the
`RelationKeys<A>` of the map the factory threads into the builder, not
from the runtime `relationships` map. In practice the two agree, because
the compiler requires the map to have exactly the marker's keys. The one
observable gap: a model that declares markers and omits `static
relationships` entirely still accepts those names at compile time, and
throws at runtime.

The narrowing is **name-level only**. What it does not do is narrow the
related model's *columns*: the constraint callbacks in `whereHas()` and
`with({ … })` receive a permissively-typed builder, because a helper
definition erases its related class to a structural model. Cast the
callback argument when you want the related model's column names checked.

The **runtime** checks are independent and still fire, an unknown name
throws, and `whereMorphedTo()` on a non-`morphTo` throws, which is what
covers callers arriving through an untyped path.

Because a passing valid name typechecks whether the relation map is the
real one or `any`, the runtime suite cannot detect a regression in the
narrowing. Negative type assertions can: each `@ts-expect-error` fails the
build if the line below it ever starts compiling.

### What a loaded relation holds

Two types answer that question, on two sides of the same rule.

On the **marker** side, the one that types your instance, it's
`LoadedValueOf`, which reads the `ToMany` and `Pivot` slots off the brand:

```ts
V extends RelationMarker<any, infer R, infer ToMany, infer Pivot, any>
  ? ToMany extends true
    ? Collection<WithPivot<R, Pivot>> | undefined
    : R | undefined
  : never
```

On the **definition** side, used by the builder's row-type merging,
it's `RelationValueOf`, keyed off the `type` literal:

```ts
Def extends { type: "morphTo" }
  ? MorphTargetOf<Def> | undefined
  : Def extends { type: "belongsTo" | "hasOne" | "morphOne" | "hasOneThrough" }
    ? RelatedInstanceOf<Def> | undefined
    : Collection<RelatedInstanceOf<Def>>
```

`ResolvedAttributes<A>` is a one-liner over `LoadedValueOf`, and
`EagerLoadResult`/`NestedEagerLoadResult` are one-liners over
`RelationValueOf`, so `post.comments` and
`Post.query().with("comments").get()` cannot disagree about the shape.

`NestedEagerLoadResult` extends the same rule down a dot path: it groups
requested paths by first segment, so sibling paths under one head merge
into a single value type, mirroring the single query the loader issues,
and preserves the to-one/to-many shape at each level, so
`with("comments.author")` types `post.comments` as
`Collection<Comment & { author: User }>` rather than losing either the
`Collection` wrapper or the nested value.

Stepping from one model to the next reads the related instance out of the
phantom brand the relation helpers carry (`belongsTo(() => User, …)`
records `User` in its `__brand`). The helper's own `related` thunk is
declared `() => ModelLike`, which erases the concrete class, so the brand
is the only place the related type survives, reading it is what lets the
walk continue past the first segment. A hand-written definition has no
brand but names its class directly in the thunk, so that is used as the
fallback and both spellings resolve identically.

`RelationDefinition` is a union whose `morphTo` member has **no `related`
key**. It points at several models, so there's no single class to name.
Any code reaching for `definition.related()` must therefore do so inside a
switch that has already excluded `morphTo`; the compiler enforces it.
