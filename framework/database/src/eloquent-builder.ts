import { Collection } from "@mahiframework/core";
import type { DateTime } from "@mahiframework/datetime";
import { applyWhen } from "./conditionable.js";
import { findSoftDeleteScope } from "./soft-delete-support.js";
import {
  QueryBuilder,
  type DateWhereArgs,
  type JoinClause,
  type JsonLengthArgs,
  type SqlBinding,
  type Subquery,
  type WhereArgs,
  type WhereOperator,
} from "./query-builder.js";
import type { Bindable } from "./bindings.js";
import type { Attributes, Model, ModelClass, RelationAccessors, AnyModelClass } from "./model.js";
import { ModelNotFoundError } from "./model.js";
import { loadRelations } from "./eager-loading.js";
import {
  cloneTree,
  isConstraintMap,
  parseEagerLoad,
  type EagerLoadTree,
} from "./eager-load-tree.js";
import { Relation } from "./morph-map.js";
import type {
  MorphToKeys,
  NestedEagerLoadResult,
  RelatedRowOf,
  RelationDefinition,
  RelationDefinitions,
  RelationPath,
} from "./relations.js";

/**
 * A hydrated row as returned by a terminal (`get()`/`first()`/...),
 * a real `Model` instance (the terminals hydrate through
 * `model.hydrate()`, so `save()`/`toObject()`/`isDirty()`/`loadMissing()`
 * are all present) carrying the declared `TRow` attributes plus the
 * relation accessors derived from the model's `TRelations` map: the
 * loaded value-side (`post.comments`, a `Collection` once eager-loaded)
 * and the query-side `relations` namespace
 * (`post.relations.comments()`). `TRelations` defaults to an empty map on
 * a builder constructed without a declared relations type, so an
 * un-annotated `EloquentBuilder<Row>` adds no accessors (rather than a
 * string index signature that would blur `Row`).
 *
 * The `Model` half matches `WithRelations<M>`, which is what the *finder*
 * entry points (`find()`/`firstOrFail()`/...) return, both hand back the
 * same hydrated instance at runtime, so they must agree at the type level
 * too. `TCasts` is the model's `static casts` map (`CastsOf<M>`), so a
 * `BooleanCast` column types as `boolean` here while `where()` still
 * sees the DB `TRow` (`number`). Defaults to an empty map so an
 * un-annotated `EloquentBuilder<Row>` is unchanged.
 */
export type Hydrated<
  TRow extends Record<string, any>,
  TRelations extends RelationDefinitions,
  TCasts = Record<never, never>,
> = 0 extends 1 & TRow ? any : Model & Attributes<TRow, TCasts> & RelationAccessors<TRelations>;

/** The head segment of a dot path, `"author"` for `"author.team"`. */
type HeadSegment<P extends string> = P extends `${infer H}.${string}` ? H : P;

/** The remainder of a dot path below head `H`, or `never` if `P` is just `H`. */
type RestSegments<P extends string, H extends string> = P extends `${H}.${infer R}` ? R : never;

/**
 * Narrows an instance type `M` so every relation named by a requested dot
 * path `K` is non-`undefined`, at each segment, the `with(...)`
 * return-type transform on the resolved instance side.
 *
 * Paths are grouped by head before descending, so siblings under one head
 * (`with("author.team", "author.posts")`) narrow into a single value the
 * way the loader merges them into a single node.
 */
export type LoadedBy<M, K extends string> = [M] extends [never]
  ? M
  : [NestedHeads<K>] extends [never]
    ? M & { [H in HeadSegment<K> & keyof M]-?: Exclude<M[H], undefined> }
    : Omit<M, NestedHeads<K>> & {
        [H in HeadSegment<K> & keyof M]-?: LoadNested<Exclude<M[H], undefined>, RestSegments<K, H>>;
      };

/**
 * The heads of `K` that carry further segments, the ones whose value type
 * is *replaced* rather than merely un-optionalised.
 *
 * A head with no rest (`with("author")`) only drops `undefined`, which an
 * intersection expresses exactly. A head with a rest rebuilds the value
 * (a `Collection<Comment>` becomes a `Collection<Comment & …>`), and
 * intersecting the old and new shapes would leave both members visible.
 * Omitting those keys first is what makes the narrowed type the only one.
 */
type NestedHeads<K extends string> = K extends `${infer H}.${string}` ? H : never;

/**
 * Applies the remaining path segments to a loaded relation value,
 * preserving whether the relation is to-one or to-many, so
 * `with("comments.author")` narrows the *elements* of the `Collection`
 * rather than the `Collection` itself.
 */
type LoadNested<V, Rest extends string> = [Rest] extends [never]
  ? V
  : V extends Collection<infer I, infer Key>
    ? Collection<LoadedBy<I, Rest>, Key>
    : LoadedBy<V, Rest>;

/**
 * Model-aware query builder, mirrors Laravel's
 * `Illuminate\Database\Eloquent\Builder` wrapping
 * `Illuminate\Database\Query\Builder` via a `protected $query` property
 * (composition, not inheritance). Every chainable method here **manually
 * redefines** the matching `QueryBuilder` method, delegating to
 * `this.query.xxx()` and returning `this`, no `__call`-style forwarding
 * magic, consistent with this codebase's "no magic" stance (see
 * `container.ts`'s docstring: "no auto-wiring, no decorators, no
 * reflect-metadata").
 *
 * Holds a reference to the owning `Model` subclass (not a Kysely instance
 * directly) so it can resolve its connection lazily at execution time via
 * `model.resolveConnection()`. This is what allows a query built outside
 * a `transaction()` block to still be *executed* inside one, and is also
 * how `whereKey()` knows which column is the primary key.
 *
 * ## Nested/grouped where callbacks
 *
 * `where(callback)`/`orWhere(callback)` build the nested condition group
 * using a **fresh builder of this same subclass** (via `newInstance()`,
 * which reads the constructor off the instance) rather than a plain
 * `QueryBuilder`, so a nested group inside a custom `PostBuilder`
 * subclass's scope can still call that subclass's own scope methods:
 *
 *   Post.query().where("published", 1).where((q) =>
 *     (q as PostBuilder).featured().orWhere("pinned", 1)
 *   );
 *
 * The nested builder's accumulated where-tree is merged into the parent
 * as a single group (`QueryBuilder.pushWhereGroup()`) once the callback
 * returns; nothing about the nested builder (its own would-be
 * `resolveConnection`/table) is otherwise used.
 *
 * Subclass this to add
 * per-model query scopes, e.g. `class PostBuilder extends
 * EloquentBuilder<PostAttributes> { published() { return
 * this.where("published", true); } }`. And return it from the model's
 * own `static query()` override (see `Model` docstring).
 *
 * ## Eager loading (`with()`)
 *
 * The second generic parameter, `TRelations`, is the model's declared
 * `static relations` shape (see `relations.ts`'s `RelationDefinition`
 * docstring). It defaults to an empty map, and `BuilderOf<M>` threads
 * `RelationsOf<M>` (read off `typeof M.relations`) in for it, so
 * `with()`'s name-checking works with no per-model markers:
 *
 *   Post.query().with("author");   // ok, declared
 *   Post.query().with("nope");     // compile error
 *
 * A *custom* builder subclass spelling the generics out itself,
 * `class PostBuilder extends EloquentBuilder<PostTable, typeof Post.relations>`
 * (paired with `declare static Builder: PostBuilder`), narrows the same
 * way; that path is what the `Builder` marker exists for.
 *
 * The value-side accessors agree: `WithRelations<M>` reads
 * `RelationsOf<M>` directly, so loaded relations are typed identically
 * whichever entry point produced them.
 *
 *   const posts = await Post.query().with("author", "images").get();
 *   posts.first()!.author  // User | undefined, typed from the declaration
 *
 * `with()` only queues the relation names; the actual batched queries
 * run once inside `get()`/`first()`, via `eager-loading.ts`'s
 * `loadRelations()`.
 */
export class EloquentBuilder<
  TRow extends Record<string, any>,
  TRelations extends RelationDefinitions = Record<never, never>,
  TCasts = Record<never, never>,
  TInstance = Hydrated<TRow, TRelations, TCasts>,
> {
  protected query: QueryBuilder<TRow>;
  private eagerLoad: EagerLoadTree = new Map();

  constructor(protected model: ModelClass) {
    this.query = new QueryBuilder<TRow>(() => model.resolveConnection(), model.table);
  }

  /**
   * The `Model` subclass this builder queries, Laravel's
   * `Builder::getModel()`. Exposed so a `GlobalScope` can read the
   * model's `table`/`primaryKeyColumn` when it applies itself (a scope
   * only receives the builder), which is what lets `SoftDeleteScope`
   * qualify its column and stay join-safe.
   */
  getModel(): ModelClass {
    return this.model;
  }

  // Casts
  //
  // Every value this builder binds, a `where()` comparand, a `whereIn()`
  // list, an `update()`/`insert()` payload, is MODEL-shape, exactly like
  // the values `setAttribute()` and the static `Model.update()` take. The
  // underlying `QueryBuilder` is model-unaware and binds what it is
  // given, so without this step a cast column binds the wrong type:
  // `.update({ published_at: someDateTime })` binds a `DateTime` object,
  // and `.update({ meta: { a: 1 } })` binds a plain object.
  //
  // The SQLite and MySQL drivers reject both outright; Postgres's `pg`
  // silently serialises them, so the same code "works" on one engine and
  // throws on two. Booleans are the exception that hid this: the SQLite
  // driver coerces them at its own boundary
  // (`error-translating-dialect.ts`), which is why a SQLite-only suite
  // saw nothing wrong.
  //
  // Only *declared* casts apply, and only to keys that name a cast
  // column, so an aliased/computed selection or a raw expression passes
  // through untouched.

  /**
   * A single value cast to its DB shape for `column`, or returned
   * unchanged when the column declares no cast.
   *
   * A qualified column (`posts.published`) is matched on its last
   * segment, since that is what the model's cast map is keyed by, a
   * joined query still spells its own columns with the table prefix.
   */
  private castBinding(column: string, value: unknown): any {
    // A subquery/expression is not a value; casting one would be
    // meaningless at best and would mangle it at worst.
    if (value === null || value === undefined || typeof value === "function") {
      return value;
    }

    const cast = this.model.casts[column] ?? this.model.casts[column.split(".").pop() ?? column];

    return cast ? cast.toDatabaseType(value) : value;
  }

  /** `castBinding()` across a value list, the `whereIn`/`whereNotIn` path. */
  private castBindings(column: string, values: readonly unknown[]): any[] {
    return values.map((value) => this.castBinding(column, value));
  }

  /**
   * A write payload with every declared cast column converted to its DB
   * shape, then run through `prepareWrite()` so a datetime column is
   * spelled the way this model's engine accepts (MySQL rejects the ISO
   * `Z` that `DateTimeCast` produces).
   *
   * This is the same two-step the static `Model.update()` performs, and
   * the reason both exist: `DateTimeCast` cannot know the connection, so
   * the dialect fix-up has to happen at the point of the write.
   */
  private castWrite<T extends Record<string, any>>(values: T): T {
    let out: Record<string, any> | undefined;

    for (const [column, value] of Object.entries(values)) {
      const cast = this.castBinding(column, value);

      if (cast === value) {
        continue;
      }

      out ??= { ...values };
      out[column] = cast;
    }

    return this.model.prepareWrite((out as T) ?? values);
  }

  /**
   * Queues relations to be batch-loaded when this builder's
   * `get()`/`first()` runs. See the class docstring's "Eager loading"
   * section and `relations.ts`'s `RelationDefinition` docstring for how
   * to declare them on a `Model`.
   *
   * Three forms, all of which compose:
   *
   *   .with("author", "comments")          // names
   *   .with("author.team")                 // dot path, any depth (capped at 5 for TYPING)
   *   .with({ comments: (q) => q.where("approved", 1) })   // constrained
   *
   * A dot path implies every prefix of itself, and repeated prefixes
   * merge into one node. `.with("author.team", "author.posts")` runs ONE
   * `author` query with two children hanging off it, not two. The cost
   * model is one batched query per relation **node**, independent of row
   * count, so nesting never reintroduces N+1.
   *
   * In the object form the closure receives the related model's own
   * `EloquentBuilder` before the batched `whereIn` executes, the same
   * shape `whereHas()`'s constraint takes. A `morphTo` is the exception:
   * its callback gets a `MorphToSpec` (per-type `constrain()` and
   * `morphWith()`), since a morph union has no single builder to
   * constrain.
   *
   * Two documented sharp edges: a constraint that filters rows out makes
   * a to-many attach fewer and a to-one attach `undefined` (it narrows
   * the relation, it doesn't error), and `limit()` inside a constraint
   * throws. See `applyConstraint` in `eager-loading.ts` for why.
   */
  with<K extends RelationPath<TRelations>>(
    ...names: K[]
  ): EloquentBuilder<
    TRow & NestedEagerLoadResult<TRelations, K>,
    TRelations,
    TCasts,
    LoadedBy<TInstance, K>
  >;
  // The `& object` is required: `Partial<Record<K, …>>` collapses to
  // `{}` when `K` is `never` (a model declaring no relations), and every
  // non-nullish value, including a string, is assignable to `{}`. That
  // silently re-admits `Bare.query().with("anything")` through the object
  // overload after the varargs one correctly rejected it. `object`
  // excludes primitives, so the overload only matches actual objects.
  with<K extends RelationPath<TRelations>>(
    map: Partial<Record<K, (query: any) => void>> & object,
  ): EloquentBuilder<
    TRow & NestedEagerLoadResult<TRelations, K>,
    TRelations,
    TCasts,
    LoadedBy<TInstance, K>
  >;
  with(...names: any[]): any {
    const request = isConstraintMap(names[0]) ? names[0] : (names as string[]);
    parseEagerLoad(request, this.eagerLoad);

    return this;
  }

  /**
   * Adds a correlated `{name}_count` subquery column for each named
   * relation, Laravel's `withCount()`. Each name is resolved through the
   * same `static relations` map `with()` uses; the added column counts
   * the related rows correlated to each parent row (respecting the
   * related model's global scopes, e.g. `SoftDeletes`). Widens the row
   * type with a `${name}_count: number` field per name.
   *
   *   const posts = await Post.query().withCount("comments").get();
   *   posts.first()!.comments_count // number
   *
   * A `belongsTo`/`hasOne` count is 0 or 1; a `hasMany`/`belongsToMany`
   * count is the full related-row count.
   *
   * Takes the same object form `with()` does, to count a *filtered*
   * subset, the callback receives the related model's builder and
   * narrows the subquery, exactly as `whereHas()`'s does:
   *
   *   Post.query().withCount({ comments: (q) => q.where("approved", 1) });
   *   // comments_count counts only approved comments
   *
   * Unlike `with()`, the names here are single relations, not dot paths:
   * the count is a correlated subquery against one related table, and
   * there is no meaningful "count of a nested relation" to project onto
   * the parent row.
   */
  withCount<K extends keyof TRelations & string>(
    ...names: K[]
  ): EloquentBuilder<
    TRow & { [P in K as `${P}_count`]: number },
    TRelations,
    TCasts,
    TInstance & { [P in K as `${P}_count`]: number }
  >;
  // `& object` for the same reason as `with()`'s object overload. See
  // the comment there.
  withCount<K extends keyof TRelations & string>(
    map: Partial<Record<K, (query: any) => void>> & object,
  ): EloquentBuilder<
    TRow & { [P in K as `${P}_count`]: number },
    TRelations,
    TCasts,
    TInstance & { [P in K as `${P}_count`]: number }
  >;
  withCount(...names: any[]): any {
    const entries: [string, ((query: any) => void) | undefined][] = isConstraintMap(names[0])
      ? Object.entries(names[0] as Record<string, (query: any) => void>)
      : (names as string[]).map((name) => [name, undefined]);

    for (const [name, constrain] of entries) {
      const definition = this.relationDefinition(name);
      const sub = this.buildRelationSubquery(definition, constrain);
      this.query.selectCount(sub, `${name}_count`);
    }

    return this;
  }

  /**
   * Filters to rows that HAVE at least one matching related row,
   * Laravel's `whereHas()`. Compiles to `WHERE EXISTS (correlated
   * subquery)`. The optional `constrain` callback receives the related
   * model's own `EloquentBuilder` to narrow the subquery further.
   *
   *   Post.query().whereHas("comments", (q) => q.where("approved", 1));
   */
  whereHas<K extends keyof TRelations & string>(
    name: K,
    constrain?: (query: EloquentBuilder<RelatedRowOf<TRelations[K]>>) => void,
  ): this {
    this.query.whereExists(this.buildRelationSubquery(this.relationDefinition(name), constrain));

    return this;
  }

  /** `whereHas()` joined with `OR`, Laravel's `orWhereHas()`. */
  orWhereHas<K extends keyof TRelations & string>(
    name: K,
    constrain?: (query: EloquentBuilder<RelatedRowOf<TRelations[K]>>) => void,
  ): this {
    this.query.orWhereExists(this.buildRelationSubquery(this.relationDefinition(name), constrain));

    return this;
  }

  /** Alias-style shorthand: filters to rows that have the relation, with no constraint. Laravel's `has()`. */
  has<K extends keyof TRelations & string>(name: K): this {
    return this.whereHas(name);
  }

  /**
   * Filters to rows that have NO matching related row, Laravel's
   * `whereDoesntHave()`/`doesntHave()`. Compiles to `WHERE NOT EXISTS`.
   */
  whereDoesntHave<K extends keyof TRelations & string>(
    name: K,
    constrain?: (query: EloquentBuilder<RelatedRowOf<TRelations[K]>>) => void,
  ): this {
    this.query.whereNotExists(this.buildRelationSubquery(this.relationDefinition(name), constrain));

    return this;
  }

  /** `whereDoesntHave()` joined with `OR`, Laravel's `orWhereDoesntHave()`. */
  orWhereDoesntHave<K extends keyof TRelations & string>(
    name: K,
    constrain?: (query: EloquentBuilder<RelatedRowOf<TRelations[K]>>) => void,
  ): this {
    this.query.orWhereNotExists(
      this.buildRelationSubquery(this.relationDefinition(name), constrain),
    );

    return this;
  }

  /** Alias for `whereDoesntHave(name)` with no constraint, Laravel's `doesntHave()`. */
  doesntHave<K extends keyof TRelations & string>(name: K): this {
    return this.whereDoesntHave(name);
  }

  /**
   * Filters to rows whose `morphTo` relation points at **this specific
   * model instance**, Laravel's `whereMorphedTo()`.
   *
   *   Comment.query().whereMorphedTo("commentable", post);
   *   // where commentable_type = 'post' and commentable_id = <post.id>
   *
   * No subquery: both columns live on this table, so it compiles to two
   * plain predicates. That makes it the cheapest way to ask "comments on
   * *that* post" and, unlike `whereHas()`, it works without knowing which
   * types the relation can point at.
   *
   * The discriminant is `related`'s own `morphAlias()`, so it agrees with
   * whatever `morphMany`/`morphToMany` would have written.
   *
   * `name` is narrowed to the model's `morphTo` relations, so passing an
   * ordinary `belongsTo` is a compile error:
   *
   *   Comment.query().whereMorphedTo("author", post);  // author is a belongsTo
   *
   * The runtime check below still fires, for callers coming through an
   * untyped path (a builder whose `TRelations` was never supplied, or a
   * name widened to `string`), and because a relation's *type* can only
   * be confirmed against the actual declaration.
   */
  whereMorphedTo<K extends MorphToKeys<TRelations>>(name: K, related: Model): this {
    return this.pushMorphedTo(name, related, "and", false);
  }

  /** `whereMorphedTo()` negated, rows pointing at anything BUT `related`. Laravel's `whereNotMorphedTo()`. */
  whereNotMorphedTo<K extends MorphToKeys<TRelations>>(name: K, related: Model): this {
    return this.pushMorphedTo(name, related, "and", true);
  }

  /** `whereMorphedTo()` joined with `OR`. */
  orWhereMorphedTo<K extends MorphToKeys<TRelations>>(name: K, related: Model): this {
    return this.pushMorphedTo(name, related, "or", false);
  }

  /** `whereNotMorphedTo()` joined with `OR`. */
  orWhereNotMorphedTo<K extends MorphToKeys<TRelations>>(name: K, related: Model): this {
    return this.pushMorphedTo(name, related, "or", true);
  }

  private pushMorphedTo(name: string, related: Model, connector: "and" | "or", not: boolean): this {
    const definition = this.relationDefinition(name);

    if (definition.type !== "morphTo") {
      throw new Error(`whereMorphedTo("${name}"): "${name}" is not a morphTo relation.`);
    }

    const { morphType, morphId } = definition.options;
    const relatedClass = Object.getPrototypeOf(related).constructor as AnyModelClass;
    const ownerKey = definition.options.ownerKey ?? relatedClass.primaryKeyColumn;

    const alias = relatedClass.morphAlias();
    const key = related.getRawAttribute(ownerKey);

    // Grouped so the two predicates negate as a unit: NOT (type = x AND
    // id = y), not NOT(type = x) AND id = y.
    this.query.pushWhereGroup(
      connector,
      not,
      this.model
        .newEloquentBuilder()
        .where(morphType, alias)
        .where(morphId, key)
        .toBase()
        .getWheres(),
    );

    return this;
  }

  /**
   * Filters to rows whose `morphTo` relation points at an existing parent
   * **of one of `types`**, Laravel's `whereHasMorph()`.
   *
   *   Comment.query().whereHasMorph("commentable", [Post, Video]);
   *
   *   Comment.query().whereHasMorph("commentable", [Post], (q) =>
   *     q.where("published", 1),
   *   );
   *
   * `whereHas()` can't do this: a correlated `EXISTS` needs one table to
   * correlate against, and a `morphTo`'s parents live in several. So the
   * type list is given explicitly, and each type contributes a disjunct
   * of the form `(discriminant = alias AND EXISTS (correlated subquery))`,
   * OR'd together and wrapped in one group.
   *
   * `constrain` receives the target model's own builder plus the
   * discriminant being handled, so a single callback can branch per type:
   *
   *   (q, type) => { if (type === "post") q.where("published", 1); }
   *
   * Pass `"*"` to expand to every entry in the global morph map. That
   * throws when the map is empty. An unregistered map would silently
   * match nothing, which is the worse failure.
   */
  whereHasMorph<K extends MorphToKeys<TRelations>>(
    name: K,
    types: AnyModelClass[] | "*",
    constrain?: (query: any, type: string) => void,
  ): this {
    return this.pushHasMorph(name, types, constrain, "and", false);
  }

  /** `whereHasMorph()` joined with `OR`. */
  orWhereHasMorph<K extends MorphToKeys<TRelations>>(
    name: K,
    types: AnyModelClass[] | "*",
    constrain?: (query: any, type: string) => void,
  ): this {
    return this.pushHasMorph(name, types, constrain, "or", false);
  }

  /** The complement of `whereHasMorph()`, no matching parent of any listed type. Laravel's `whereDoesntHaveMorph()`. */
  whereDoesntHaveMorph<K extends MorphToKeys<TRelations>>(
    name: K,
    types: AnyModelClass[] | "*",
    constrain?: (query: any, type: string) => void,
  ): this {
    return this.pushHasMorph(name, types, constrain, "and", true);
  }

  /** `whereDoesntHaveMorph()` joined with `OR`. */
  orWhereDoesntHaveMorph<K extends MorphToKeys<TRelations>>(
    name: K,
    types: AnyModelClass[] | "*",
    constrain?: (query: any, type: string) => void,
  ): this {
    return this.pushHasMorph(name, types, constrain, "or", true);
  }

  private pushHasMorph(
    name: string,
    types: AnyModelClass[] | "*",
    constrain: ((query: any, type: string) => void) | undefined,
    connector: "and" | "or",
    not: boolean,
  ): this {
    const definition = this.relationDefinition(name);

    if (definition.type !== "morphTo") {
      throw new Error(`whereHasMorph("${name}"): "${name}" is not a morphTo relation.`);
    }

    const { morphType, morphId } = definition.options;
    const resolved = this.resolveMorphTypes(name, types);

    const nested = this.model.newEloquentBuilder() as EloquentBuilder<TRow>;

    for (const [alias, target] of resolved) {
      const related = target as unknown as ModelClass;
      const ownerKey = definition.options.ownerKey ?? related.primaryKeyColumn;

      // Each disjunct is its own group: (type = alias AND EXISTS (...)).
      // Without the grouping the ORs would flatten and the discriminant
      // would stop guarding its own subquery.
      nested.orWhere((q) => {
        q.where(morphType as any, alias as any);
        q.whereExists(this.buildMorphExistsSubquery(related, ownerKey, morphId, constrain, alias));
      });
    }

    this.query.pushWhereGroup(connector, not, nested.toBase().getWheres());

    return this;
  }

  /**
   * The correlated subquery for one type of a `whereHasMorph()` disjunct:
   * the target model's own builder, correlated back to the parent's
   * `morphId` column, plus any caller constraint.
   *
   * Aliased `{table}__sub` for the same reason `buildRelationSubquery()`
   * is. The target may be the parent's own table (a comment on a
   * comment), and an unaliased predicate would compare the inner row to
   * itself.
   */
  private buildMorphExistsSubquery(
    related: ModelClass,
    ownerKey: string,
    morphId: string,
    constrain: ((query: any, type: string) => void) | undefined,
    alias: string,
  ): QueryBuilder<Record<string, any>> {
    const builder = related.query();

    if (constrain) {
      constrain(builder, alias);
    }

    const base = builder.toBase();
    const sub = `${related.table}__sub`;
    base.alias(sub);
    base.whereOuterColumn(`${sub}.${ownerKey}`, "=", `${this.model.table}.${morphId}`);

    return base;
  }

  /**
   * Expands a `whereHasMorph()` type argument into `[alias, class]` pairs.
   *
   * `"*"` reads the global morph map, which is the only enumerable source
   * of "every type this could be", a `morphTo`'s local `types` covers
   * only what one declaration chose to name statically, and neither can
   * see rows storing a discriminant nobody registered. An empty map
   * throws rather than matching nothing.
   */
  private resolveMorphTypes(name: string, types: AnyModelClass[] | "*"): [string, AnyModelClass][] {
    if (types !== "*") {
      return types.map((target) => [target.morphAlias(), target]);
    }

    const map = Relation.morphMap();
    const aliases = Object.keys(map);

    if (aliases.length === 0) {
      throw new Error(
        `whereHasMorph("${name}", "*"): the morph map is empty, so there are no types to expand to. ` +
          `Register one with Relation.morphMap({ ... }), or pass an explicit list of models.`,
      );
    }

    return aliases.map((alias) => [alias, map[alias]!()]);
  }

  /** Resolves a declared relation by name, throwing the same clear error `with()` does for a typo. */
  private relationDefinition(name: string): RelationDefinition {
    const definition = this.model.relations[name];

    if (!definition) {
      throw new Error(
        `${name}: no relation named "${name}" is declared in ${this.model.table}'s "static relations".`,
      );
    }

    return definition;
  }

  /**
   * Builds the correlated subquery `QueryBuilder` behind `withCount()`/
   * `whereHas()`/`doesntHave()` for one relation definition: the related
   * model's own scoped builder, plus a correlation predicate tying the
   * related table's key back to THIS query's parent table, plus any
   * caller-supplied `constrain` callback. Returns the underlying base
   * `QueryBuilder` (via `toBase()`), correlated to the parent row.
   *
   * The correlation is expressed with `whereColumn()`/`whereIn()`
   * against qualified column names rather than a hand-built
   * `whereRaw()` string, so identifier quoting is Kysely's problem and
   * comes out right per engine. MySQL reads a `"quoted"` identifier as
   * a *string literal*, so the string-built form emitted predicates that
   * compared two constants there instead of two columns.
   *
   * ## Why the subquery's table is aliased
   *
   * The subquery always selects from `{related.table} as {alias}` and
   * qualifies its own side with the alias, leaving the outer side
   * qualified by the parent's real table name. Without that, a
   * **self-referential** relation (parent and related the same table)
   * produces a predicate comparing a table to itself:
   *
   *   "posts"."parent_id" = "posts"."id"    -- ✗ both resolve to the inner row
   *   "posts__sub"."parent_id" = "posts"."id"  -- ✓ inner vs. outer
   *
   * The alias is unconditional rather than applied only when the tables
   * collide, so the emitted SQL has one shape to reason about. The
   * `__sub` suffix can't collide with a real table in the query: the
   * only other tables present are the parent's and any the caller's
   * `constrain` callback brings in, and both would have to be named
   * `{related.table}__sub` exactly.
   */
  private buildRelationSubquery(
    definition: RelationDefinition,
    constrain?: (query: any) => void,
  ): QueryBuilder<Record<string, any>> {
    if (definition.type === "morphTo") {
      // A morphTo's parents live in different tables, so there is no
      // single table to correlate an EXISTS against. The subquery would
      // have to be a UNION whose shape depends on data. `whereHasMorph()`
      // is the supported form: it takes the type list explicitly and
      // emits one correlated disjunct per type.
      throw new Error(
        "whereHas()/withCount() cannot be used on a morphTo relation — its target table isn't known " +
          "until each row's discriminant is read. Use whereHasMorph() instead.",
      );
    }

    const related = definition.related() as unknown as ModelClass;
    const relatedBuilder = related.query();

    if (constrain) {
      constrain(relatedBuilder);
    }

    const base = relatedBuilder.toBase();
    const parent = this.model.table;
    const sub = `${related.table}__sub`;
    base.alias(sub);

    switch (definition.type) {
      case "belongsTo": {
        const ownerKey = definition.options.ownerKey ?? related.primaryKeyColumn;
        base.whereOuterColumn(
          `${sub}.${ownerKey}`,
          "=",
          `${parent}.${definition.options.foreignKey}`,
        );
        break;
      }
      case "hasMany":
      case "hasOne": {
        const localKey = definition.options.localKey ?? this.model.primaryKeyColumn;
        base.whereOuterColumn(
          `${sub}.${definition.options.foreignKey}`,
          "=",
          `${parent}.${localKey}`,
        );
        break;
      }
      case "morphMany":
      case "morphOne": {
        const { morphType, morphId } = definition.options;
        const localKey = definition.options.localKey ?? this.model.primaryKeyColumn;
        const type = definition.options.type ?? this.model.morphAlias();
        base.where(morphType, type as any);
        base.whereOuterColumn(`${sub}.${morphId}`, "=", `${parent}.${localKey}`);
        break;
      }
      case "belongsToMany": {
        const { pivotTable, foreignPivotKey, relatedPivotKey } = definition.options;
        const localKey = definition.options.localKey ?? this.model.primaryKeyColumn;
        const relatedKey = definition.options.relatedKey ?? related.primaryKeyColumn;
        base.whereIn(`${sub}.${relatedKey}`, (q) => {
          q.table(pivotTable)
            .select(relatedPivotKey)
            .whereOuterColumn(`${pivotTable}.${foreignPivotKey}`, "=", `${parent}.${localKey}`);
        });
        break;
      }
      case "morphToMany": {
        const { pivotTable, morphType, morphId, relatedPivotKey } = definition.options;
        const localKey = definition.options.localKey ?? this.model.primaryKeyColumn;
        const relatedKey = definition.options.relatedKey ?? related.primaryKeyColumn;
        // The discriminant names THIS model. See MorphToManyOptions.
        const type = definition.options.type ?? this.model.morphAlias();
        base.whereIn(`${sub}.${relatedKey}`, (q) => {
          q.table(pivotTable)
            .select(relatedPivotKey)
            .whereOuterColumn(`${pivotTable}.${morphId}`, "=", `${parent}.${localKey}`)
            .where(`${pivotTable}.${morphType}`, type);
        });
        break;
      }
      case "morphedByMany": {
        const { pivotTable, morphType, morphId, foreignPivotKey } = definition.options;
        const localKey = definition.options.localKey ?? this.model.primaryKeyColumn;
        const relatedKey = definition.options.relatedKey ?? related.primaryKeyColumn;
        // ...and the RELATED model on this side.
        const type = definition.options.type ?? related.morphAlias();
        base.whereIn(`${sub}.${relatedKey}`, (q) => {
          q.table(pivotTable)
            .select(morphId)
            .whereOuterColumn(`${pivotTable}.${foreignPivotKey}`, "=", `${parent}.${localKey}`)
            .where(`${pivotTable}.${morphType}`, type);
        });
        break;
      }
      case "hasManyThrough":
      case "hasOneThrough": {
        const through = definition.options.through() as unknown as ModelClass;
        const { firstKey, secondKey } = definition.options;
        const localKey = definition.options.localKey ?? this.model.primaryKeyColumn;
        const secondLocalKey = definition.options.secondLocalKey ?? through.primaryKeyColumn;
        base.whereIn(`${sub}.${secondKey}`, (q) => {
          q.table(through.table)
            .select(secondLocalKey)
            .whereOuterColumn(`${through.table}.${firstKey}`, "=", `${parent}.${localKey}`);
        });
        break;
      }
    }

    return base;
  }

  /**
   * Constructs a fresh builder of the SAME (possibly custom) subclass as
   * this one, bound to the same model, so a nested `where(callback)` group
   * inside a `PostBuilder` scope can call that subclass's own scope methods,
   * with `static query()` as the single builder override point (no
   * `newEloquentBuilder()` model hook needed). Reads the constructor off the
   * instance, which is the actual runtime subclass.
   */
  protected newInstance(): this {
    const Ctor = this.constructor as new (model: ModelClass) => this;

    return new Ctor(this.model);
  }

  /** Builds a nested builder of the same subclass and merges its where-tree into `this.query` as one group. */
  private mergeNestedWhere(
    connector: "and" | "or",
    not: boolean,
    callback: (builder: EloquentBuilder<TRow>) => void,
  ): this {
    const nested = this.newInstance() as unknown as EloquentBuilder<TRow>;
    callback(nested);
    this.query.pushWhereGroup(connector, not, (nested as any).query.getWheres());

    return this;
  }

  where<K extends keyof TRow & string>(column: K, operator: WhereOperator, value: TRow[K]): this;
  where<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  where(callback: (builder: EloquentBuilder<TRow>) => void): this;
  where<K extends keyof TRow & string>(
    columnOrCallback: K | ((builder: EloquentBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    if (typeof columnOrCallback === "function") {
      return this.mergeNestedWhere("and", false, columnOrCallback);
    }

    if (args.length === 2) {
      this.query.where(columnOrCallback, args[0], this.castBinding(columnOrCallback, args[1]));
    } else {
      this.query.where(columnOrCallback, this.castBinding(columnOrCallback, args[0]!));
    }

    return this;
  }

  orWhere<K extends keyof TRow & string>(column: K, operator: WhereOperator, value: TRow[K]): this;
  orWhere<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  orWhere(callback: (builder: EloquentBuilder<TRow>) => void): this;
  orWhere<K extends keyof TRow & string>(
    columnOrCallback: K | ((builder: EloquentBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    if (typeof columnOrCallback === "function") {
      return this.mergeNestedWhere("or", false, columnOrCallback);
    }

    if (args.length === 2) {
      this.query.orWhere(columnOrCallback, args[0], this.castBinding(columnOrCallback, args[1]));
    } else {
      this.query.orWhere(columnOrCallback, this.castBinding(columnOrCallback, args[0]!));
    }

    return this;
  }

  whereNot<K extends keyof TRow & string>(column: K, operator: WhereOperator, value: TRow[K]): this;
  whereNot<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  whereNot(callback: (builder: EloquentBuilder<TRow>) => void): this;
  whereNot<K extends keyof TRow & string>(
    columnOrCallback: K | ((builder: EloquentBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    if (typeof columnOrCallback === "function") {
      return this.mergeNestedWhere("and", true, columnOrCallback);
    }

    if (args.length === 2) {
      this.query.whereNot(columnOrCallback, args[0], this.castBinding(columnOrCallback, args[1]));
    } else {
      this.query.whereNot(columnOrCallback, this.castBinding(columnOrCallback, args[0]!));
    }

    return this;
  }

  orWhereNot<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: TRow[K],
  ): this;
  orWhereNot<K extends keyof TRow & string>(column: K, value: TRow[K]): this;
  orWhereNot(callback: (builder: EloquentBuilder<TRow>) => void): this;
  orWhereNot<K extends keyof TRow & string>(
    columnOrCallback: K | ((builder: EloquentBuilder<TRow>) => void),
    ...args: WhereArgs<TRow, K> | []
  ): this {
    if (typeof columnOrCallback === "function") {
      return this.mergeNestedWhere("or", true, columnOrCallback);
    }

    if (args.length === 2) {
      this.query.orWhereNot(columnOrCallback, args[0], this.castBinding(columnOrCallback, args[1]));
    } else {
      this.query.orWhereNot(columnOrCallback, this.castBinding(columnOrCallback, args[0]!));
    }

    return this;
  }

  /** `where(model.primaryKeyColumn, id)`, the primary-key equality shorthand used by `find()`. */
  whereKey(id: Bindable): this {
    return this.where(
      this.model.primaryKeyColumn as keyof TRow & string,
      id as TRow[keyof TRow & string],
    );
  }

  whereIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.query.whereIn(column, this.castValueList(column, values));

    return this;
  }

  orWhereIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.query.orWhereIn(column, this.castValueList(column, values));

    return this;
  }

  whereNotIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.query.whereNotIn(column, this.castValueList(column, values));

    return this;
  }

  orWhereNotIn<K extends keyof TRow & string>(column: K, values: TRow[K][] | Subquery): this {
    this.query.orWhereNotIn(column, this.castValueList(column, values));

    return this;
  }

  /**
   * The `whereIn`-family argument with its values cast, leaving a
   * subquery (a callback or a builder) alone. There are no bindings to
   * cast in that form, and the SQL it produces is the model's business,
   * not this builder's.
   */
  private castValueList<K extends keyof TRow & string>(
    column: K,
    values: TRow[K][] | Subquery,
  ): TRow[K][] | Subquery {
    if (!Array.isArray(values)) {
      return values;
    }

    return this.castBindings(column, values) as TRow[K][];
  }

  whereNull<K extends keyof TRow & string>(column: K): this {
    this.query.whereNull(column);

    return this;
  }

  orWhereNull<K extends keyof TRow & string>(column: K): this {
    this.query.orWhereNull(column);

    return this;
  }

  whereNotNull<K extends keyof TRow & string>(column: K): this {
    this.query.whereNotNull(column);

    return this;
  }

  orWhereNotNull<K extends keyof TRow & string>(column: K): this {
    this.query.orWhereNotNull(column);

    return this;
  }

  whereBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.query.whereBetween(column, this.castBinding(column, min), this.castBinding(column, max));

    return this;
  }

  orWhereBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.query.orWhereBetween(column, this.castBinding(column, min), this.castBinding(column, max));

    return this;
  }

  whereNotBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.query.whereNotBetween(
      column,
      this.castBinding(column, min),
      this.castBinding(column, max),
    );

    return this;
  }

  orWhereNotBetween<K extends keyof TRow & string>(column: K, min: TRow[K], max: TRow[K]): this {
    this.query.orWhereNotBetween(
      column,
      this.castBinding(column, min),
      this.castBinding(column, max),
    );

    return this;
  }

  whereColumn<K extends keyof TRow & string>(first: K, operator: WhereOperator, second: K): this {
    this.query.whereColumn(first, operator, second);

    return this;
  }

  orWhereColumn<K extends keyof TRow & string>(first: K, operator: WhereOperator, second: K): this {
    this.query.orWhereColumn(first, operator, second);

    return this;
  }

  whereExists(subquery: Subquery): this {
    this.query.whereExists(subquery);

    return this;
  }

  orWhereExists(subquery: Subquery): this {
    this.query.orWhereExists(subquery);

    return this;
  }

  whereNotExists(subquery: Subquery): this {
    this.query.whereNotExists(subquery);

    return this;
  }

  orWhereNotExists(subquery: Subquery): this {
    this.query.orWhereNotExists(subquery);

    return this;
  }

  whereRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.query.whereRaw(sqlText, bindings);

    return this;
  }

  orWhereRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.query.orWhereRaw(sqlText, bindings);

    return this;
  }

  /**
   * `LIKE` match that folds case on every engine. See
   * `QueryBuilder.whereLike()`.
   *
   * The pattern is passed through without `castBinding()`, unlike
   * `where()`'s comparand: it is a `LIKE` pattern, not a column value,
   * so a cast declared for `column` (a JSON serialiser, a `DateTime`
   * formatter) would mangle `%foo%` rather than prepare it.
   */
  whereLike<K extends keyof TRow & string>(
    column: K,
    pattern: string,
    options?: { caseInsensitive?: boolean },
  ): this {
    this.query.whereLike(column, pattern, options);

    return this;
  }

  orWhereLike<K extends keyof TRow & string>(
    column: K,
    pattern: string,
    options?: { caseInsensitive?: boolean },
  ): this {
    this.query.orWhereLike(column, pattern, options);

    return this;
  }

  whereNotLike<K extends keyof TRow & string>(
    column: K,
    pattern: string,
    options?: { caseInsensitive?: boolean },
  ): this {
    this.query.whereNotLike(column, pattern, options);

    return this;
  }

  orWhereNotLike<K extends keyof TRow & string>(
    column: K,
    pattern: string,
    options?: { caseInsensitive?: boolean },
  ): this {
    this.query.orWhereNotLike(column, pattern, options);

    return this;
  }

  whereDate<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  whereDate<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  whereDate(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.whereDate(column, args[0], args[1]);
    } else {
      this.query.whereDate(column, args[0]);
    }

    return this;
  }

  orWhereDate<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  orWhereDate<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  orWhereDate(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.orWhereDate(column, args[0], args[1]);
    } else {
      this.query.orWhereDate(column, args[0]);
    }

    return this;
  }

  whereTime<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  whereTime<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  whereTime(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.whereTime(column, args[0], args[1]);
    } else {
      this.query.whereTime(column, args[0]);
    }

    return this;
  }

  orWhereTime<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | Date | DateTime,
  ): this;
  orWhereTime<K extends keyof TRow & string>(column: K, value: string | Date | DateTime): this;
  orWhereTime(column: string, ...args: DateWhereArgs<string | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.orWhereTime(column, args[0], args[1]);
    } else {
      this.query.orWhereTime(column, args[0]);
    }

    return this;
  }

  whereDay<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  whereDay<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  whereDay(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.whereDay(column, args[0], args[1]);
    } else {
      this.query.whereDay(column, args[0]);
    }

    return this;
  }

  orWhereDay<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  orWhereDay<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  orWhereDay(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.orWhereDay(column, args[0], args[1]);
    } else {
      this.query.orWhereDay(column, args[0]);
    }

    return this;
  }

  whereMonth<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  whereMonth<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  whereMonth(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.whereMonth(column, args[0], args[1]);
    } else {
      this.query.whereMonth(column, args[0]);
    }

    return this;
  }

  orWhereMonth<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  orWhereMonth<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  orWhereMonth(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.orWhereMonth(column, args[0], args[1]);
    } else {
      this.query.orWhereMonth(column, args[0]);
    }

    return this;
  }

  whereYear<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  whereYear<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  whereYear(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.whereYear(column, args[0], args[1]);
    } else {
      this.query.whereYear(column, args[0]);
    }

    return this;
  }

  orWhereYear<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: string | number | Date | DateTime,
  ): this;
  orWhereYear<K extends keyof TRow & string>(
    column: K,
    value: string | number | Date | DateTime,
  ): this;
  orWhereYear(column: string, ...args: DateWhereArgs<string | number | Date | DateTime>): this {
    if (args.length === 2) {
      this.query.orWhereYear(column, args[0], args[1]);
    } else {
      this.query.orWhereYear(column, args[0]);
    }

    return this;
  }

  whereJsonContains(column: keyof TRow & string, value: Bindable): this {
    this.query.whereJsonContains(column, value);

    return this;
  }

  orWhereJsonContains(column: keyof TRow & string, value: Bindable): this {
    this.query.orWhereJsonContains(column, value);

    return this;
  }

  whereJsonDoesntContain(column: keyof TRow & string, value: Bindable): this {
    this.query.whereJsonDoesntContain(column, value);

    return this;
  }

  orWhereJsonDoesntContain(column: keyof TRow & string, value: Bindable): this {
    this.query.orWhereJsonDoesntContain(column, value);

    return this;
  }

  whereJsonContainsKey(column: keyof TRow & string): this {
    this.query.whereJsonContainsKey(column);

    return this;
  }

  orWhereJsonContainsKey(column: keyof TRow & string): this {
    this.query.orWhereJsonContainsKey(column);

    return this;
  }

  whereJsonDoesntContainKey(column: keyof TRow & string): this {
    this.query.whereJsonDoesntContainKey(column);

    return this;
  }

  orWhereJsonDoesntContainKey(column: keyof TRow & string): this {
    this.query.orWhereJsonDoesntContainKey(column);

    return this;
  }

  whereJsonLength<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: number,
  ): this;
  whereJsonLength<K extends keyof TRow & string>(column: K, value: number): this;
  whereJsonLength(column: string, ...args: JsonLengthArgs): this {
    if (args.length === 2) {
      this.query.whereJsonLength(column, args[0], args[1]);
    } else {
      this.query.whereJsonLength(column, args[0]);
    }

    return this;
  }

  orWhereJsonLength<K extends keyof TRow & string>(
    column: K,
    operator: WhereOperator,
    value: number,
  ): this;
  orWhereJsonLength<K extends keyof TRow & string>(column: K, value: number): this;
  orWhereJsonLength(column: string, ...args: JsonLengthArgs): this {
    if (args.length === 2) {
      this.query.orWhereJsonLength(column, args[0], args[1]);
    } else {
      this.query.orWhereJsonLength(column, args[0]);
    }

    return this;
  }

  orderBy<K extends keyof TRow & string>(column: K, direction: "asc" | "desc" = "asc"): this {
    this.query.orderBy(column, direction);

    return this;
  }

  orderByDesc<K extends keyof TRow & string>(column: K): this {
    this.query.orderByDesc(column);

    return this;
  }

  latest<K extends keyof TRow & string>(
    column: K | "created_at" = "created_at" as K | "created_at",
  ): this {
    this.query.latest(column);

    return this;
  }

  oldest<K extends keyof TRow & string>(
    column: K | "created_at" = "created_at" as K | "created_at",
  ): this {
    this.query.oldest(column);

    return this;
  }

  /** Appends a raw `ORDER BY` fragment, escape hatch for expressions `orderBy()` can't express. */
  orderByRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.query.orderByRaw(sqlText, bindings);

    return this;
  }

  /** Orders by `RANDOM()` (SQLite), matches Laravel's `inRandomOrder()`. */
  inRandomOrder(): this {
    this.query.inRandomOrder();

    return this;
  }

  /** Clears every accumulated ordering, optionally replacing it with a single new `orderBy(column, direction)`, matches Laravel's `reorder()`. */
  reorder<K extends keyof TRow & string>(column?: K, direction: "asc" | "desc" = "asc"): this {
    this.query.reorder(column, direction);

    return this;
  }

  reorderDesc<K extends keyof TRow & string>(column: K): this {
    this.query.reorderDesc(column);

    return this;
  }

  distinct(): this {
    this.query.distinct();

    return this;
  }

  /** `GROUP BY column(s)`. See `QueryBuilder.groupBy()`. */
  groupBy<K extends keyof TRow & string>(...columns: K[]): this {
    this.query.groupBy(...columns);

    return this;
  }

  groupByRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.query.groupByRaw(sqlText, bindings);

    return this;
  }

  having(column: string, operator: WhereOperator, value: Bindable): this;
  having(column: string, value: Bindable): this;
  having(column: string, ...args: [WhereOperator, Bindable] | [Bindable]): this {
    if (args.length === 2) {
      this.query.having(column, args[0], args[1]);
    } else {
      this.query.having(column, args[0]);
    }

    return this;
  }

  orHaving(column: string, operator: WhereOperator, value: Bindable): this;
  orHaving(column: string, value: Bindable): this;
  orHaving(column: string, ...args: [WhereOperator, Bindable] | [Bindable]): this {
    if (args.length === 2) {
      this.query.orHaving(column, args[0], args[1]);
    } else {
      this.query.orHaving(column, args[0]);
    }

    return this;
  }

  havingRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.query.havingRaw(sqlText, bindings);

    return this;
  }

  orHavingRaw(sqlText: string, bindings: Bindable[] = []): this {
    this.query.orHavingRaw(sqlText, bindings);

    return this;
  }

  /**
   * Appends a raw, aliased SQL expression to the row's column set,
   * widening this builder's row type to `TRow & TExtra` from this call
   * onward. See `QueryBuilder.selectRaw()`'s docstring for the full
   * rationale and an example.
   *
   * `TInstance` is widened alongside `TRow`. The extra column is present
   * on the hydrated instance at runtime (`hydrate()` copies whatever the
   * row carries), so leaving the instance type alone made the selected
   * column unreachable on the result. `rows.first()?.doubled_views`
   * would not compile despite being populated.
   */
  selectRaw<TExtra extends Record<string, any>>(
    sqlText: string,
    bindings: Bindable[] = [],
  ): EloquentBuilder<TRow & TExtra, TRelations, TCasts, TInstance & TExtra> {
    this.query = this.query.selectRaw<TExtra>(sqlText, bindings) as QueryBuilder<TRow>;

    return this as EloquentBuilder<TRow & TExtra, TRelations, TCasts, TInstance & TExtra>;
  }

  /**
   * Adds an `INNER JOIN`, widening the row type to `TRow & TJoined`.
   * See `QueryBuilder.join()` for the full rationale and the `on`-callback
   * form. `TJoined` is explicit, never inferred.
   *
   *   const posts = await Post.query()
   *     .join<{ author_name: string }>("users", "posts.user_id", "users.id")
   *     .select("posts.*", "users.name as author_name")
   *     .get();
   *
   * Rows are still hydrated into THIS model's instances, the joined
   * columns land as ordinary attributes on the instance, not a nested
   * object. For a relation you want as a real instance, use `with()`.
   */
  join<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    first: string,
    second: string,
  ): EloquentBuilder<TRow & TJoined, TRelations, TCasts, TInstance & TJoined>;
  join<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    on: (join: JoinClause) => void,
  ): EloquentBuilder<TRow & TJoined, TRelations, TCasts, TInstance & TJoined>;
  join<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    firstOrOn: string | ((join: JoinClause) => void),
    second?: string,
  ): EloquentBuilder<TRow & TJoined, TRelations, TCasts, TInstance & TJoined> {
    (this.query as any).join(table, firstOrOn as any, second as any);

    return this as unknown as EloquentBuilder<
      TRow & TJoined,
      TRelations,
      TCasts,
      TInstance & TJoined
    >;
  }

  /** Adds a `LEFT JOIN`, widening with `Partial<TJoined>` (unmatched rows null the joined columns). See `QueryBuilder.leftJoin()`. */
  leftJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    first: string,
    second: string,
  ): EloquentBuilder<TRow & Partial<TJoined>, TRelations, TCasts, TInstance & Partial<TJoined>>;
  leftJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    on: (join: JoinClause) => void,
  ): EloquentBuilder<TRow & Partial<TJoined>, TRelations, TCasts, TInstance & Partial<TJoined>>;
  leftJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
    firstOrOn: string | ((join: JoinClause) => void),
    second?: string,
  ): EloquentBuilder<TRow & Partial<TJoined>, TRelations, TCasts, TInstance & Partial<TJoined>> {
    (this.query as any).leftJoin(table, firstOrOn as any, second as any);

    return this as unknown as EloquentBuilder<
      TRow & Partial<TJoined>,
      TRelations,
      TCasts,
      TInstance & Partial<TJoined>
    >;
  }

  /** Adds a `CROSS JOIN`. See `QueryBuilder.crossJoin()`. */
  crossJoin<TJoined extends Record<string, any> = Record<string, any>>(
    table: string,
  ): EloquentBuilder<TRow & TJoined, TRelations, TCasts, TInstance & TJoined> {
    this.query.crossJoin(table);

    return this as unknown as EloquentBuilder<
      TRow & TJoined,
      TRelations,
      TCasts,
      TInstance & TJoined
    >;
  }

  /** Appends another query's rows to this one's, deduplicated. See `QueryBuilder.union()`. */
  union(subquery: Subquery): this {
    this.query.union(subquery);

    return this;
  }

  /** `union()` keeping duplicates. See `QueryBuilder.unionAll()`. */
  unionAll(subquery: Subquery): this {
    this.query.unionAll(subquery);

    return this;
  }

  /** Restricts the projected column set, Laravel's `select()`. Needed on a joined query to disambiguate duplicate column names. */
  select(...columns: string[]): this {
    this.query.select(...columns);

    return this;
  }

  limit(n: number): this {
    this.query.limit(n);

    return this;
  }

  /** Alias for `limit()`. */
  take(n: number): this {
    return this.limit(n);
  }

  offset(n: number): this {
    this.query.offset(n);

    return this;
  }

  /** Alias for `offset()`. */
  skip(n: number): this {
    return this.offset(n);
  }

  /** See `QueryBuilder.lock()`'s docstring, a documented no-op on SQLite. */
  lock(value: boolean | string = true): this {
    this.query.lock(value);

    return this;
  }

  lockForUpdate(): this {
    this.query.lockForUpdate();

    return this;
  }

  sharedLock(): this {
    this.query.sharedLock();

    return this;
  }

  async get(): Promise<Collection<TInstance>> {
    const rows: Record<string, any>[] = await this.query.get();
    const instances = rows.map((row) => this.model.hydrate(row));

    for (const instance of instances) {
      await this.model.fireRetrieved(instance);
    }

    if (this.eagerLoad.size > 0) {
      await loadRelations(this.model, instances, this.eagerLoad);
    }

    return Collection.make(instances as unknown as TInstance[]);
  }

  async first(): Promise<TInstance | undefined> {
    const row = await this.query.first();

    if (row === undefined) {
      return undefined;
    }

    const instance = this.model.hydrate(row);
    await this.model.fireRetrieved(instance);

    if (this.eagerLoad.size > 0) {
      await loadRelations(this.model, [instance], this.eagerLoad);
    }

    return instance as unknown as TInstance;
  }

  /** Like `first()`, but throws `ModelNotFoundError` when no row matches. */
  async firstOrFail(): Promise<TInstance> {
    const instance = await this.first();

    if (instance === undefined) {
      throw new ModelNotFoundError(this.model.name, undefined);
    }

    return instance;
  }

  /**
   * Processes matching rows in offset-based pages of `size`, Laravel's
   * `chunk()`. Each page's rows are hydrated into model instances (and
   * fire `retrieved`) before `callback` sees them. Eager `with()`
   * relations are NOT loaded per page (chunking is for large batch
   * processing, not display), call `load()`/`with()` yourself if needed.
   * Return `false` to stop early.
   */
  async chunk(
    size: number,
    callback: (rows: TRow[]) => void | boolean | Promise<void | boolean>,
  ): Promise<void> {
    return this.query.chunk(size, async (rows) => {
      const instances = rows.map((row) => this.model.hydrate(row));

      for (const instance of instances) {
        await this.model.fireRetrieved(instance);
      }

      return callback(instances as unknown as TRow[]);
    });
  }

  /** Calls `callback` once per matching row (hydrated), paged behind the scenes, Laravel's `each()`. Return `false` to stop early. */
  async each(
    callback: (row: TRow, index: number) => void | boolean | Promise<void | boolean>,
    size = 1000,
  ): Promise<void> {
    let index = 0;
    await this.chunk(size, async (rows) => {
      for (const row of rows) {
        const result = await callback(row, index++);

        if (result === false) {
          return false;
        }
      }

      return true;
    });
  }

  /** Async generator yielding matching rows one at a time (paged), hydrated into instances, Laravel's `lazy()`. */
  async *lazy(size = 1000): AsyncGenerator<TRow, void, unknown> {
    for await (const row of this.query.lazy(size)) {
      const instance = this.model.hydrate(row);
      await this.model.fireRetrieved(instance);
      yield instance as unknown as TRow;
    }
  }

  /** Alias for `lazy()`, Laravel's `cursor()`. See `QueryBuilder.cursor()`. */
  cursor(size = 1000): AsyncGenerator<TRow, void, unknown> {
    return this.lazy(size);
  }

  /** Counts rows matching this builder's `where()` conditions, ignoring `orderBy`/`limit`/`offset`. */
  async count(): Promise<number> {
    return this.query.count();
  }

  async exists(): Promise<boolean> {
    return this.query.exists();
  }

  async doesntExist(): Promise<boolean> {
    return this.query.doesntExist();
  }

  min(column: keyof TRow & string): Promise<number | null> {
    return this.query.min(column);
  }

  max(column: keyof TRow & string): Promise<number | null> {
    return this.query.max(column);
  }

  sum(column: keyof TRow & string): Promise<number | null> {
    return this.query.sum(column);
  }

  avg(column: keyof TRow & string): Promise<number | null> {
    return this.query.avg(column);
  }

  /** `GROUP BY column` + `COUNT(*)` over this builder's `where()` conditions. See `QueryBuilder.countBy()`. */
  countBy<K extends keyof TRow & string>(column: K): Promise<Map<TRow[K], number>> {
    return this.query.countBy(column);
  }

  async insert(values: Partial<TRow>): Promise<Partial<TRow>> {
    return this.query.insert(this.castWrite(values));
  }

  /**
   * Updates every matching row, stamping `updatedAtColumn` unless the
   * caller supplied it, Laravel's `Builder::update()`, which does the
   * same. A model with `timestamps = true` that could be updated
   * *without* touching `updated_at` just by going through the builder
   * would make the column silently unreliable, which is worse than not
   * having it.
   *
   * Set `timestamps = false` on the model, or pass the column
   * explicitly, to opt out.
   */
  async update(values: Partial<TRow>): Promise<number> {
    return this.query.update(this.castWrite(this.withUpdatedTimestamp(values)));
  }

  /** Adds `updatedAtColumn` to a write payload when the model stamps timestamps and the caller hasn't set it. */
  private withUpdatedTimestamp(values: Partial<TRow>): Partial<TRow> {
    const column = this.model.updatedAtColumn;

    if (!this.model.timestamps || column === null) {
      return values;
    }

    if ((values as Record<string, any>)[column] !== undefined) {
      return values;
    }

    return { ...values, [column]: this.model.currentTimestamp() } as Partial<TRow>;
  }

  /**
   * Deletes every matching row, **soft-deleting** when the model
   * declares soft deletes, exactly as the static `Model.delete()` does.
   *
   * This is Laravel's `SoftDeletingScope::extend()` behaviour: a builder
   * delete on a soft-deleting model compiles to `UPDATE ... SET
   * deleted_at = now()`, not `DELETE FROM`. Without it,
   * `Post.query().where(...).delete()` hard-deletes rows the model's
   * whole contract says are recoverable, silent, unrecoverable data
   * loss, and the failure mode is invisible until someone tries to
   * restore.
   *
   * Use `forceDelete()` for a real `DELETE` on a soft-deleting model.
   */
  async delete(): Promise<number> {
    const scope = findSoftDeleteScope(this.model.scopes);

    if (!scope) {
      return this.query.delete();
    }

    return this.update({
      [scope.deletedAtColumn]: this.model.currentTimestamp(),
    } as Partial<TRow>);
  }

  /**
   * A real `DELETE FROM`, even on a soft-deleting model, Laravel's
   * `forceDelete()`. Identical to `delete()` for a model without soft
   * deletes, so it is also the honest spelling for framework-internal
   * paths that mean "remove the row" regardless of the model's policy.
   */
  async forceDelete(): Promise<number> {
    return this.query.delete();
  }

  /**
   * Clears `deleted_at` on every matching row, Laravel's `restore()`.
   * Pair with `onlyTrashed()`/`withTrashed()`, since the default scope
   * hides exactly the rows this is meant to act on:
   *
   *   await Post.onlyTrashed().where("author_id", id).restore();
   *
   * Throws on a model that doesn't soft-delete rather than quietly
   * writing a `deleted_at` column that doesn't exist.
   */
  async restore(): Promise<number> {
    const scope = findSoftDeleteScope(this.model.scopes);

    if (!scope) {
      throw new Error(
        `restore(): ${this.model.name} does not use soft deletes — there is no deleted_at column to clear.`,
      );
    }

    return this.update({ [scope.deletedAtColumn]: null } as Partial<TRow>);
  }

  updateOrInsert(attributes: Partial<TRow>, values: Partial<TRow> = {}): Promise<boolean> {
    // `attributes` is both a match condition and part of the inserted row,
    // so it casts the same way either role it ends up playing.
    return this.query.updateOrInsert(this.castWrite(attributes), this.castWrite(values));
  }

  upsert(
    values: Partial<TRow>[],
    uniqueBy: (keyof TRow & string) | (keyof TRow & string)[],
    update?: (keyof TRow & string)[],
  ): Promise<number> {
    return this.query.upsert(
      values.map((row) => this.castWrite(row)),
      uniqueBy,
      update,
    );
  }

  increment(column: keyof TRow & string, amount = 1, extra: Partial<TRow> = {}): Promise<number> {
    // `column`/`amount` are a numeric SQL expression (`col = col + n`),
    // not a binding to cast; `extra` is an ordinary write payload.
    return this.query.increment(column, amount, this.castWrite(extra));
  }

  incrementEach(
    columns: Partial<Record<keyof TRow & string, number>>,
    extra: Partial<TRow> = {},
  ): Promise<number> {
    return this.query.incrementEach(columns, this.castWrite(extra));
  }

  decrement(column: keyof TRow & string, amount = 1, extra: Partial<TRow> = {}): Promise<number> {
    return this.query.decrement(column, amount, this.castWrite(extra));
  }

  decrementEach(
    columns: Partial<Record<keyof TRow & string, number>>,
    extra: Partial<TRow> = {},
  ): Promise<number> {
    return this.query.decrementEach(columns, this.castWrite(extra));
  }

  /** Escape hatch, the underlying `QueryBuilder`, for anything this class doesn't cover. */
  toBase(): QueryBuilder<TRow> {
    return this.query;
  }

  /** The compiled SELECT SQL for this builder's current state. See `QueryBuilder.toSql()`. */
  toSql(): string {
    return this.query.toSql();
  }

  /** The compiled SELECT SQL with bound values inlined, for debugging only. See `QueryBuilder.toRawSql()`. */
  toRawSql(): string {
    return this.query.toRawSql();
  }

  /** The positional bound values for this builder's current SELECT state. See `QueryBuilder.getBindings()`. */
  getBindings(): readonly SqlBinding[] {
    return this.query.getBindings();
  }

  /**
   * Returns a new `EloquentBuilder` with the same accumulated `where`/
   * `order`/`limit`/`offset`/`distinct`/`lock`/eager-load state. See
   * `QueryBuilder.clone()`'s docstring for the "why".
   */
  clone(): EloquentBuilder<TRow, TRelations, TCasts, TInstance> {
    const cloned = this.newInstance() as unknown as EloquentBuilder<
      TRow,
      TRelations,
      TCasts,
      TInstance
    >;
    (cloned as any).query = this.query.clone();
    (cloned as any).eagerLoad = cloneTree(this.eagerLoad);

    return cloned;
  }

  /**
   * Conditionally apply a callback, Laravel's `Conditionable::when()`.
   * Receives `this` (the Eloquent builder) so the callback can call
   * model-aware methods (`with()`, scopes, ...), not just query-builder
   * ones. See `QueryBuilder.when()` for the full contract.
   */
  // Closure-condition overload first. See the note on `QueryBuilder.when()`.
  when<TValue, TReturn = this>(
    value: (builder: this) => TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  when<TValue, TReturn = this>(
    value: TValue extends (...args: never) => infer _R ? never : TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  when<TValue, TReturn = this>(
    value: TValue | ((builder: this) => TValue),
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn {
    return applyWhen(this, value, callback, defaultCb, false);
  }

  // Closure-condition overload first. See the note on `QueryBuilder.when()`.
  unless<TValue, TReturn = this>(
    value: (builder: this) => TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  unless<TValue, TReturn = this>(
    value: TValue extends (...args: never) => infer _R ? never : TValue,
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn;
  unless<TValue, TReturn = this>(
    value: TValue | ((builder: this) => TValue),
    callback: (builder: this, value: TValue) => TReturn | void,
    defaultCb?: (builder: this, value: TValue) => TReturn | void,
  ): this | TReturn {
    return applyWhen(this, value, callback, defaultCb, true);
  }
}
