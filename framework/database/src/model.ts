import type { Kysely } from "kysely";
import { Collection, app } from "@mahiframework/core";
import { AbstractEvent } from "@mahiframework/events";
import { EloquentBuilder } from "./eloquent-builder.js";
import type { Cast } from "./casts.js";
import type { DateTime } from "@mahiframework/datetime";
import { DateTimeCast as DateTimeCastValue } from "./casts.js";
import type {
  BuilderMarkerOf,
  ColumnKeys,
  Computed,
  ComputedKeys,
  HasAttributes,
  KindOf,
  LoadedValueOf,
  RelationKeys,
  RelatedOf,
  ResolvedAttributes,
} from "./markers.js";
import type { AccessorDefinition, AccessorMap } from "./accessors.js";
import type { KeyStrategy, ResolvedKeyType } from "./key-strategy.js";
import { resolveKeyType } from "./key-strategy.js";
import type { Relationships } from "./relations.js";
import type { QueryBuilder, SqlBinding } from "./query-builder.js";
import { UniqueConstraintViolationException } from "./exceptions.js";
import { getActiveTransaction } from "./transaction-context.js";
import { currentTimestampFor, prepareTemporalWrites } from "./timestamps.js";
import { dialectOf } from "./drivers/dialect-registry.js";
import { DateTimeCast } from "./casts.js";
import { DATABASE_TOKEN } from "./database-service-provider.js";
import type { DatabaseManager } from "./database-manager.js";
import type { GlobalScope } from "./global-scope.js";
import {
  findSoftDeleteScope,
  ConfigSoftDeleteScope,
  type SoftDeleteScopeLike,
} from "./soft-delete-support.js";
import type { Factory } from "./factory.js";
import type {
  BelongsToManyOptions,
  BelongsToOptions,
  HasManyOptions,
  HasManyThroughOptions,
  HasOneOptions,
  HasOneThroughOptions,
  MorphedByManyOptions,
  MorphManyOptions,
  MorphOneOptions,
  MorphToManyOptions,
  MorphToOptions,
  RelationDefinition,
  RelationDefinitions,
} from "./relations.js";
import { paginate, type LengthAwarePaginationResult } from "./pagination/length-aware-paginator.js";
import { simplePaginate, type SimplePaginationResult } from "./pagination/simple-paginator.js";
import {
  cursorPaginate,
  type CursorPaginateOptions,
  type CursorPaginationResult,
} from "./pagination/cursor-paginator.js";
import {
  dispatchModelEvent,
  hasModelListeners,
  registerModelListener,
  registerObserver,
  type DispatchesEventsMap,
  type ModelEventListener,
  type ModelEventName,
  type ModelEventPayload,
  type ModelObserverClass,
} from "./model-events.js";
import { loadRelations } from "./eager-loading.js";
import { isConstraintMap, type EagerLoadRequest } from "./eager-load-tree.js";
import { ClassMorphViolationError, Relation } from "./morph-map.js";
import { MorphToBuilder } from "./morph-to-builder.js";
import { PIVOT_PREFIX, pivotColumns, pivotSelections } from "./pivot.js";
import { attachRelationWrites, type RelationWritesFor } from "./relationship-writes.js";

/** Classes whose `bootIfNotBooted()` has already completed in this isolate. */
const bootedModels = new WeakSet<object>();

/**
 * Per-instance Active Record state. Kept in a module-level `WeakMap`
 * keyed by BOTH the underlying target object and its wrapping `Proxy`
 * (both entries point at the same record) rather than in `#private`
 * fields, because a class method invoked through the proxy would trip
 * the "cannot read private member from an object whose class did not
 * declare it" error when the receiver is the proxy, not the target. The
 * WeakMap sidesteps that entirely while keeping the state truly private
 * (no enumerable instance property the proxy's `ownKeys` trap would leak).
 */
interface InstanceState {
  /** DB-shape attribute values (post-cast-out). */
  attributes: Record<string, any>;
  /** Dirty-tracking snapshot as of the last DB sync. */
  original: Record<string, any>;
  /**
   * DB-shape attributes written by the LAST successful `save()`, the
   * **post**-save counterpart to `original`'s pre-save window. Populated
   * by `syncChanges()` (which must run BEFORE `syncOriginal()`, while
   * `getDirty()` can still see the difference) and read by
   * `getChanges()`/`wasChanged()`. Empty after an INSERT, matching
   * Laravel. See `getChanges()`.
   */
  changes: Record<string, any>;
  /** Whether the last `save()` on this instance was an INSERT. See `Model.wasRecentlyCreated`. */
  wasRecentlyCreated: boolean;
  /** Loaded relations by name. */
  relations: Map<string, unknown>;
  /** Appended (non-column) values by name. See `Model.append()`/`setAppended()`. */
  computed: Map<string, unknown>;
  /** Whether a corresponding DB row exists. */
  exists: boolean;
  /** The Proxy wrapping the target, the value returned from methods and used as the event payload. */
  self: Model;
  /** Lazily-built `relations` namespace (query-side accessors). See `Model.relations` getter. `morphTo` contributes a `MorphToBuilder`, every other type an `EloquentBuilder`. */
  relationBuilders?: Record<
    string,
    () => EloquentBuilder<Record<string, any>> | MorphToBuilder<Model>
  >;
}

const instanceState = new WeakMap<object, InstanceState>();

/**
 * The minimal structural contract a `Model`'s default resource satisfies,
 * declared here (rather than importing `Resource` from `@mahiframework/http`)
 * so `@mahiframework/database` keeps no dependency on the HTTP layer. The
 * real `Resource` (in `@mahiframework/http`) is structurally assignable to
 * this. Returned by `Model.toJsonResource()`; consumed by `Resource`'s
 * output normalization.
 */
export interface ModelResource {
  toJson(): unknown | Promise<unknown>;
}

export class ModelNotFoundError extends Error {
  constructor(modelName: string, id: SqlBinding | undefined) {
    super(`No query results for model "${modelName}" with id "${String(id)}".`);
    this.name = "ModelNotFoundError";
  }
}

/**
 * Thrown when `strictRelations` is on and a **declared** relation is read
 * off an instance that never loaded it, Laravel's
 * `LazyLoadingViolationException`, the N+1 tripwire.
 *
 * Without it the read silently yields `undefined`, which is
 * indistinguishable from "loaded, and genuinely empty" and is the shape
 * an N+1 usually hides behind. The fix at the call site is always one of
 * three things, named in the message: eager load it (`with()`), lazily
 * load it (`load()`/`loadMissing()`), or query it explicitly through the
 * `relations` namespace.
 */
export class RelationNotLoadedError extends Error {
  constructor(modelName: string, relation: string) {
    super(
      `Relation "${relation}" was never loaded on "${modelName}" and \`strictRelations\` is enabled. ` +
        `Eager load it with \`.with("${relation}")\`, lazily load it with \`await instance.load("${relation}")\`, ` +
        `or query it directly with \`instance.relations.${relation}()\`.`,
    );
    this.name = "RelationNotLoadedError";
  }
}

/**
 * Thrown when a mass-assignment (`create()`/`fill()`/`new Model({...})`)
 * tries to set a non-fillable attribute on a **totally guarded** model,
 * one that declares neither `fillable` nor a relaxed `guarded` (i.e.
 * `fillable = []` and `guarded = ["*"]`). Mirrors Laravel's
 * `MassAssignmentException`. A model left at the framework default
 * (`guarded = []`) is never totally guarded, so this never fires unless a
 * model opts into the stricter posture. See `Model.fillable`/`guarded`.
 */
export class MassAssignmentError extends Error {
  constructor(modelName: string, key: string) {
    super(`Add [${key}] to the "fillable" property to allow mass assignment on "${modelName}".`);
    this.name = "MassAssignmentError";
  }
}

/**
 * Eloquent-style Active Record base class. Reads return hydrated `Model`
 * INSTANCES (`Todo.find(id): Promise<Todo | undefined>`, not a plain
 * `TodoTable` object), attribute access goes through a per-instance
 * `Proxy` (so casts apply transparently), and instances carry
 * change tracking in both directions, pre-save (`getDirty()`/
 * `isDirty()`/`getOriginal()`/`discardChanges()`) and post-save
 * (`getChanges()`/`wasChanged()`/`wasRecentlyCreated`), plus
 * `save()`/`refresh()`/`replicate()`. Typed attributes ride on the
 * instance via a per-model `interface Todo extends TodoTable {}`
 * declaration-merge. Both the static shortcuts
 * (`Todo.create/update/delete`) and the instance methods (`todo.save()`)
 * run through the same lifecycle (timestamps, generated-id read-back,
 * events).
 *
 * Access is **static** for queries: `Todo.all()`, `Todo.find(id)`,
 * `Todo.query()...`, not `new Todo(db).all()`. The connection is
 * resolved internally via the global `app()` container lookup
 * (`@mahiframework/core`), the one deliberate piece of "magic" this
 * framework allows for `Model` access (the "no magic" rule targets
 * hidden dispatch like magic `whereName()` methods, not a single
 * documented static-resolution point). `app.bootstrap()` must have run
 * before any static `Model` method is called.
 * A model resolves the default `DatabaseManager` driver unless it sets
 * `connection: "name"` in its config, in which case every read, write,
 * timestamp and transaction lookup it performs goes through that named
 * connection instead. See `resolveConnection()`.
 *
 *   interface TodoTable { id: string; title: string; done: number }
 *
 *   class Todo extends Model {
 *     static override table = "todos";
 *     declare static Row: TodoTable;
 *   }
 *   interface Todo extends TodoTable {}          // typed instance attributes
 *
 *   const todo = await Todo.find(id);           // Todo | undefined (instance)
 *   const todos = await Todo.all();              // Collection<Todo>
 *   const created = await Todo.create({ id, title, done: 0 }); // Todo instance
 *
 *   // anything beyond find/all/create/update/delete: use query()
 *   await Todo.query().where("done", 0).orderBy("created_at", "desc").get();
 *
 * Static calls made inside a `transaction()` callback automatically
 * participate in that transaction, `resolveConnection()` below checks
 * the active AsyncLocalStorage transaction context
 * (`transaction-context.ts`) before falling back to the default driver
 * connection, so no call site changes.
 *
 * `static query()` is the single override point for a custom builder:
 * every other read entry point routes through it, and the override's
 * return type IS the narrowing. `newEloquentBuilder()` is the
 * lower-level *construction* hook the nested-`where()` group builder and
 * the relation helpers call; overriding it alone will NOT change what
 * `query()` returns.
 *
 * `factory()` is overridden the same way, and throws if it hasn't been,
 * unlike `query()`, a factory's `definition()` is inherently
 * model-specific, so there is no sensible default to fall back to. Note
 * the model -> factory -> model import cycle an override creates. It is
 * safe in both import orders because neither side touches the other
 * during module evaluation: the factory is referenced only inside
 * `factory()`'s body (call time), and `protected model` is an instance
 * field initializer (construction time). Assigning the factory to a
 * STATIC field instead (`static Factory = PostFactory`) would NOT be
 * safe, static field initializers run at class-definition time and hit
 * a TDZ `ReferenceError` when the factory module is the entry into the
 * cycle.
 *
 * There is no mixin system. Soft deletes and key generation are
 * configuration on the `Model<A>()(config)` factory; behaviour of your
 * own is ordinary subclassing, and the finders are this-polymorphic, so
 * a subclass's finders still return the subclass. Override
 * `static boot()` for one-time per-class setup; it runs after the
 * factory's own boot hooks, so you do not call `super.boot()`.
 *
 * Relations are declared once in a `static relationships` map and
 * consumed two ways off a live instance, mirroring Laravel's
 * `$post->comments()` (query) vs `$post->comments` (loaded value):
 * `post.relations.comments()` is the related model's own builder scoped
 * to this row, and `post.comments` is the loaded result populated by
 * `with()`/`load()`/`loadMissing()`. The same namespace writes,
 * `attach()`/`detach()`/`sync()`/`toggle()` on a pivot relation,
 * `associate()`/`dissociate()` on a `belongsTo`/`morphTo`, and
 * `save()`/`create()` through a `hasMany`/`morphMany`, with each
 * accessor carrying only the methods its relation kind supports.
 *
 * Two deliberate non-goals there. **No key-name guessing:** every
 * foreign key is named explicitly in the options object; only
 * `localKey`/`ownerKey`/`relatedKey` default, and only ever to the
 * relevant model's `primaryKeyColumn`. **No writes through
 * `hasOneThrough`/`hasManyThrough`:** that would mean inventing the
 * intermediate row, and there is no single correct guess.
 *
 * See `docs/models/README.md` and `docs/relationships/README.md` for the
 * full guides.
 */
export abstract class BaseModel {
  /** The table name, set by the `Model<A>()(config)` factory from `config.table`. */
  static table: string;

  /**
   * The primary-key column used by `find()`/`whereKey()`, Laravel's
   * `$primaryKey`. Set by the factory from `config.primaryKey` (default
   * `"id"`). `primaryKeyColumn` is a permanent internal alias so the
   * builder / eager loader / morph modules keep one spelling.
   */
  static primaryKey = "id";

  /** Internal alias for `primaryKey`, read by the builder, eager loader, morph-to builder, and relation helpers. */
  static get primaryKeyColumn(): string {
    return this.primaryKey;
  }

  /**
   * The resolved key strategy (`incrementing` + optional client-side
   * `generate`) derived from `config.keyType`. Installed by the factory;
   * defaults to DB-generated increment on the base class.
   */
  static keyStrategy: ResolvedKeyType = { incrementing: true };

  /**
   * The named `DatabaseManager` connection this model reads and writes
   * through (`config.connection`), Laravel's `$connection`. `undefined`
   * (the default) means the manager's default driver.
   *
   *   class Event extends Model<EventAttributes>()({
   *     table: "events",
   *     connection: "analytics",   // never touches the primary DB
   *   }) {}
   *
   * Read by `resolveConnection()` and `rootConnection()`, which every
   * query, timestamp and transaction lookup on this model funnels
   * through, so a transaction opened on a *different* connection
   * correctly does not capture this model's writes.
   */
  static connection: string | undefined = undefined;

  /** The declared attribute casts, set by the factory from `config.casts`, merged with implicit timestamp/datetime casts. */
  static casts: Record<string, Cast<any, any>> = {};

  /** Computed-attribute definitions, the subclass's `static accessors` map. */
  static accessors: AccessorMap<any> = {};

  /** Computed attributes included in `toJSON()`, set by the factory from `config.appends`. */
  static appends: string[] = [];

  /**
   * The default route parameter name for explicit route-model binding
   * (`request.model(Post)` reads `{post}`) and the segment name a URL
   * generator substitutes for this model. Derived from `morphName` when
   * set (so `static morphName = "Post"` → `"post"`), otherwise the JS
   * class name lowercased. Override for an irregular binding name.
   *
   *   Post.routeParamName();   // "post"  → route "/posts/{post}"
   */
  static routeParamName(): string {
    return (this.morphName ?? this.name).toLowerCase();
  }

  /**
   * Stable, deploy-durable name used to (de)serialize a model reference
   * inside a queued job's payload, the morph key written to disk as
   * `{ __model, __id }` and looked up in the `ModelRegistry` to rehydrate
   * `Class.findOrFail(id)` before the job's `handle()` runs. Deliberately
   * decoupled from `table` (renaming a table must not break in-flight
   * jobs) and from the JS class name (survives minification/renames).
   *
   * `undefined` by default, a model with no `morphName` cannot appear in
   * a job payload (the codec throws at dispatch, loudly, rather than
   * silently persisting a full attribute dump). Opt in per model:
   *
   *   class User extends Model<UserAttributes>()({
   *     table: "users",
   *     morphName: "User",
   *   }) {}
   *
   * Treat values as append-only, like an enum member, changing an
   * existing `morphName` invalidates any job already enqueued against it.
   */
  static morphName: string | undefined = undefined;

  /**
   * The discriminant value this model is stored as in a polymorphic
   * column (`commentable_type`, `notifiable_type`, ...), Laravel's
   * `getMorphClass()`. Resolves in three steps, first match winning:
   *
   *   1. a `Relation.morphMap()` entry for this class
   *   2. `static morphName`
   *   3. `static table`
   *
   *   Post.morphAlias();   // "post" if mapped, else morphName, else "posts"
   *
   * Always resolves, rung 3 can't fail, so a model needs no extra
   * declaration to participate in a polymorphic relation. That changes
   * under `Relation.requireMorphMap()`, which disables rungs 2 and 3 and
   * makes an unmapped model throw `ClassMorphViolationError`.
   *
   * The chain exists because there's no equivalent of Laravel's
   * `static::class` fallback here. `morphName` is unique by construction
   * (`ModelRegistry` throws on collision) but opt-in; `table` always
   * exists but two models can share one. Register a morph map if you
   * need the stored values pinned independently of both. See
   * `morph-map.ts`.
   */
  static morphAlias(this: typeof BaseModel): string {
    const mapped = Relation.getMorphAlias(this);

    if (mapped !== undefined) {
      return mapped;
    }

    if (Relation.requiresMorphMap()) {
      throw new ClassMorphViolationError(this.name);
    }

    return this.morphName ?? this.table;
  }

  /**
   * When a model reference in a job payload no longer resolves to a row
   * at run time (the row was deleted between dispatch and execution),
   * controls what the queue does:
   *
   *   - `false` (default): rehydration throws `ModelNotFoundError`, so the
   *     job fails/retries like any other error, the safe default, since a
   *     missing row is usually a genuine bug (e.g. a dangling FK).
   *   - `true`: the job is silently, successfully removed from the queue
   *     without ever calling `handle()`, Laravel's `deleteWhenMissingModels`
   *     behavior, for jobs where "the subject is gone, so there's nothing
   *     to do" is the correct outcome (e.g. "send welcome email to user"
   *     when the user has since been deleted).
   *
   * Applies to any missing model referenced by the payload; if ANY
   * referenced model is missing and this is `true`, the whole job is
   * skipped.
   */
  static deleteWhenMissingModels = false;

  /**
   * Global scopes applied automatically to every `query()` call. See the
   * class docstring's "Global scopes" section. Empty by default, so a
   * model with no declared scopes produces the exact same query as
   * calling `queryWithoutScopes()`.
   */
  static scopes: GlobalScope[] = [];

  /**
   * Per-class hooks run once by `bootIfNotBooted()`, the factory pushes
   * built-in behaviour installers here (the soft-delete global scope,
   * implicit casts). Custom reusable behaviour is a plain TS mixin.
   */
  static bootHooks: Array<(this: typeof BaseModel) => void> = [];

  /**
   * Whether this table's primary key is DB-generated (auto-increment /
   * identity), derived from `config.keyType` (`"increment"` → `true`,
   * `"uuid"`/a `KeyStrategy` → `false`). Read by the insert path to decide
   * whether to read the generated key back. An internal accessor over
   * `keyStrategy`, set `keyType` on the config, not this.
   */
  static get incrementing(): boolean {
    return this.keyStrategy.incrementing;
  }

  /**
   * Client-side primary-key generator used when the key strategy is not
   * DB-`increment` and the insert payload has no key yet. Delegates to the
   * resolved `keyStrategy.generate` (`"uuid"`, snowflake, or a custom
   * `KeyStrategy`); a no-op for `"increment"`. Runs after the `saving`
   * hook and before `creating`, so both see the generated value.
   */
  static newUniqueId(
    this: typeof BaseModel,
  ): string | number | undefined | Promise<string | number | undefined> {
    return this.keyStrategy.generate?.({ modelName: this.name });
  }

  /**
   * Automatic `createdAtColumn`/`updatedAtColumn` stamping, **on by
   * default, matching Laravel** (whose `$timestamps` defaults to `true`).
   * A model whose table has `created_at`/`updated_at` columns gets them
   * stamped automatically; a model whose table has *no* timestamp columns must
   * set `static timestamps = false` (otherwise the insert/update would
   * write columns that don't exist). When on, `create()` stamps both
   * columns and `update()` stamps `updatedAtColumn`, in both cases only
   * when the caller hasn't already supplied that column explicitly
   * (explicit values always win, matching `Factory`'s own "explicit
   * overrides win" convention).
   *
   * A table that has only one of the two columns keeps `timestamps = true`
   * and sets the missing side to `null`. See `createdAtColumn`/
   * `updatedAtColumn`.
   */
  static timestamps = true;

  /**
   * Column `create()` stamps with the current UTC time (see
   * `currentTimestamp()`) when `timestamps` is true. Set to `null` to
   * disable created-at stamping while still stamping `updatedAtColumn`
   * (Laravel's `const CREATED_AT = null`), for a table that has an
   * `updated_at` column but no `created_at`.
   */
  static createdAtColumn: string | null = "created_at";

  /**
   * Column `create()`/`update()` stamp with the current UTC time (see
   * `currentTimestamp()`) when `timestamps` is true. Set to `null` to
   * disable updated-at stamping while still stamping `createdAtColumn`
   * (Laravel's `const UPDATED_AT = null`), the common "create-only"
   * table that has a `created_at` column but no `updated_at` (e.g. an
   * append-only like/follow/repost row that is only ever inserted or
   * deleted, never updated).
   */
  static updatedAtColumn: string | null = "updated_at";

  /**
   * Laravel's `$dispatchesEvents`, maps a lifecycle event name to an
   * `@mahiframework/events` `Event` subclass to dispatch through the app's
   * `EventDispatcher` (in addition to the always-fires generic
   * `ModelCreated`/`ModelUpdated`/etc. events. See `model-events.ts`).
   * Empty by default; only declared events are dispatched.
   *
   *   class Post extends Model {
   *     static override dispatchesEvents: DispatchesEventsMap = {
   *       created: PostCreated,
   *     };
   *   }
   */
  static dispatchesEvents: DispatchesEventsMap = {};

  /**
   * Laravel's `$afterCommit` on the model, when `true`, this model's
   * lifecycle events (`created`/`updated`/`saved`/`deleted`/`restored` and
   * their `-ing` counterparts, plus any `dispatchesEvents`-mapped classes
   * and `ModelObserver`/`on()` listeners) fire only after the enclosing
   * `DB.transaction()` commits, and are dropped if it rolls back. Off by
   * default (events fire inline, inside the transaction, as before).
   *
   *   class Post extends Model {
   *     static override dispatchesEventsAfterCommit = true;
   *   }
   *
   * Deferred per-connection: only a transaction on THIS model's own
   * connection defers its events. Note that `-ing` (before) hooks like
   * `creating`/`saving` that mutate attributes must still run inline (the
   * write hasn't happened yet), so only the past-tense (`created`/`saved`/
   * ...) events are actually deferred; see `dispatchModelEvent()`.
   */
  static dispatchesEventsAfterCommit = false;

  /**
   * The **single** declaration point for a model's relations, a name ->
   * `{ type, related, options }` map (see `relations.ts`'s
   * `RelationDefinition`). Drives everything: the per-row `relations`
   * namespace (`post.relations.comments()`, the query builder), the loaded
   * value accessors (`post.comments`, populated by `with()`/`load()`), and
   * batched eager loading (`with()`/`load()`/`loadMissing()`/`withCount()`/
   * `whereHas()`). Empty by default; declare it as `static override
   * relations = {...} satisfies RelationDefinitions` and both accessor
   * families and `with()` narrow to the specific relation names and
   * related types automatically. The framework reads the relation shape
   * straight off `typeof this.relations` (via `RelationsOf<M>`), so no
   * companion `declare static Relations` marker is needed. See the class
   * "Relationships" docstring section for the full usage example.
   *
   * Typed permissively on the base (`Record<string, any>`) so a subclass's
   * precise `Relationships<A>` (branded helper definitions) stays
   * assignable to `typeof BaseModel`. The precise type lives on
   * `ModelStatics`. The runtime shape is always `RelationDefinitions`.
   */
  static relationships: Record<string, any> = {};

  /**
   * Turns an unloaded-relation read into a thrown
   * `RelationNotLoadedError` instead of `undefined` (`config.
   * strictRelations`): Laravel's `preventLazyLoading()`, per model.
   *
   *   class Post extends Model<PostAttributes>()({
   *     table: "posts",
   *     strictRelations: true,
   *   }) {}
   *
   *   const post = await Post.first();
   *   post.comments;                    // throws, never loaded
   *   post.relations.comments();        // fine, an explicit query
   *   (await Post.query().with("comments").first()).comments;   // fine
   *
   * The point is N+1 detection: `undefined` and "loaded, and empty" are
   * otherwise the same value, so the bug reads as an empty list. Only
   * *declared* relations (keys of `relationships`) are affected, and only
   * when no real column shadows the name, a `withCount()` alias or a
   * genuine column still reads through. Off by default; the natural
   * posture is on in dev/test, off in production.
   */
  static strictRelations = false;

  /**
   * Internal alias for `relationships`, the runtime relation map the
   * eager loader, the instance `relations` getter and existence
   * subqueries read. The public declaration point is
   * `static relationships`.
   */
  static get relations(): RelationDefinitions {
    return this.relationships;
  }

  /**
   * Attribute names omitted from `toJSON()` (and therefore from any JSON
   * response serializing an instance directly), Laravel's `$hidden`.
   * The canonical use is `static hidden = ["password"]` so a `User`
   * instance never leaks its password hash when serialized. Ignored when
   * `visible` is non-empty (an allow-list takes precedence).
   */
  static hidden: string[] = [];

  /**
   * Allow-list counterpart to `hidden`, when non-empty, ONLY these
   * attributes appear in `toJSON()` (Laravel's `$visible`). Empty by
   * default (every non-`hidden` attribute is serialized).
   */
  static visible: string[] = [];

  /**
   * Mass-assignment allow-list, Laravel's `$fillable`. When non-empty,
   * ONLY these attributes may be set through a mass-assignment call
   * (`new Model({...})`, `create()`, `fill()`, `firstOrNew()`,
   * `firstOrCreate()`, `updateOrCreate()`, `updateInstance()`); any other
   * key is silently dropped (or throws, if the model is *totally guarded*.
   * See `guarded`). Empty by default, and `guarded` defaults to `[]`
   * (nothing guarded), so a model left at the framework defaults accepts
   * every attribute exactly as before this protection existed, opt in by
   * declaring `fillable`.
   *
   *   class Post extends Model {
   *     static override fillable = ["title", "body"];  // user_id/id never mass-assignable
   *   }
   *
   * `fillable` takes precedence over `guarded` when both are declared:
   * `isFillable()` first honors an explicit allow-list. Direct attribute
   * writes (`post.user_id = ...`, the proxy `set` trap) and internal
   * hydration (`hydrate()`/`setRawAttributes()`) bypass this entirely.
   * It guards *mass* assignment only, never a deliberate single-column
   * assignment.
   */
  static fillable: string[] = [];

  /**
   * Mass-assignment block-list, Laravel's `$guarded`. Attributes named
   * here (or `["*"]` for "guard everything") are rejected by
   * mass-assignment when no `fillable` allow-list is declared. **Defaults
   * to `[]`**, i.e. *nothing* guarded, so out of the box every attribute
   * is mass-assignable (preserving the framework's historical
   * no-protection behavior); tighten per model.
   *
   *   class Post extends Model {
   *     static override guarded = ["id", "user_id"];  // everything else fillable
   *   }
   *
   * A model with `guarded = ["*"]` (or the equivalent) **and** an empty
   * `fillable` is *totally guarded*: a mass-assignment of any attribute
   * throws `MassAssignmentError` rather than silently dropping it, so the
   * mistake surfaces loudly. `fillable` wins when both are set.
   */
  static guarded: string[] = [];

  /**
   * Appends a `GlobalScope` to THIS class's own `scopes` array, cloning
   * from the parent first when `scopes` is still inherited (so
   * `this.scopes.push(...)` cannot leak onto `Model.scopes` / sibling
   * models). Called from extension `boot` hooks.
   */
  static addGlobalScope(this: typeof BaseModel, scope: GlobalScope): void {
    if (!Object.hasOwn(this, "scopes")) {
      this.scopes = [...this.scopes];
    }

    this.scopes.push(scope);
  }

  /**
   * Runs `boot` once per constructor per isolate (process / worker
   * thread): parents first, then this class. The factory's `bootHooks`
   * (soft-delete global scope, implicit casts) whose entries live on THIS
   * class run first, then the user `boot()` hook. Re-entry from a query
   * issued during boot is a no-op (the class is already in the booted set).
   */
  static bootIfNotBooted(this: typeof BaseModel): void {
    const parent = Object.getPrototypeOf(this) as typeof BaseModel | null;

    if (
      parent !== null &&
      parent !== Function.prototype &&
      typeof parent.bootIfNotBooted === "function"
    ) {
      parent.bootIfNotBooted();
    }

    if (bootedModels.has(this)) {
      return;
    }

    bootedModels.add(this);

    if (!Object.hasOwn(this, "scopes")) {
      this.scopes = [...this.scopes];
    }

    if (Object.hasOwn(this, "bootHooks")) {
      for (const hook of this.bootHooks) {
        hook.call(this);
      }
    }

    this.boot();
  }

  /**
   * User hook for one-time per-class setup. Empty on the base. Override
   * on a subclass without calling `super.boot()`, the factory's boot
   * hooks already ran in `bootIfNotBooted()` before this.
   */
  static boot(this: typeof BaseModel): void {}

  /**
   * Resolves the Kysely instance this model's queries execute against:
   * this model's connection (`static connection`, from `config.
   * connection`, the default `DatabaseManager` driver when unset), or,
   * if a `transaction()` is open **on that same connection**, its
   * transactional instance (see `transaction-context.ts`). Called fresh
   * on every query execution (not cached), so a builder constructed
   * before a `transaction()` call but executed inside one still picks up
   * the transactional connection.
   *
   * The connection is resolved first and the transaction looked up *by*
   * it, rather than the other way round: a transaction open on a
   * different connection (`DB.transaction(cb, "analytics")`) must not
   * capture this model's queries, or they'd silently write to the wrong
   * database.
   */
  static resolveConnection(this: typeof BaseModel): Kysely<any> {
    const connection = app().make<DatabaseManager>(DATABASE_TOKEN).driver(this.connection).kysely;

    return getActiveTransaction(connection) ?? connection;
  }

  /**
   * This model's **root** (non-transactional) Kysely instance, the key the
   * transaction context registry is keyed by. Unlike `resolveConnection()`,
   * this never swaps in an active transaction's instance, so it's the
   * correct handle for `afterCommitOn()`: "defer against THIS model's
   * connection's transaction, if any." Used by after-commit model event
   * dispatch (`dispatchesEventsAfterCommit`).
   */
  static rootConnection(this: typeof BaseModel): Kysely<any> {
    return app().make<DatabaseManager>(DATABASE_TOKEN).driver(this.connection).kysely;
  }

  /**
   * "Now", spelled the way this model's connection will accept it,
   * used for `created_at`/`updated_at`/`deleted_at` stamping.
   *
   * Goes through the connection rather than formatting an ISO string
   * directly because MySQL rejects the ISO `Z` suffix; see
   * `formatTimestamp()` in `timestamps.ts`.
   */
  static currentTimestamp(this: typeof BaseModel): string {
    return currentTimestampFor(this.resolveConnection());
  }

  /**
   * The columns this model treats as instants, its auto-managed
   * timestamps plus every column declared with `DateTimeCast`.
   *
   * Used by `prepareWrite()` to fix up their spelling per engine. Only
   * *declared* datetime columns are eligible: rewriting anything that
   * merely looks like a date would corrupt a `varchar` that genuinely
   * stores an ISO string.
   */
  static temporalColumns(this: typeof BaseModel): string[] {
    const columns: string[] = [];

    if (this.timestamps) {
      if (this.createdAtColumn) {
        columns.push(this.createdAtColumn);
      }

      if (this.updatedAtColumn) {
        columns.push(this.updatedAtColumn);
      }
    }

    for (const [column, cast] of Object.entries(this.casts)) {
      if (cast === DateTimeCast) {
        columns.push(column);
      }
    }

    return columns;
  }

  /**
   * `values` with its datetime columns spelled the way this model's
   * connection accepts, the last step before any insert/update.
   *
   * A no-op on every engine but MySQL, which rejects the ISO-8601 `Z`
   * suffix that `DateTimeCast` produces. See `toDriverTimestamp()`.
   */
  static prepareWrite<T extends Record<string, any>>(this: typeof BaseModel, values: T): T {
    return prepareTemporalWrites(
      dialectOf(this.resolveConnection()),
      this.temporalColumns(),
      values,
    );
  }

  /**
   * Registers a `ModelObserver`, instantiated once, immediately, with no
   * constructor arguments. Every overridden method on it fires at the
   * matching lifecycle point for THIS model class only (registration is
   * keyed by class identity, not `table`, so a subclass doesn't
   * accidentally inherit its base class's observers or vice versa).
   * Multiple `observe()` calls stack; observers run in registration order,
   * before `on()` listeners and before any `EventDispatcher` dispatch.
   * See `model-events.ts`'s `dispatchModelEvent()` for the full ordering.
   *
   *   class PostObserver extends ModelObserver<PostTable> {
   *     override created(post: PostTable): void { ... }
   *   }
   *
   *   Post.observe(PostObserver);
   */
  static observe<M extends typeof BaseModel>(
    this: M,
    observerClass: ModelObserverClass<InstanceType<M>>,
  ): void {
    registerObserver(this, observerClass);
  }

  /**
   * Registers a single ad-hoc listener for one lifecycle event, a
   * lighter-weight alternative to `observe()` for a one-off/test-only
   * hook that doesn't warrant declaring a whole `ModelObserver` subclass.
   * See `model-events.ts`'s `ModelEventPayload` docstring for what each
   * event's `payload` argument contains.
   *
   *   Post.on("created", (post) => { ... });
   */
  static on<M extends typeof BaseModel>(
    this: M,
    event: ModelEventName,
    listener: ModelEventListener<InstanceType<M>>,
  ): void {
    registerModelListener(this, event, listener);
  }

  /**
   * Runs `callback` with this model's lifecycle events suppressed, a
   * thin proxy to `@mahiframework/events`' `Event.suppress()`, scoped via
   * a wildcard pattern built from `table`: `Post.withoutEvents(cb)`
   * suppresses only `"model.posts.*"`, leaving every other model's
   * events (and non-model events) unaffected. Called on the base `Model`
   * class directly (no `table` set), the pattern widens to `"model.*"`,
   * every model's events. AsyncLocalStorage-scoped (nested/async calls
   * made inside `callback` also see events suppressed, with no
   * call-site changes needed), and patterns stack with any enclosing
   * `Event.suppress()`/`withoutEvents()` call rather than replacing it.
   * See `Event.suppress()`'s docstring.
   *
   * Observers and `on()` listeners (invoked directly, checking
   * `Event.isSuppressed(name)` themselves. See `model-events.ts`'s
   * `dispatchModelEvent()`) and `EventDispatcher` dispatch (both the
   * generic `ModelLifecycleEvent` subclasses and any
   * `dispatchesEvents`-mapped class, both of which set `eventName` to
   * the same `"model.{table}.{event}"` scheme) are all suppressed alike.
   * Timestamp stamping is NOT suppressed. That's a separate concern
   * (`Factory.createQuietly()` relies on this: rows still get
   * `created_at`/`updated_at`, just without firing events).
   */
  static withoutEvents<T>(this: typeof BaseModel, callback: () => T | Promise<T>): Promise<T> {
    const pattern = this.table ? `model.${this.table}.*` : "model.*";

    return AbstractEvent.suppress(callback, [pattern]);
  }

  /**
   * Constructs a bare `EloquentBuilder` for this model, the low-level
   * *construction* hook, with no global scopes applied.
   *
   * This is not the customisation point for a per-model builder;
   * `static query()` is (see the class docstring's "Custom per-model
   * query builders"). It survives the redesign because several internal
   * paths genuinely need "a fresh builder of this model's subclass,
   * unscoped": the nested `where(callback)` group, `whereHas()`
   * subqueries, and the relation helpers. Overriding it alone changes
   * what those construct but NOT what `query()` returns.
   */
  static newEloquentBuilder(): EloquentBuilder<any> {
    return new EloquentBuilder<Record<string, any>>(this);
  }

  /**
   * Constructs this model's `Factory`. See the class docstring's "Model
   * factories" section. No default implementation: unlike
   * `newEloquentBuilder()`, there's no sensible generic `Factory` to fall
   * back to (a factory's `definition()` is inherently model-specific), so
   * the base implementation throws and a missing override is a
   * development-time mistake worth failing loudly on.
   *
   * Deliberately NOT split into a `newFactory()` + type-only
   * `declare static Factory` marker pair the way `query()`/
   * `newEloquentBuilder()`/`Builder` is. That split earns its keep for
   * builders because `query()` does real work around the constructed
   * builder (applying global scopes), so the construction hook and the
   * public entry point are genuinely different methods. `factory()` does
   * no such work, it would be a bare `return this.newFactory()`, so the
   * split would be pure ceremony, forcing every model to write the same
   * thing twice (once as a type, once as a value). Overriding this
   * directly is one declaration that supplies both:
   *
   *   static override factory(): PostFactory {
   *     return new PostFactory();
   *   }
   *
   * The return type is `Factory<any>`, not `Factory<typeof BaseModel>`:
   * `Factory` is invariant in its model parameter (`M` drives both the
   * `Record<string, any>` overrides `make()`/`create()` accept and the
   * `InstanceType<M>` rows they return), so a concrete
   * `Factory<typeof Post>` is NOT assignable to `Factory<typeof BaseModel>`.
   * Using `any` lets an override narrow to its own factory without
   * tripping "class static side incorrectly extends base class static
   * side". Which would otherwise poison EVERY static on the model, since
   * a single bad static member makes the whole class's static side
   * unassignable to `typeof BaseModel`.
   */
  static factory(): Factory<any> {
    throw new Error(
      `${this.name} has no factory — override "static factory()" to return a Factory instance.`,
    );
  }

  /**
   * Start a fluent, chainable query, `where`/`whereIn`/`orderBy`/
   * `limit`/`skip`/`get`/`first`/`count`/`update`/`delete`. `all`/`find`/
   * `create`/`update`/`delete` cover the 80% case as direct static
   * calls; use `query()` when you need to compose conditions
   * before executing.
   *
   * Every declared `scopes` entry is applied automatically (see the
   * class docstring's "Global scopes" section), use
   * `queryWithoutScopes()`/`withoutGlobalScope()` to bypass them.
   */
  static query<M extends typeof BaseModel>(this: M): EloquentBuilder<any> {
    this.bootIfNotBooted();
    const builder = (this as typeof BaseModel).newEloquentBuilder.call(this) as EloquentBuilder<
      Record<string, any>
    >;

    for (const scope of (this as typeof BaseModel).scopes) {
      scope.apply(builder);
    }

    return builder as EloquentBuilder<any>;
  }

  /** Like `query()`, but with every declared global scope bypassed. */
  static queryWithoutScopes<M extends typeof BaseModel>(this: M): EloquentBuilder<any> {
    this.bootIfNotBooted();

    return (this as typeof BaseModel).newEloquentBuilder.call(this) as EloquentBuilder<any>;
  }

  /**
   * The **persistence** builder, Laravel's `newModelQuery()`. Same as
   * `queryWithoutScopes()`, under a name that says why: writing a row
   * you already hold must not be filtered by the scopes that decide
   * which rows are *readable*.
   *
   * `save()`, the static `update()`/`delete()`, `refresh()` and the
   * instance delete path all go through here rather than `query()`. Via
   * `query()` a `SoftDeletes` model compiles `UPDATE ... WHERE id = ?
   * AND deleted_at IS NULL`, so calling `save()` on a trashed instance,
   * or `Post.update(id, {...})` on a trashed row, matches zero rows and
   * silently writes nothing. The same applies to any global scope
   * (multi-tenancy, publish state) whose column the write itself is
   * changing.
   *
   * Reads keep using `query()`: excluding trashed rows from `find()`/
   * `all()` is exactly what a global scope is for.
   */
  static newModelQuery<M extends typeof BaseModel>(this: M): EloquentBuilder<any> {
    return (this as typeof BaseModel).queryWithoutScopes() as EloquentBuilder<any>;
  }

  /** Like `query()`, but with every declared global scope EXCEPT `ScopeClass` applied. */
  static withoutGlobalScope<M extends typeof BaseModel, S extends GlobalScope>(
    this: M,
    ScopeClass: new (...args: any[]) => S,
  ): EloquentBuilder<any> {
    this.bootIfNotBooted();
    const builder = (this as typeof BaseModel).newEloquentBuilder.call(this) as EloquentBuilder<
      Record<string, any>
    >;

    for (const scope of (this as typeof BaseModel).scopes) {
      if (!(scope instanceof ScopeClass)) {
        scope.apply(builder);
      }
    }

    return builder as EloquentBuilder<any>;
  }

  /**
   * Like `withoutGlobalScope()`, but bypasses SEVERAL scope classes at
   * once (or, called with no arguments, every declared scope, the same
   * result as `queryWithoutScopes()`, provided for API symmetry with
   * Laravel's `withoutGlobalScopes()`, which accepts an empty array for
   * the same "bypass everything" behavior).
   */
  static withoutGlobalScopes<M extends typeof BaseModel>(
    this: M,
    ScopeClasses?: (new (...args: any[]) => GlobalScope)[],
  ): EloquentBuilder<any> {
    this.bootIfNotBooted();

    if (ScopeClasses === undefined) {
      return (this as typeof BaseModel).queryWithoutScopes() as EloquentBuilder<any>;
    }

    const builder = (this as typeof BaseModel).newEloquentBuilder.call(this) as EloquentBuilder<
      Record<string, any>
    >;

    for (const scope of (this as typeof BaseModel).scopes) {
      if (!ScopeClasses.some((ScopeClass) => scope instanceof ScopeClass)) {
        scope.apply(builder);
      }
    }

    return builder as EloquentBuilder<any>;
  }

  static async all<M extends typeof BaseModel>(this: M): Promise<Collection<any>> {
    return this.query().get() as unknown as Collection<any>;
  }

  /**
   * The column this model soft-deletes into, or `undefined` when it does
   * not soft-delete at all.
   *
   * The read-only counterpart to `primaryKeyColumn`. Exists because the
   * column is otherwise only reachable through the scope internals, which
   * left anything outside this package, a test assertion, a custom
   * builder, hardcoding `"deleted_at"` and silently missing a model that
   * configured something else.
   */
  static get softDeleteColumn(): string | undefined {
    return findSoftDeleteScope(this.scopes)?.deletedAtColumn;
  }

  /**
   * A query builder including soft-deleted rows, Laravel's `withTrashed()`.
   * Present on every model, but only meaningful when `softDeletes` is
   * configured; drops just the soft-delete scope, leaving any other global
   * scope in place. Throws on a model that doesn't soft-delete, so a typo
   * fails loudly rather than silently widening the result set.
   */
  static withTrashed<M extends typeof BaseModel>(this: M): EloquentBuilder<any> {
    return this.withoutGlobalScope(softDeleteScopeClassOf(this));
  }

  /** A query builder returning ONLY soft-deleted rows. Other global scopes still apply. */
  static onlyTrashed<M extends typeof BaseModel>(this: M): EloquentBuilder<any> {
    const builder = this.withoutGlobalScope(
      softDeleteScopeClassOf(this),
    ) as unknown as EloquentBuilder<Record<string, any>>;
    const column = findSoftDeleteScope(this.scopes)!.deletedAtColumn;
    builder.whereNotNull(`${this.table}.${column}`);

    return builder as EloquentBuilder<any>;
  }

  /**
   * Proxies to `query().whereKey(id).first()`, returning a hydrated model
   * INSTANCE (or `undefined`), typed as `InstanceType<M>`, i.e. the model
   * class itself (`Post.find(id)` returns a `Post | undefined`). A model's
   * typed attributes are derived from the `PostAttributes` map its config
   * was built with, so `find()` needs no special `this: { Row } & typeof
   * BaseModel` handling to stay precise.
   */
  static async find<M extends typeof BaseModel>(this: M, id: SqlBinding): Promise<any | undefined> {
    return this.query().whereKey(id).first() as unknown as any | undefined;
  }

  /**
   * Finds every row whose primary key is in `ids`, in a single
   * `whereIn()` query (never one query per id), matches Laravel's
   * `findMany()`. Rows for any id with no matching row are simply
   * absent from the result (same as Eloquent's `findMany()`); use
   * `findOrFail()` in a loop instead if a missing id should throw.
   */
  static async findMany<M extends typeof BaseModel>(
    this: M,
    ids: SqlBinding[],
  ): Promise<Collection<any>> {
    if (ids.length === 0) {
      return Collection.make<any>([]);
    }

    const builder = this.query() as unknown as EloquentBuilder<Record<string, any>>;

    return (await builder.whereIn(this.primaryKeyColumn, ids).get()) as unknown as Collection<any>;
  }

  /** Like `find()`, but throws `ModelNotFoundError` instead of returning `undefined`. */
  static async findOrFail<M extends typeof BaseModel>(this: M, id: SqlBinding): Promise<any> {
    const row = await this.find(id);

    if (row === undefined) {
      throw new ModelNotFoundError(this.name, id);
    }

    return row;
  }

  /** Proxies to `query().first()`, returning a hydrated instance or `undefined`. */
  static async first<M extends typeof BaseModel>(this: M): Promise<any | undefined> {
    return this.query().first() as unknown as any | undefined;
  }

  /** Like `first()`, but throws `ModelNotFoundError` instead of returning `undefined`. */
  static async firstOrFail<M extends typeof BaseModel>(this: M): Promise<any> {
    const row = await this.first();

    if (row === undefined) {
      throw new ModelNotFoundError(this.name, undefined);
    }

    return row;
  }

  /**
   * Inserts a row. If `timestamps` is enabled, stamps `createdAtColumn`/
   * `updatedAtColumn` (unless the caller already supplied them, explicit
   * values always win). Fires `saving` → `creating` → insert → `created`
   * → `saved`, in that order, via `dispatchModelEvent()` (see
   * `model-events.ts`), suppressed entirely inside `withoutEvents()`.
   * `creating`/`saving` hooks receive the SAME object about to be
   * inserted, so mutating it in place (e.g. an observer normalizing a
   * field) changes what actually gets written.
   *
   * If `incrementing` is true (the default), reads back the DB-generated
   * `primaryKeyColumn` value via Kysely's `InsertResult.insertId` and
   * merges it into the returned row, unless the caller already supplied
   * that column explicitly, in which case the DB won't have
   * auto-generated anything and the caller's value passes through
   * unchanged. Declare `keyType` on models with a client-generated
   * primary key, `"uuid"`, or `snowflake()` from `@mahiframework/snowflake`;
   * `incrementing` is a read-only accessor derived from it.
   *
   * When `incrementing` is false and the payload has no primary key,
   * `newUniqueId()` is called to fill it (a no-op unless overridden).
   *
   * Accepts MODEL-shape values (casts apply on the way in) and returns a
   * saved model INSTANCE. Builds a `new this(values)` and `save()`s it,
   * so the whole lifecycle (timestamps, generated-id read-back, and the
   * `saving`/`creating`/`created`/`saved` events, now receiving the
   * instance as payload) runs through the one instance code path.
   */
  static async create<M extends typeof BaseModel>(
    this: M,
    values: Record<string, any>,
  ): Promise<InstanceType<M>> {
    const instance = new (this as unknown as new (attrs: Record<string, any>) => Model)(
      values as Record<string, any>,
    );
    await instance.save();

    return instance as InstanceType<M>;
  }

  /**
   * Builds the `where(attributes)` chain `firstOrNew`/`firstOrCreate`/
   * `updateOrCreate` all start from, one `where()` per key in
   * `attributes`. Not marked `private`/`protected`: `Model<A>()(config)`
   * returns an anonymous generated class, and TypeScript disallows an
   * exported function's return type from containing a private/protected
   * member of its base class.
   * Intended for internal use by the three methods above only.
   */
  static matching<M extends typeof BaseModel>(
    this: M,
    attributes: Record<string, any>,
  ): EloquentBuilder<any> {
    const builder = this.query() as unknown as EloquentBuilder<Record<string, any>>;

    for (const [column, value] of Object.entries(attributes)) {
      builder.where(column, value);
    }

    return builder as unknown as EloquentBuilder<any>;
  }

  /**
   * Returns the first row matching `attributes` as an instance, or, if
   * none matches, a NEW, UNSAVED instance filled with `{ ...attributes,
   * ...values }` (matches Laravel's `firstOrNew()`: it builds an unsaved
   * model instance, never writes). Call `.save()` on the result to
   * persist it.
   */
  static async firstOrNew<M extends typeof BaseModel>(
    this: M,
    attributes: Record<string, any>,
    values: Record<string, any> = {},
  ): Promise<InstanceType<M>> {
    const existing = (await this.matching(attributes).first()) as unknown as
      InstanceType<M> | undefined;

    if (existing !== undefined) {
      return existing;
    }

    return new (this as unknown as new (attrs: Record<string, any>) => Model)({
      ...attributes,
      ...values,
    }) as InstanceType<M>;
  }

  /**
   * Creates a row, and on a unique-constraint collision re-reads the row
   * that beat us to it instead of propagating the error. The
   * read-then-insert race guard shared by `firstOrCreate()` and
   * `updateOrCreate()` (Laravel 10+ does the same).
   *
   * Both of those methods are "check, then write", which is not atomic:
   * two concurrent requests can both see no row, both insert, and one
   * loses to the unique index. Callers use these methods precisely
   * to express "make sure this exists", so a 500 on the losing request
   * is the wrong answer when the row now demonstrably does exist.
   *
   * Only `UniqueConstraintViolationException` is caught, the portable
   * exception `translateDatabaseError()` raises for SQLite's
   * `SQLITE_CONSTRAINT_UNIQUE`, MySQL's 1062 and Postgres' 23505 alike.
   * Everything else (a NOT NULL violation, a bad column) is a real bug
   * and propagates. If the re-read *also* finds nothing, the collision
   * was on some other unique index than `attributes`, so the original
   * error is rethrown rather than silently returning something wrong.
   */
  /**
   * Returns the first row matching `attributes` as an instance, creating
   * it (via `create()`, so timestamps/events/incrementing-id read-back
   * all apply) with `{ ...attributes, ...values }` if none matches.
   * Matches Laravel's `firstOrCreate()`.
   *
   * Safe under concurrency: if another request inserts the same row
   * between this method's read and its write, the resulting unique
   * violation is recovered by re-reading. See
   * `createOrRecoverFromCollision()`.
   */
  static async firstOrCreate<M extends typeof BaseModel>(
    this: M,
    attributes: Record<string, any>,
    values: Record<string, any> = {},
  ): Promise<InstanceType<M>> {
    const existing = (await this.matching(attributes).first()) as unknown as
      InstanceType<M> | undefined;

    if (existing !== undefined) {
      return existing;
    }

    return createOrRecoverFromCollision(this, attributes, {
      ...attributes,
      ...values,
    }) as unknown as InstanceType<M>;
  }

  /**
   * Updates the first row matching `attributes` with `values` (via
   * `update()`, so timestamp stamping/events apply), or creates one with
   * `{ ...attributes, ...values }` if none matches. Matches Laravel's
   * `updateOrCreate()`.
   *
   * Safe under concurrency the same way `firstOrCreate()` is, with the
   * addition that a recovered collision still applies `values` to the
   * row that won, so "update or create" holds either way rather than
   * degrading into "create, or silently do nothing".
   */
  static async updateOrCreate<M extends typeof BaseModel>(
    this: M,
    attributes: Record<string, any>,
    values: Record<string, any> = {},
  ): Promise<InstanceType<M>> {
    const existing = (await this.matching(attributes).first()) as unknown as Model | undefined;

    if (existing === undefined) {
      const created = (await createOrRecoverFromCollision(this, attributes, {
        ...attributes,
        ...values,
      })) as unknown as Model;
      // A recovered row was inserted by someone else and may not carry
      // `values`; a row we inserted ourselves already does, and
      // `updateInstance()` no-ops when nothing is dirty.
      await created.updateInstance(values as Record<string, any>);

      return created as InstanceType<M>;
    }

    await existing.updateInstance(values as Record<string, any>);

    return existing as InstanceType<M>;
  }

  /**
   * Updates the row matching `primaryKeyColumn = id`. If `timestamps` is
   * enabled, stamps `updatedAtColumn` (unless the caller already supplied
   * it). Fires `saving` → `updating` → update → `updated` → `saved`.
   * Every hook receives `values` merged with `{ [primaryKeyColumn]: id }`
   * (the same object reference used for the actual `UPDATE ... SET`, so
   * in-place mutations are reflected in what gets written), hooks always
   * know which row without a separate `id` parameter.
   *
   * `values` are MODEL-shape and run through each column's `casts` on
   * the way to the `SET` clause, so `Widget.update(id, { active: false })`
   * writes `0` on SQLite rather than failing to bind a boolean. The
   * hooks see the cast (DB-shape) object, matching what `save()` passes
   * them.
   *
   * Runs through `newModelQuery()`, not `query()`. See that method for
   * why persistence must not inherit read-side global scopes.
   */
  static async update<M extends typeof BaseModel>(
    this: M,
    id: SqlBinding,
    values: Record<string, any>,
  ): Promise<void> {
    const attributes: Record<string, any> = {};

    for (const [column, value] of Object.entries(values as Record<string, any>)) {
      const cast = this.casts[column] as Cast<any, any> | undefined;
      attributes[column] = cast ? cast.toDatabaseType(value) : value;
    }

    if (
      this.timestamps &&
      this.updatedAtColumn !== null &&
      attributes[this.updatedAtColumn] === undefined
    ) {
      attributes[this.updatedAtColumn] = this.currentTimestamp();
    }

    attributes[this.primaryKeyColumn] = id;

    await dispatchModelEvent(this, "saving", attributes as ModelEventPayload);
    await dispatchModelEvent(this, "updating", attributes as ModelEventPayload);

    await (this.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>)
      .whereKey(id)
      .update(this.prepareWrite(attributes));

    await dispatchModelEvent(this, "updated", attributes as ModelEventPayload);
    await dispatchModelEvent(this, "saved", attributes as ModelEventPayload);
  }

  /**
   * Not generic over `M` (its return type, `void`, doesn't depend on the
   * row type), deliberately, so `SoftDeletes` can override it with a
   * plain `this: typeof BaseModel` signature without a static-side variance
   * error. If you need to override `delete()` in your own extension,
   * follow the same non-generic-`this` shape.
   *
   * Fires `deleting` → delete → `deleted`, passing the model **INSTANCE**
   * as the payload, matching Laravel, whose delete events always receive
   * the model (not a bare `{ [primaryKeyColumn]: id }` object). The row is
   * loaded first so the payload is the real, fully-attributed instance; a
   * listener can therefore read any column (`post.user_id`), not just the
   * primary key. When no row matches `id` there's nothing to hand over, so
   * the events fall back to a minimal `{ [primaryKeyColumn]: id }` object
   * (and no `DELETE` runs against a row that isn't there).
   *
   * The optional `preloaded` instance lets the instance-side
   * `deleteInstance()` pass the model it already has in hand, avoiding a
   * redundant read, external callers pass just the id.
   */
  static async delete(this: typeof BaseModel, id: SqlBinding, preloaded?: Model): Promise<void> {
    this.bootIfNotBooted();
    const instance =
      preloaded ??
      ((await (this.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>)
        .whereKey(id)
        .first()) as Model | undefined);
    const payload: ModelEventPayload = instance ?? { [this.primaryKeyColumn]: id };

    await dispatchModelEvent(this, "deleting", payload);
    // Soft-delete when the model is configured with `softDeletes`, the
    // config scope carries the column; otherwise a real DELETE.
    const scope = findSoftDeleteScope(this.scopes);
    const query = (
      this.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>
    ).whereKey(id);

    if (scope) {
      await query.update({ [scope.deletedAtColumn]: this.currentTimestamp() });
    } else {
      await query.forceDelete();
    }

    await dispatchModelEvent(this, "deleted", payload);
  }

  /**
   * Many-to-one: the foreign key lives on **this** model's table. Returns
   * the related model's builder filtered to the single owning row, call
   * `.first()` to resolve it.
   *
   *   static user(row: TodoTable) {
   *     return this.belongsTo(User, row, { foreignKey: "user_id" });
   *   }
   *
   * If `row[foreignKey]` is `null` (a nullable FK), the resulting query
   * is `WHERE owner_key = NULL`, which matches nothing, `.first()`
   * yields `undefined`, the same answer Eloquent gives, without a special
   * case here.
   */
  static belongsTo<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: BelongsToOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const ownerKey = options.ownerKey ?? related.primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.where(ownerKey, (row as Record<string, any>)[options.foreignKey]);

    return builder as EloquentBuilder<any>;
  }

  /**
   * One-to-many: the foreign key lives on the **related** model's table.
   *
   *   static todos(row: UserTable) {
   *     return this.hasMany(Todo, row, { foreignKey: "user_id" });
   *   }
   */
  static hasMany<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: HasManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.where(options.foreignKey, (row as Record<string, any>)[localKey]);

    return builder as EloquentBuilder<any>;
  }

  /**
   * One-to-one, identical to `hasMany()` in every respect except intent
   * (and that you'd call `.first()` rather than `.get()` on the result).
   * Provided so a model's own method reads as the relationship it is;
   * there is no separate uniqueness enforcement, which is the database's
   * job via a unique index on the foreign key.
   */
  static hasOne<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: HasOneOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.where(options.foreignKey, (row as Record<string, any>)[localKey]);

    return builder as EloquentBuilder<any>;
  }

  /**
   * Many-to-many through a pivot table.
   *
   *   static tags(row: TodoTable) {
   *     return this.belongsToMany(Tag, row, {
   *       pivotTable: "todo_tag",
   *       foreignPivotKey: "todo_id",
   *       relatedPivotKey: "tag_id",
   *     });
   *   }
   *
   * Implemented as `WHERE tags.id IN (SELECT tag_id FROM todo_tag WHERE
   * todo_id = ?)` rather than a JOIN, one query either way, but the
   * subquery form keeps the result rows exactly `TRelatedRow` (no pivot
   * columns bleeding in, no ambiguous duplicate column names) and keeps
   * the return value the related model's ordinary builder, so global
   * scopes and further chaining work unchanged. See `QueryBuilder.
   * whereIn()`'s `Subquery` overload, the same overload real
   * Laravel's `whereIn($column, $subquery)` uses.
   *
   * Requesting pivot columns via `withPivot`/`withTimestamps` switches
   * that to a join, since the values have to travel back with the row;
   * they arrive under a `pivot` accessor on each related instance. See
   * `buildPivotQuery()`.
   */
  static belongsToMany<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: BelongsToManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;

    return buildPivotQuery(related, {
      pivotTable: options.pivotTable,
      thisPivotKey: options.foreignPivotKey,
      relatedPivotKey: options.relatedPivotKey,
      localValue: (row as Record<string, any>)[localKey],
      relatedKey: options.relatedKey ?? related.primaryKeyColumn,
      withPivot: options.withPivot,
      withTimestamps: options.withTimestamps,
    }) as EloquentBuilder<any>;
  }

  /**
   * Polymorphic many-to-many from a row, the **morphed** side. See
   * `relations.ts`'s `MorphToManyOptions`, and note the `type`-defaulting
   * asymmetry against `morphedByMany()`.
   */
  static morphToMany<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: MorphToManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;

    return buildPivotQuery(related, {
      pivotTable: options.pivotTable,
      thisPivotKey: options.morphId,
      relatedPivotKey: options.relatedPivotKey,
      localValue: (row as Record<string, any>)[localKey],
      relatedKey: options.relatedKey ?? related.primaryKeyColumn,
      morphType: options.morphType,
      morphValue: options.type ?? (this as typeof BaseModel).morphAlias(),
      withPivot: options.withPivot,
      withTimestamps: options.withTimestamps,
    }) as EloquentBuilder<any>;
  }

  /**
   * Polymorphic many-to-many from a row, the **inverse** side. `type`
   * names the RELATED model here, not this one; see
   * `relations.ts`'s `MorphedByManyOptions`.
   */
  static morphedByMany<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: MorphedByManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;

    return buildPivotQuery(related, {
      pivotTable: options.pivotTable,
      thisPivotKey: options.foreignPivotKey,
      relatedPivotKey: options.morphId,
      localValue: (row as Record<string, any>)[localKey],
      relatedKey: options.relatedKey ?? related.primaryKeyColumn,
      morphType: options.morphType,
      morphValue: options.type ?? related.morphAlias(),
      withPivot: options.withPivot,
      withTimestamps: options.withTimestamps,
    }) as EloquentBuilder<any>;
  }

  /**
   * Polymorphic one-to-many: the discriminant/foreign-key pair lives on
   * the **related** model's table. Returns the related model's builder
   * filtered to rows whose `morphType` equals this model's fixed `type`
   * value AND whose `morphId` points back at this row.
   *
   *   static comments(row: PostTable) {
   *     return this.morphMany(Comment, row, {
   *       morphType: "commentable_type",
   *       morphId: "commentable_id",
   *     });
   *   }
   *
   * Unlike Eloquent, the `{morphType}`/`{morphId}` column names are
   * explicit, no `{name}_type`/`{name}_id` guessing, matching every
   * other relation here. `type` is the one exception, and only because
   * it isn't a *column* name: it defaults to this model's
   * `morphAlias()`, which is a declared property of the model rather
   * than a guess derived from one.
   */
  static morphMany<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: MorphManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;
    const type = options.type ?? (this as typeof BaseModel).morphAlias();
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder
      .where(options.morphType, type)
      .where(options.morphId, (row as Record<string, any>)[localKey]);

    return builder as EloquentBuilder<any>;
  }

  /**
   * Polymorphic one-to-one, identical to `morphMany()` except intent
   * (call `.first()` rather than `.get()`). See `morphMany()`.
   */
  static morphOne<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: MorphOneOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this as typeof BaseModel).primaryKeyColumn;
    const type = options.type ?? (this as typeof BaseModel).morphAlias();
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder
      .where(options.morphType, type)
      .where(options.morphId, (row as Record<string, any>)[localKey]);

    return builder as EloquentBuilder<any>;
  }

  /**
   * Polymorphic inverse (`morphTo`): resolves which parent model this row
   * points at by reading its `morphType` discriminant column, resolving
   * the value to a model class, and querying that model by `morphId`.
   *
   *   static commentable(row: CommentTable) {
   *     return Comment.morphTo(row, {
   *       morphType: "commentable_type",
   *       morphId: "commentable_id",
   *       types: { post: () => Post, video: () => Video },
   *     });
   *   }
   *
   *   const parent = await Comment.morphTo(comment);  // Post | Video | undefined
   *
   * The discriminant resolves through the local `types` map first, then
   * the global morph map (see `resolveMorphType()`). `types` is optional,
   * but declaring it is what makes the return a precise union rather than
   * a bare `Model`.
   *
   * Returns `undefined` (a resolved promise) when the discriminant
   * resolves to nothing or its `morphId` is null, matching
   * `belongsTo()`'s "missing owner resolves to undefined" behavior.
   * Unlike the other relation helpers this returns a `Promise` of the
   * resolved instance, not a builder: the target model isn't known until
   * the discriminant is read, so there's no single builder type to chain
   * onto.
   */
  static async morphTo<
    M extends typeof BaseModel,
    TTypes extends Record<string, () => typeof BaseModel>,
  >(
    this: M,
    row: Record<string, any>,
    options: MorphToOptions<Record<string, any>, TTypes>,
  ): Promise<InstanceType<ReturnType<TTypes[keyof TTypes]>> | undefined> {
    const typeValue = (row as Record<string, any>)[options.morphType];
    const idValue = (row as Record<string, any>)[options.morphId];

    if (typeValue == null || idValue == null) {
      return undefined;
    }

    const related = resolveMorphType(typeValue as string, options.types);

    if (!related) {
      return undefined;
    }

    const ownerKey = options.ownerKey ?? related.primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;

    return (await builder.where(ownerKey, idValue).first()) as
      InstanceType<ReturnType<TTypes[keyof TTypes]>> | undefined;
  }

  /**
   * Has-many-through: reaches a distant related model via an intermediate
   * ("through") model, e.g. `Country.posts(country)` returns posts made
   * by the country's users. Compiled as `WHERE related.secondKey IN
   * (SELECT through.secondLocalKey FROM through WHERE through.firstKey =
   * ?)`, one subquery, so the result rows stay exactly the related
   * model's shape and its global scopes/further chaining apply.
   *
   *   static posts(row: CountryTable) {
   *     return this.hasManyThrough(Post, row, {
   *       through: () => User,
   *       firstKey: "country_id",
   *       secondKey: "user_id",
   *     });
   *   }
   */
  static hasManyThrough<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: HasManyThroughOptions<Record<string, any>, Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    return throughBuilder(
      this as typeof BaseModel,
      related,
      row as Record<string, any>,
      options as any,
    );
  }

  /** Has-one-through, identical to `hasManyThrough()` except intent (call `.first()`). See `hasManyThrough()`. */
  static hasOneThrough<M extends typeof BaseModel, R extends typeof BaseModel>(
    this: M,
    related: R,
    row: Record<string, any>,
    options: HasOneThroughOptions<Record<string, any>, Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    return throughBuilder(
      this as typeof BaseModel,
      related,
      row as Record<string, any>,
      options as any,
    );
  }

  /** Offset-based pagination. See `pagination/length-aware-paginator.ts`'s docstring. */
  static async paginate<M extends typeof BaseModel>(
    this: M,
    page: number,
    perPage: number,
  ): Promise<LengthAwarePaginationResult<Record<string, any>>> {
    return paginate(
      this.query() as unknown as EloquentBuilder<any>,
      page,
      perPage,
    ) as unknown as Promise<LengthAwarePaginationResult<Record<string, any>>>;
  }

  /** Offset-based pagination without a count query. See `pagination/simple-paginator.ts`'s docstring. */
  static async simplePaginate<M extends typeof BaseModel>(
    this: M,
    page: number,
    perPage: number,
  ): Promise<SimplePaginationResult<Record<string, any>>> {
    return simplePaginate(
      this.query() as unknown as EloquentBuilder<any>,
      page,
      perPage,
    ) as unknown as Promise<SimplePaginationResult<Record<string, any>>>;
  }

  /** Cursor-based pagination. See `pagination/cursor-paginator.ts`'s docstring. */
  static async cursorPaginate<
    M extends typeof BaseModel,
    K extends keyof Record<string, any> & string,
  >(
    this: M,
    options: CursorPaginateOptions<Record<string, any>, K>,
  ): Promise<CursorPaginationResult<Record<string, any>>> {
    return cursorPaginate(
      this.query() as unknown as EloquentBuilder<any>,
      options,
    ) as unknown as Promise<CursorPaginationResult<Record<string, any>>>;
  }

  /**
   * Constructs a NEW (unsaved) instance. `attributes` are treated as
   * MODEL-shape values and run through each column's cast on the way in
   * (`new Post({ published: true })` stores `1`). Hydration of an
   * existing DB row goes through the static `hydrate()` instead (which
   * stores raw DB values and marks the instance as existing).
   *
   * Returns a `Proxy` so `post.body`/`post.published` read/write casted
   * attributes directly. See `MODEL_PROXY_HANDLER`. Instance state lives
   * in a `WeakMap` (`instanceState`) keyed by BOTH the target and the
   * proxy, so class methods (bound to the target), the proxy handler
   * (holding the target), and callers (holding the proxy) all reach the
   * same state without private-field-through-Proxy pitfalls.
   */
  constructor(attributes: Record<string, any> = {}) {
    const state: InstanceState = {
      attributes: {},
      original: {},
      changes: {},
      wasRecentlyCreated: false,
      relations: new Map(),
      computed: new Map(),
      exists: false,
      self: this,
    };
    instanceState.set(this, state);
    const proxy = new Proxy(this, MODEL_PROXY_HANDLER);
    state.self = proxy;
    instanceState.set(proxy, state);
    // Honor mass-assignment protection (`fillable`/`guarded`) for the
    // `new Model({...})` / `create()` path, a no-op for models left at
    // the framework defaults (everything fillable). `hydrate()`/`Factory`
    // construct with no attributes and use the unguarded raw-attribute
    // setters instead, so those paths are unaffected.
    proxy.fill(attributes);

    return proxy;
  }

  /** This instance's state record (works whether `this` is the proxy or the target). */
  private get $state(): InstanceState {
    return instanceState.get(this)!;
  }

  /**
   * Hydrates an instance from a raw DB row. Values are stored as-is (DB
   * shape, no cast-in), the dirty-tracking snapshot is taken, and the
   * instance is marked as existing. This is what `EloquentBuilder`/the
   * static finders use to turn query results into instances.
   *
   * Any `pivot__*` columns (projected by a `withPivot()` relation's join)
   * are split off into a `pivot` object rather than kept as attributes.
   * See `pivot.ts`. They belong to the join, not to this table, so
   * leaving them in `attributes`/`original` would make them
   * dirty-trackable and write them back on the next `save()`.
   */
  static hydrate<M extends typeof BaseModel>(this: M, row: Record<string, any>): any {
    const instance = new (this as unknown as new () => Model)();
    const state = instanceState.get(instance)!;

    const attributes: Record<string, any> = {};
    const pivot: Record<string, any> = {};
    let hasPivot = false;

    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(PIVOT_PREFIX)) {
        pivot[key.slice(PIVOT_PREFIX.length)] = value;
        hasPivot = true;
      } else {
        attributes[key] = value;
      }
    }

    state.attributes = attributes;
    state.original = { ...attributes };
    state.exists = true;

    if (hasPivot) {
      state.computed.set("pivot", pivot);
    }

    return instance as unknown as any;
  }

  /**
   * Fires the `retrieved` lifecycle event for an instance just hydrated
   * from a query, called by `EloquentBuilder.get()`/`first()` after
   * hydration. The read-side hook (cache-warming, audit-on-read); no-ops
   * unless a listener/observer for `retrieved` is registered, so ordinary
   * query reads stay cheap.
   */
  static async fireRetrieved(instance: Model): Promise<void> {
    if (!hasModelListeners(this, "retrieved")) {
      return;
    }

    await dispatchModelEvent(this, "retrieved", instance as never);
  }

  /** The raw (DB-shape) value of an attribute, bypassing casts, used for relation keys. */
  getRawAttribute(key: string): any {
    return this.$state.attributes[key];
  }

  /**
   * Sets one attribute in its raw (DB-shape) form, bypassing the column's
   * cast, the singular counterpart to `setRawAttributes()`, and the
   * write-side mirror of `getRawAttribute()`. For a caller that already
   * holds the stored representation (a driver-shaped value, a
   * pre-serialised JSON string) and would otherwise pay a pointless
   * decode/encode round trip through `setAttribute()`.
   *
   * Still dirty-tracked: the value lands in `attributes` like any other,
   * so `getDirty()`/`isDirty()` see it and the next `save()` writes it.
   */
  setRawAttribute(key: string, value: any): void {
    this.$state.attributes[key] = value;
  }

  /**
   * Replaces the raw (DB-shape) attribute store wholesale, no casts
   * applied. Used by `Factory` (whose `definition()` already returns
   * DB-shape rows) and by the insert read-back path. Does NOT touch the
   * dirty-tracking snapshot; call `markPersisted()` after a save.
   */
  setRawAttributes(attributes: Record<string, any>): void {
    this.$state.attributes = { ...attributes };
  }

  /**
   * Marks the instance as persisted and resets dirty tracking, the
   * post-**insert** transition, used by `Factory`'s batched insert path
   * (which writes rows itself rather than going through `save()`). Sets
   * `wasRecentlyCreated`, and leaves `getChanges()` empty, for the same
   * reason `save()`'s insert branch does: see `getChanges()`.
   */
  markPersisted(): void {
    const state = this.$state;
    state.exists = true;
    state.wasRecentlyCreated = true;
    state.changes = {};
    this.syncOriginal();
  }

  /**
   * The casted (model-shape) value of an attribute; loaded relations,
   * declared computed accessors, and per-page appended values resolve here
   * too. Precedence: loaded relation → batched appended value → declared
   * accessor getter → cast column → raw value.
   */
  getAttribute(key: string): any {
    const state = this.$state;
    const ModelClass = this.constructor as typeof BaseModel;

    if (state.relations.has(key)) {
      return state.relations.get(key);
    }

    // `strictRelations`: a DECLARED relation that was never loaded is a
    // mistake, not an empty result. See `RelationNotLoadedError`. Guarded
    // on the key not also being a real column so a `withCount()` alias or
    // a column that happens to share a relation's name still reads
    // through. Checked before `computed`/accessors because a relation
    // name can't legally be either.
    if (
      ModelClass.strictRelations &&
      !Object.hasOwn(state.attributes, key) &&
      Object.hasOwn(ModelClass.relations, key)
    ) {
      throw new RelationNotLoadedError(ModelClass.name, key);
    }

    if (state.computed.has(key)) {
      return state.computed.get(key);
    }

    const accessor = ModelClass.accessors[key] as AccessorDefinition<any, any> | undefined;

    if (accessor) {
      return accessor.get(state.self);
    }

    const cast = ModelClass.casts[key] as Cast<any, any> | undefined;
    const raw = state.attributes[key];

    return cast ? cast.toModelType(raw) : raw;
  }

  /**
   * Sets an attribute, converting a model-shape value to its DB shape via
   * the column's cast. A declared accessor with a `set` handler routes
   * there instead (writing to real columns), matching Laravel's mutators.
   */
  setAttribute(key: string, value: any): void {
    const ModelClass = this.constructor as typeof BaseModel;
    const accessor = ModelClass.accessors[key] as AccessorDefinition<any, any> | undefined;

    if (accessor?.set) {
      accessor.set(this.$state.self, value);

      return;
    }

    const cast = ModelClass.casts[key] as Cast<any, any> | undefined;
    this.$state.attributes[key] = cast ? cast.toDatabaseType(value) : value;
  }

  /** True when this instance maps to a persisted DB row. */
  exists(): boolean {
    return this.$state.exists;
  }

  /** The primary-key value (raw DB shape). */
  getKey(): SqlBinding {
    return this.$state.attributes[(this.constructor as typeof BaseModel).primaryKeyColumn];
  }

  /**
   * Whether `key` may be set through a mass-assignment call, per this
   * model's `fillable`/`guarded` policy (Laravel's `isFillable()`):
   *
   *   - A non-empty `fillable` is an allow-list, only its members pass.
   *   - Otherwise `guarded` is a block-list, everything passes except its
   *     members (and `["*"]` blocks everything).
   *
   * The framework default (`fillable = []`, `guarded = []`) makes every
   * key fillable, so unprotected models behave exactly as before.
   */
  static isFillable(this: typeof BaseModel, key: string): boolean {
    if (this.fillable.length > 0) {
      return this.fillable.includes(key);
    }

    if (this.guarded.includes("*")) {
      return false;
    }

    return !this.guarded.includes(key);
  }

  /**
   * True when this model guards *everything*, an empty `fillable` and a
   * `guarded` that blocks every column (`["*"]`). A mass-assignment onto a
   * totally-guarded model throws `MassAssignmentError` instead of silently
   * dropping the disallowed key. Matches Laravel's `totallyGuarded()`.
   */
  static totallyGuarded(this: typeof BaseModel): boolean {
    return this.fillable.length === 0 && this.guarded.includes("*");
  }

  /**
   * Mass-assigns MODEL-shape attributes (each cast in), honoring
   * `fillable`/`guarded` (Laravel's `fill()`): a non-fillable key is
   * dropped, or throws `MassAssignmentError` if the model is totally
   * guarded. Marks assigned attributes dirty. Returns the instance.
   */
  fill(attributes: Record<string, any>): Model {
    const ModelClass = this.constructor as typeof BaseModel;

    for (const [key, value] of Object.entries(attributes)) {
      if (ModelClass.isFillable(key)) {
        this.setAttribute(key, value);
      } else if (ModelClass.totallyGuarded()) {
        throw new MassAssignmentError(ModelClass.name, key);
      }
    }

    return this.$state.self;
  }

  /**
   * Sets attributes bypassing the `fillable`/`guarded` policy, the
   * unguarded counterpart to `fill()`, for framework-internal paths (the
   * constructor's initial hydration of a `new Model({...})`) and callers
   * that have already vetted their input. Marks assigned attributes
   * dirty. Returns the instance.
   */
  forceFill(attributes: Record<string, any>): Model {
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }

    return this.$state.self;
  }

  /**
   * Whether `key`'s current value is, for dirty-tracking purposes, the
   * same as its snapshot value, Laravel's `originalIsEquivalent()`, and
   * the single comparison `getDirty()`/`isDirty()` are built on.
   *
   * A plain `Object.is` on the two DB-shape values is right for most
   * columns and wrong for three that matter:
   *
   *   - **Instants.** MySQL hands back `"2026-09-02 07:31:37"` for a value
   *     this framework wrote as `"2026-09-02T07:31:37.000Z"`. The same
   *     moment in two spellings is not a change, but `Object.is` says it
   *     is, so every `save()` after a read would rewrite every timestamp
   *     column (and fire `updated` for it).
   *   - **JSON.** `post.meta = { ...post.meta }` re-serialises to a string
   *     with the same contents; key order can still differ (`{a,b}` vs
   *     `{b,a}`), which is not a change either.
   *   - **Numeric round-trips.** MySQL/Postgres return `DECIMAL`/`BIGINT`
   *     columns as strings, so a row read back as `"1"` and re-assigned as
   *     `1` looks changed. See critical-database-mysql-postgres M3.
   *
   * The comparison is therefore layered: identity first (the common case,
   * no allocation), then, for a column carrying a `Cast`, equality of
   * the two *model-shape* values (which is what makes JSON, `DateTime`,
   * boolean and decimal columns compare by meaning rather than by
   * spelling), then instant equality for a declared temporal column
   * without a cast (`created_at`/`updated_at`), and finally Laravel's
   * numeric-string rule.
   *
   * A key absent from the snapshot is never equivalent: it has no
   * original to be equal to, so it counts as changed (this is what makes
   * every attribute of a `new Post({...})` dirty).
   */
  originalIsEquivalent(key: string): boolean {
    const { attributes, original } = this.$state;

    if (!(key in original)) {
      return false;
    }

    const current = attributes[key];
    const previous = original[key];

    if (Object.is(current, previous)) {
      return true;
    }

    if (current == null || previous == null) {
      return false;
    }

    const ModelClass = this.constructor as AnyModelClass;
    const cast = ModelClass.casts[key] as Cast<any, any> | undefined;

    if (cast) {
      return castedValuesAreEquivalent(cast, current, previous);
    }

    // No cast, but the model declares this column an instant (an
    // auto-managed `created_at`/`updated_at`): compare the two spellings
    // as moments rather than as text.
    if (ModelClass.temporalColumns().includes(key)) {
      return castedValuesAreEquivalent(DateTimeCast, current, previous);
    }

    return (
      isNumericLike(current) && isNumericLike(previous) && String(current) === String(previous)
    );
  }

  /**
   * The DB-shape attributes that differ from the last-synced snapshot,
   * exactly the columns the next `save()` would write. Values are DB-shape
   * (the persistence path consumes this directly); `getDirtyAttributes()`
   * is the cast-aware view of the same set.
   */
  getDirty(): Record<string, any> {
    const dirty: Record<string, any> = {};

    for (const key of Object.keys(this.$state.attributes)) {
      if (!this.originalIsEquivalent(key)) {
        dirty[key] = this.$state.attributes[key];
      }
    }

    return dirty;
  }

  /** `getDirty()` with each value run through its column's cast, model-shape. */
  getDirtyAttributes(): Record<string, any> {
    return this.castAll(this.getDirty());
  }

  /**
   * True when any attribute differs from the snapshot, or, given a key or
   * a list of keys, when **any** of those does (Laravel's `isDirty()`,
   * which is an OR across the list, not an AND).
   */
  isDirty(key?: string | string[]): boolean {
    return containsAny(this.getDirty(), key);
  }

  /** Inverse of `isDirty()`. */
  isClean(key?: string | string[]): boolean {
    return !this.isDirty(key);
  }

  /**
   * The last-synced value of an attribute (or the whole snapshot), run
   * through that column's cast, the **model-shape** counterpart to the
   * live `post.meta`, so a hook can compare the two without knowing
   * whether the column is cast:
   *
   *   if (post.wasChanged("meta")) {
   *     diff(post.getOriginal("meta"), post.meta);   // object vs object
   *   }
   *
   * `getRawOriginal()` returns the un-cast DB-shape value instead (the
   * JSON *string*, the `0`/`1`), which is what `getDirty()` and the
   * persistence path deal in.
   *
   * ## Why the return type is `any`
   *
   * It should be the cast's model type (`getOriginal("meta")` typing as
   * `Meta`), and under the current model surface it cannot be. The
   * obvious spelling, `getOriginal<K extends keyof this & string>(key:
   * K): this[K]`, is defeated by `CastedAttributes`: the finders return
   * a **mapped copy** of the instance type, and mapping re-binds the
   * polymorphic `this` inside every method signature to the original
   * class, whose declaration merge (`interface Post extends PostTable`)
   * carries DB types. The overload therefore resolves to `string` for a
   * `json<Meta>()` column and `number` for a `BooleanCast` one, the
   * exact opposite of what it claims, and a confidently-wrong type is
   * worse than an honest `any` (it would silently typecheck
   * `const s: string = post.getOriginal("meta")` against an object).
   *
   * `any` matches the sibling accessors (`getAttribute()`,
   * `getRawAttribute()`) for the same underlying reason. The fix is
   * structural and belongs to the model redesign
   * (`Model<A>()({ casts })`), where the attribute map is a real type
   * parameter the instance can reach instead of something recovered
   * post-hoc from a merged interface. Until then, annotate at the call
   * site: `const meta = post.getOriginal("meta") as Meta`.
   */
  getOriginal(key?: string): any {
    const { original } = this.$state;

    if (key === undefined) {
      return this.castAll(original);
    }

    const cast = (this.constructor as AnyModelClass).casts[key] as Cast<any, any> | undefined;

    return cast ? cast.toModelType(original[key]) : original[key];
  }

  /** The last-synced **DB-shape** value of an attribute (no cast), or the whole raw snapshot. */
  getRawOriginal(key?: string): any {
    const { original } = this.$state;

    return key === undefined ? { ...original } : original[key];
  }

  /**
   * The DB-shape attributes written by the LAST `save()` on this instance,
   * the post-save window `getDirty()` closes. This is what lets an
   * `updated`/`saved` hook react to a specific transition, which is
   * otherwise unknowable once `syncOriginal()` has run:
   *
   *   Order.on("updated", (order) => {
   *     if (order.wasChanged("status")) notify(order.getOriginal("status"));
   *   });
   *
   * **Empty after an INSERT** (matching Laravel): a create didn't *change*
   * anything, it brought the row into existence. `wasRecentlyCreated`
   * is the flag for that branch. Also empty on a never-saved instance.
   *
   * A `save()` that finds nothing dirty leaves this alone rather than
   * clearing it (Laravel's `performUpdate` only calls `syncChanges()` when
   * it actually issues the UPDATE), so a no-op re-save inside a hook can't
   * erase the changes the hook is there to inspect. `refresh()` clears it.
   */
  getChanges(): Record<string, any> {
    return { ...this.$state.changes };
  }

  /** `getChanges()` with each value run through its column's cast, model-shape. */
  getChangedAttributes(): Record<string, any> {
    return this.castAll(this.$state.changes);
  }

  /**
   * True when the last `save()` wrote any attribute, or, given a key or a
   * list of keys, **any** of those (Laravel's `wasChanged()`). The
   * post-save counterpart to `isDirty()`.
   */
  wasChanged(key?: string | string[]): boolean {
    return containsAny(this.$state.changes, key);
  }

  /**
   * Whether the last `save()` on this instance was an INSERT rather than
   * an UPDATE, Laravel's `$model->wasRecentlyCreated`, the way to tell
   * which branch `firstOrCreate()`/`updateOrCreate()` took:
   *
   *   const user = await User.firstOrCreate({ email });
   *   if (user.wasRecentlyCreated) await sendWelcome(user);
   *
   * Stays true across subsequent updates to the same in-memory instance
   * (the *creation* is still the last thing that happened to it from the
   * caller's point of view); `refresh()` resets it, as does re-reading the
   * row into a new instance.
   *
   * Read-only, and, like `exists`, a **reserved name**: a column called
   * `was_recently_created` is fine, but an attribute literally named
   * `wasRecentlyCreated` would be shadowed by this accessor.
   */
  get wasRecentlyCreated(): boolean {
    return this.$state.wasRecentlyCreated;
  }

  /**
   * Copies the current dirty set into the post-save `changes` record,
   * Laravel's `syncChanges()`. Called by `save()`/`restore()` immediately
   * BEFORE `syncOriginal()`, which is the only moment both windows are
   * open: after the write has landed, while the snapshot still holds the
   * pre-write values. Returns the instance.
   */
  syncChanges(): Model {
    const state = this.$state;
    state.changes = this.getDirty();

    return state.self;
  }

  /**
   * Throws away every unsaved change, restoring the attributes to the
   * last-synced snapshot, Laravel's `discardChanges()`. The escape hatch
   * for a `saving` hook that decides the write should not happen, and for
   * a failed validation pass that filled the instance before checking it.
   *
   * Also clears the post-save `changes` record: discarding puts the
   * instance back to "nothing has happened since the last sync", and a
   * lingering `wasChanged()` would contradict that. `wasRecentlyCreated`
   * is untouched. The row was still created.
   */
  discardChanges(): Model {
    const state = this.$state;
    state.attributes = { ...state.original };
    state.changes = {};

    return state.self;
  }

  /** Every entry of `values` run through its column's cast, the shared body of the model-shape views. */
  private castAll(values: Record<string, any>): Record<string, any> {
    const casts = (this.constructor as AnyModelClass).casts;
    const out: Record<string, any> = {};

    for (const [key, value] of Object.entries(values)) {
      const cast = casts[key] as Cast<any, any> | undefined;
      out[key] = cast ? cast.toModelType(value) : value;
    }

    return out;
  }

  /**
   * Persists the instance: an INSERT when it doesn't yet exist, otherwise
   * an UPDATE of only the dirty columns. Fires the same lifecycle events
   * as the static `create()`/`update()` (with the INSTANCE as payload),
   * stamps timestamps, and assigns a generated primary key on insert.
   * Returns the instance.
   *
   * ## Where the snapshot is synced (and why the update path is late)
   *
   * On the **update** path `syncChanges()` runs immediately after the
   * write, while the dirty window is still open, and `syncOriginal()`
   * runs only after `updated`/`saved` have fired, mirroring Laravel's
   * `finishSave()`. That ordering is what makes the past-tense hooks
   * useful: inside `updated`, `getChanges()`/`wasChanged("status")`
   * report what was just written AND `getOriginal("status")` still
   * reports the value it was written over, so a hook can compare the two:
   *
   *   Order.on("updated", (order) => {
   *     if (order.wasChanged("status")) {
   *       notify(order.getOriginal("status"), order.status);  // from → to
   *     }
   *   });
   *
   * Syncing before the events would collapse `getOriginal()` onto the new
   * value and make that comparison impossible to express. The cost is that
   * the instance still reads as dirty inside those hooks (the snapshot has
   * not moved yet), so a hook that calls `save()` on the same instance
   * re-issues the write rather than no-opping, don't; mutate in the
   * `-ing` hooks (`saving`/`updating`), which run before the write and
   * whose mutations are picked up by it.
   *
   * The **insert** path syncs before its events instead, because there is
   * no prior value for a hook to compare against: every attribute's
   * "original" is the value just inserted. Syncing early means a `created`
   * hook sees a clean instance, which is the truthful reading.
   */
  async save(): Promise<Model> {
    const ModelClass = this.constructor as typeof BaseModel;
    const state = this.$state;
    ModelClass.bootIfNotBooted();

    if (state.exists) {
      if (Object.keys(this.getDirty()).length === 0) {
        return state.self;
      }

      if (
        ModelClass.timestamps &&
        ModelClass.updatedAtColumn !== null &&
        this.getDirty()[ModelClass.updatedAtColumn] === undefined
      ) {
        this.setAttribute(ModelClass.updatedAtColumn, ModelClass.currentTimestamp());
      }

      await dispatchModelEvent(ModelClass, "saving", state.self as never);
      await dispatchModelEvent(ModelClass, "updating", state.self as never);

      const changed = this.getDirty();
      // `newModelQuery()`, not `query()`: persistence must not inherit
      // the read-side global scopes, or saving a trashed (or otherwise
      // scoped-out) instance silently updates zero rows.
      await (ModelClass.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>)
        .whereKey(this.getKey())
        .update(ModelClass.prepareWrite(changed));

      // Reads the dirty window while it is still open. See the docstring.
      this.syncChanges();
      await dispatchModelEvent(ModelClass, "updated", state.self as never);
      await dispatchModelEvent(ModelClass, "saved", state.self as never);
      this.syncOriginal();

      return state.self;
    }

    if (ModelClass.timestamps) {
      const now = ModelClass.currentTimestamp();

      if (
        ModelClass.createdAtColumn !== null &&
        state.attributes[ModelClass.createdAtColumn] === undefined
      ) {
        this.setAttribute(ModelClass.createdAtColumn, now);
      }

      if (
        ModelClass.updatedAtColumn !== null &&
        state.attributes[ModelClass.updatedAtColumn] === undefined
      ) {
        this.setAttribute(ModelClass.updatedAtColumn, now);
      }
    }

    await dispatchModelEvent(ModelClass, "saving", state.self as never);
    await assignGeneratedPrimaryKey(ModelClass, state.attributes);
    await dispatchModelEvent(ModelClass, "creating", state.self as never);

    if (ModelClass.incrementing) {
      state.attributes = await insertAndReadGeneratedId(ModelClass, state.attributes);
    } else {
      await (ModelClass.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>)
        .toBase()
        .insert(ModelClass.prepareWrite(state.attributes) as any);
    }

    state.exists = true;
    // An INSERT reports itself through `wasRecentlyCreated`, not through
    // `getChanges()`. A create didn't change anything, it brought the row
    // into being. Matches Laravel; see `getChanges()`.
    state.wasRecentlyCreated = true;
    state.changes = {};
    this.syncOriginal();
    await dispatchModelEvent(ModelClass, "created", state.self as never);
    await dispatchModelEvent(ModelClass, "saved", state.self as never);

    return state.self;
  }

  /** `fill()` then `save()`, the instance counterpart to the static `update()`. */
  async updateInstance(attributes: Record<string, any>): Promise<Model> {
    this.fill(attributes);

    return this.save();
  }

  /**
   * Deletes this instance's row. Routes through the model class's static
   * `delete()` so `SoftDeletes` (which overrides that static) applies,
   * an instance `delete()` on a soft-deleting model soft-deletes.
   */
  async deleteInstance(): Promise<void> {
    const ModelClass = this.constructor as typeof BaseModel;
    await ModelClass.delete(this.getKey(), this.$state.self);
    this.$state.exists = false;
  }

  /**
   * The soft-delete scope this model declares, or `undefined`, the
   * instance-side gate for `trashed()`/`restore()`/`forceDelete()`.
   */
  private softDeleteScope(): SoftDeleteScopeLike | undefined {
    const ModelClass = this.constructor as typeof BaseModel;
    ModelClass.bootIfNotBooted();

    return findSoftDeleteScope(ModelClass.scopes);
  }

  /**
   * Whether THIS instance is soft-deleted, Laravel's `trashed()`.
   * Reads the loaded attribute, so it reflects the row as of the last
   * read (call `refresh()` first if another process may have deleted it
   * since).
   *
   * Always `false` on a model that doesn't use soft deletes: the
   * question is meaningful there, and the answer is "no".
   */
  trashed(): boolean {
    const scope = this.softDeleteScope();

    if (!scope) {
      return false;
    }

    return this.getRawAttribute(scope.deletedAtColumn) != null;
  }

  /**
   * Un-deletes THIS instance, Laravel's instance `restore()`. Clears
   * `deleted_at` both in the database and on the loaded attributes, so
   * `trashed()` is immediately false without a `refresh()`.
   *
   * Fires `restoring` → update → `restored` with the instance as the
   * payload, matching the static `SoftDeletes.restore(id)`. Throws on a
   * model that doesn't soft-delete.
   */
  async restore(): Promise<Model> {
    const ModelClass = this.constructor as typeof BaseModel;
    const scope = this.softDeleteScope();

    if (!scope) {
      throw new Error(
        `restore(): ${ModelClass.name} does not use soft deletes — there is no deleted_at column to clear.`,
      );
    }

    const state = this.$state;
    await dispatchModelEvent(ModelClass, "restoring", state.self as never);
    await (ModelClass.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>)
      .whereKey(this.getKey())
      .update({ [scope.deletedAtColumn]: null });

    state.attributes[scope.deletedAtColumn] = null;
    state.exists = true;
    this.syncOriginal();
    // Set explicitly rather than via `syncChanges()`: the UPDATE above
    // wrote exactly one column, so any *other* attribute the caller had
    // dirtied was not written and must not be reported as changed.
    state.changes = { [scope.deletedAtColumn]: null };
    await dispatchModelEvent(ModelClass, "restored", state.self as never);

    return state.self;
  }

  /**
   * Permanently deletes THIS instance's row, even on a soft-deleting
   * model, Laravel's instance `forceDelete()`. Fires `deleting`/
   * `deleted` with the instance as the payload, like every other delete
   * path.
   *
   * On a model without soft deletes this is exactly `deleteInstance()`,
   * which makes it safe to call from code that shouldn't have to know
   * which policy the model uses.
   */
  async forceDelete(): Promise<void> {
    const ModelClass = this.constructor as typeof BaseModel;
    const state = this.$state;

    await dispatchModelEvent(ModelClass, "deleting", state.self as never);
    await (ModelClass.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>)
      .whereKey(this.getKey())
      .forceDelete();
    state.exists = false;
    await dispatchModelEvent(ModelClass, "deleted", state.self as never);
  }

  /**
   * Re-reads this row from the DB, replacing every attribute and the
   * dirty-tracking snapshot.
   *
   * Reads through `newModelQuery()` (no global scopes): you already hold
   * the instance, so a scope that would have hidden the row is not a
   * reason to refuse to re-read it. That's what makes `refresh()` work
   * on a trashed model, and it's what Laravel does too.
   */
  async refresh(): Promise<Model> {
    const ModelClass = this.constructor as typeof BaseModel;
    const state = this.$state;
    const fresh = (await (
      ModelClass.newModelQuery() as unknown as EloquentBuilder<Record<string, any>>
    )
      .whereKey(this.getKey())
      .first()) as Model | Record<string, any> | undefined;

    if (fresh !== undefined) {
      state.attributes = fresh instanceof BaseModel ? { ...fresh.toObject() } : { ...fresh };
      this.syncOriginal();
      // The instance now represents the row as the database has it, which
      // is the same position a freshly-hydrated one is in: nothing has
      // been changed by us, and nothing was created by us.
      state.changes = {};
      state.wasRecentlyCreated = false;
    }

    return state.self;
  }

  /**
   * A fresh, UNSAVED copy of this instance with the primary key and
   * timestamp columns stripped, Laravel's `replicate()`.
   *
   * Returns `this` (the polymorphic type), not the base `Model`: the copy
   * is constructed from `this.constructor`, so it really is the same
   * subclass, and typing it as `Model` would strip every declared
   * attribute from the result (`post.replicate().body` would not compile).
   */
  replicate(): this {
    const ModelClass = this.constructor as typeof BaseModel;
    const copy = { ...this.$state.attributes };
    delete copy[ModelClass.primaryKeyColumn];

    if (ModelClass.timestamps) {
      if (ModelClass.createdAtColumn !== null) {
        delete copy[ModelClass.createdAtColumn];
      }

      if (ModelClass.updatedAtColumn !== null) {
        delete copy[ModelClass.updatedAtColumn];
      }
    }

    const clone = new (ModelClass as unknown as new () => Model)();
    instanceState.get(clone)!.attributes = copy;

    return clone as this;
  }

  /** Copies attributes into the snapshot, the post-save/refresh dirty-tracking reset. */
  syncOriginal(): void {
    const state = this.$state;
    state.original = { ...state.attributes };
  }

  /** Sets a loaded relation on this instance (used by the eager loader and `load()`). Returns the instance. */
  setRelation(name: string, value: unknown): Model {
    this.$state.relations.set(name, value);

    return this.$state.self;
  }

  /**
   * Clears a loaded relation, so it reads back as not-loaded rather than
   * as a stale value, the counterpart to `setRelation()`.
   *
   * Used by `dissociate()` (and by `associate()` given a bare key): once
   * the foreign key has moved, the previously loaded owner is wrong, and
   * leaving it in place would make `post.author` contradict
   * `post.user_id`. Dropping it makes the next `load()` fetch the truth.
   */
  unsetRelation(name: string): Model {
    this.$state.relations.delete(name);

    return this.$state.self;
  }

  /** The loaded relation value, or `undefined` if it hasn't been loaded. */
  getRelation(name: string): unknown {
    return this.$state.relations.get(name);
  }

  /** Whether a relation has been loaded onto this instance. */
  relationLoaded(name: string): boolean {
    return this.$state.relations.has(name);
  }

  /**
   * Lazily loads relations onto this instance (batched via the eager
   * loader). Takes the same three forms as `EloquentBuilder.with()`,
   * names, dot paths, and a constraining map:
   *
   *   await post.load("author.team");
   *   await post.load({ comments: (q) => q.where("approved", 1) });
   */
  async load(...names: [EagerLoadRequest] | string[]): Promise<Model> {
    const ModelClass = this.constructor as unknown as ModelClass;
    await loadRelations(ModelClass, [this.$state.self], normalizeLoadArgs(names));

    return this.$state.self;
  }

  /**
   * Like `load()`, but skips any relation already loaded, Laravel's
   * `loadMissing()`. A cheap guard against re-querying a relation a prior
   * `with()`/`load()` already attached.
   *
   * The skip is applied **per path segment**, not per whole path, so
   * `loadMissing("author.team")` on a post that already has its author
   * reuses that author and issues only the `team` query.
   */
  async loadMissing(...names: [EagerLoadRequest] | string[]): Promise<Model> {
    const ModelClass = this.constructor as unknown as ModelClass;
    await loadRelations(ModelClass, [this.$state.self], normalizeLoadArgs(names), {
      missingOnly: true,
    });

    return this.$state.self;
  }

  /**
   * Attaches a named, non-column value onto this instance, an "appended
   * attribute". The value then reads back off the instance
   * (`instance.name`) and is available to a `Resource` via
   * `whenAppended(name)`, but is deliberately NOT part of `toJSON()`'s
   * default column serialization (shaping the wire format is the
   * resource's job, not the model's). Alias-friendly form of
   * `setAppended()`, for a value the caller already has in hand:
   *
   *   post.append("special_thing", computeSpecialThing(post));
   *   // in the resource: special: this.whenAppended("special_thing")
   *
   * The common case is a per-page batched value (aggregate counts,
   * current-user flags) that a per-row computation couldn't derive
   * without an N+1.
   */
  append(name: string, value: unknown): Model {
    return this.setAppended(name, value);
  }

  /** Attaches a pre-computed appended value onto this instance. See `append()`. */
  setAppended(name: string, value: unknown): Model {
    this.$state.computed.set(name, value);

    return this.$state.self;
  }

  /** Whether an appended value has been attached onto this instance. */
  hasAppended(name: string): boolean {
    return this.$state.computed.has(name);
  }

  /** An attached appended value, or `undefined` if none was set for `name`. */
  getAppended(name: string): unknown {
    return this.$state.computed.get(name);
  }

  /** Plain DB-shape object of every attribute (no casts applied, no relations). */
  toObject(): Record<string, any> {
    return { ...this.$state.attributes };
  }

  /**
   * The attribute-casting proxy wrapping this instance, the value callers
   * actually hold (finders/builder terminals return it), as opposed to the
   * raw target `this` inside an instance method. An instance method's `this`
   * is bound to the underlying target, not the proxy, so reading cast
   * columns off `this` won't resolve (this is why `Post.can()` passes
   * `this.toObject()` to the gate). A subclass that constructs an object
   * from this instance, most notably `toJsonResource()`, whose `Resource`
   * reads `this.model.someCastColumn`, must hand it `this.self` so those
   * reads go through the casting proxy.
   */
  protected get self(): this {
    return this.$state.self as this;
  }

  /**
   * This model's default `Resource` instance, or `undefined` when the model
   * declares none. The base returns `undefined`; a model opts in by
   * overriding to return its resource, constructed with the casting proxy:
   *
   *   override toJsonResource(): PostResource {
   *     return new PostResource(this.self);
   *   }
   *
   * Deliberately a single overridable method (return type IS the
   * declaration) rather than a type-only marker + hook split, same
   * reasoning as `factory()`: no framework work wraps the construction, so
   * a split would be pure ceremony. The model -> resource -> model import
   * cycle this creates in an app is safe for the same reason `factory()`'s
   * is: the resource is referenced at call time, never as a static field
   * initializer. Return type is the structural `ModelResource` so
   * `@mahiframework/database` needn't depend on `@mahiframework/http`; a model
   * narrows it to its concrete resource via its own declaration merge
   * (`interface Post { toJsonResource(): PostResource }`). Consumed by
   * `Resource`'s output normalization, which turns a loaded relation model
   * into its resource's JSON automatically.
   */
  toJsonResource(): ModelResource | undefined {
    return undefined;
  }

  /** True when the given key is a stored attribute (used by the proxy traps). */
  hasAttribute(key: string): boolean {
    return key in this.$state.attributes;
  }

  /** Removes a stored attribute (used by the proxy's `deleteProperty` trap). */
  unsetAttribute(key: string): void {
    delete this.$state.attributes[key];
  }

  /**
   * Model-shape serialization honoring `hidden`/`visible`, with loaded
   * relations serialized recursively, what `JSON.stringify(instance)`
   * (and therefore any JSON response) uses.
   */
  toJSON(): Record<string, any> {
    const ModelClass = this.constructor as typeof BaseModel;
    const state = this.$state;
    const hidden = new Set(ModelClass.hidden);
    const visible = ModelClass.visible;
    const include = (key: string): boolean =>
      visible.length > 0 ? visible.includes(key) : !hidden.has(key);

    const out: Record<string, any> = {};

    for (const key of Object.keys(state.attributes)) {
      if (include(key)) {
        out[key] = this.getAttribute(key);
      }
    }

    // Declared computed attributes listed in `appends`, Laravel's
    // `$appends`. Serialized through the accessor getter.
    for (const key of ModelClass.appends) {
      if (include(key) && !(key in out)) {
        out[key] = this.getAttribute(key);
      }
    }

    for (const [name, value] of state.relations) {
      if (!include(name)) {
        continue;
      }

      out[name] = serializeRelation(value);
    }

    return out;
  }

  /**
   * The **query-side** relation namespace, Laravel's `$post->comments()`.
   * One nullary method per relation declared in `static relations`, each
   * returning that relation's builder scoped to THIS row (the related
   * model's own builder, so global scopes and any custom `Builder`
   * subclass apply, and it chains like any other query):
   *
   *   post.relations.author()                       // BuilderOf<User>
   *   await post.relations.comments().count();       // one COUNT query
   *   await post.relations.comments().where("approved", 1).get();
   *
   * Distinct from the loaded value accessor `post.comments` (a
   * `Collection` populated by `with()`/`load()`/`loadMissing()`). This is
   * always a fresh query, `post.comments` is the already-fetched result.
   * Built lazily from `static relations` and cached per instance; each
   * relation is dispatched through the matching generic instance helper
   * (`this.belongsTo(...)`/`this.hasMany(...)`/...) for its `type`.
   *
   * A declared `morphTo` yields a `MorphToBuilder` rather than an
   * `EloquentBuilder`, its target model isn't known until the
   * discriminant is read, so there's no `TRow` to parameterise on. The
   * typed `RelationBuilders` mapping narrows per name, so callers see the
   * right one; this runtime signature is the union of both.
   */
  get relations(): Record<
    string,
    () => EloquentBuilder<Record<string, any>> | MorphToBuilder<Model>
  > {
    const state = this.$state;

    if (state.relationBuilders) {
      return state.relationBuilders;
    }

    const self = state.self;
    const definitions = (this.constructor as typeof BaseModel).relations;
    const builders: Record<
      string,
      () => EloquentBuilder<Record<string, any>> | MorphToBuilder<Model>
    > = {};

    for (const [name, definition] of Object.entries(definitions)) {
      builders[name] = () => buildRelationBuilder(self, name, definition);
    }

    state.relationBuilders = builders;

    return builders;
  }

  /**
   * Many-to-one from an instance: the foreign key lives on THIS row.
   * Returns the related model's builder scoped to the single owner,
   * call `.first()` to resolve it (or declare it in `static relations`
   * and use `with()`/`load()` for the loaded-accessor form).
   */
  belongsTo<R extends typeof BaseModel>(
    related: R,
    options: BelongsToOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const ownerKey = options.ownerKey ?? related.primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.where(ownerKey, this.getRawAttribute(options.foreignKey));

    return builder as EloquentBuilder<any>;
  }

  /** One-to-many from an instance: the foreign key lives on the RELATED row. */
  hasMany<R extends typeof BaseModel>(
    related: R,
    options: HasManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this.constructor as typeof BaseModel).primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.where(options.foreignKey, this.getRawAttribute(localKey));

    return builder as EloquentBuilder<any>;
  }

  /** One-to-one from an instance, `hasMany` with a `.first()` at the call site. */
  hasOne<R extends typeof BaseModel>(
    related: R,
    options: HasOneOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    return this.hasMany(related, options);
  }

  /** Many-to-many from an instance through a pivot table. */
  belongsToMany<R extends typeof BaseModel>(
    related: R,
    options: BelongsToManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this.constructor as typeof BaseModel).primaryKeyColumn;

    return buildPivotQuery(related, {
      pivotTable: options.pivotTable,
      thisPivotKey: options.foreignPivotKey,
      relatedPivotKey: options.relatedPivotKey,
      localValue: this.getRawAttribute(localKey),
      relatedKey: options.relatedKey ?? related.primaryKeyColumn,
      withPivot: options.withPivot,
      withTimestamps: options.withTimestamps,
    }) as EloquentBuilder<any>;
  }

  /**
   * Polymorphic many-to-many from an instance, the **morphed** side.
   * See `relations.ts`'s `MorphToManyOptions` for the pivot layout and
   * the `type`-defaulting asymmetry against `morphedByMany`.
   */
  morphToMany<R extends typeof BaseModel>(
    related: R,
    options: MorphToManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const owner = this.constructor as typeof BaseModel;
    const localKey = options.localKey ?? owner.primaryKeyColumn;

    return buildPivotQuery(related, {
      pivotTable: options.pivotTable,
      thisPivotKey: options.morphId,
      relatedPivotKey: options.relatedPivotKey,
      localValue: this.getRawAttribute(localKey),
      relatedKey: options.relatedKey ?? related.primaryKeyColumn,
      morphType: options.morphType,
      // The pivot discriminates THIS model. See MorphToManyOptions.
      morphValue: options.type ?? owner.morphAlias(),
      withPivot: options.withPivot,
      withTimestamps: options.withTimestamps,
    }) as EloquentBuilder<any>;
  }

  /**
   * Polymorphic many-to-many from an instance, the **inverse** side.
   * See `relations.ts`'s `MorphedByManyOptions`; note `type` names the
   * RELATED model here, not this one.
   */
  morphedByMany<R extends typeof BaseModel>(
    related: R,
    options: MorphedByManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const localKey = options.localKey ?? (this.constructor as typeof BaseModel).primaryKeyColumn;

    return buildPivotQuery(related, {
      pivotTable: options.pivotTable,
      thisPivotKey: options.foreignPivotKey,
      relatedPivotKey: options.morphId,
      localValue: this.getRawAttribute(localKey),
      relatedKey: options.relatedKey ?? related.primaryKeyColumn,
      morphType: options.morphType,
      // The pivot discriminates the RELATED model on this side.
      morphValue: options.type ?? related.morphAlias(),
      withPivot: options.withPivot,
      withTimestamps: options.withTimestamps,
    }) as EloquentBuilder<any>;
  }

  /** Polymorphic one-to-many from an instance. See the static `morphMany()`. */
  morphMany<R extends typeof BaseModel>(
    related: R,
    options: MorphManyOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const owner = this.constructor as typeof BaseModel;
    const localKey = options.localKey ?? owner.primaryKeyColumn;
    const type = options.type ?? owner.morphAlias();
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.where(options.morphType, type).where(options.morphId, this.getRawAttribute(localKey));

    return builder as EloquentBuilder<any>;
  }

  /** Polymorphic one-to-one from an instance, `morphMany` with a `.first()` at the call site. */
  morphOne<R extends typeof BaseModel>(
    related: R,
    options: MorphOneOptions<Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    return this.morphMany(related, options);
  }

  /**
   * Polymorphic inverse from an instance (`morphTo`), resolves the parent
   * model by this row's `morphType` discriminant. Returns the resolved
   * instance (a union of the mapped models' instance types) or `undefined`.
   * See the static `morphTo()`.
   */
  async morphTo<TTypes extends Record<string, () => typeof BaseModel>>(
    options: MorphToOptions<Record<string, any>, TTypes>,
  ): Promise<InstanceType<ReturnType<TTypes[keyof TTypes]>> | undefined> {
    const typeValue = this.getRawAttribute(options.morphType);
    const idValue = this.getRawAttribute(options.morphId);

    if (typeValue == null || idValue == null) {
      return undefined;
    }

    const related = resolveMorphType(typeValue as string, options.types);

    if (!related) {
      return undefined;
    }

    const ownerKey = options.ownerKey ?? related.primaryKeyColumn;
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;

    return (await builder.where(ownerKey, idValue).first()) as
      InstanceType<ReturnType<TTypes[keyof TTypes]>> | undefined;
  }

  /**
   * The deferred, chainable form of `morphTo()`, returns a
   * `MorphToBuilder` rather than resolving immediately, so per-type
   * constraints and soft-delete variants can be applied before the query
   * runs:
   *
   *   await comment
   *     .morphToBuilder({ morphType: "commentable_type", morphId: "commentable_id" })
   *     .constrain({ post: (q) => q.where("published", 1) })
   *     .first();
   *
   * This is what a declared `morphTo` relation's `relations` accessor
   * returns. Prefer declaring the relation and using
   * `comment.relations.commentable()`; this is the undeclared equivalent,
   * mirroring how `morphMany()` relates to a declared `morphMany`.
   */
  morphToBuilder<TTypes extends Record<string, () => typeof BaseModel>>(
    options: MorphToOptions<Record<string, any>, TTypes>,
    relationName?: string,
  ): MorphToBuilder<InstanceType<ReturnType<TTypes[keyof TTypes]>>> {
    return new MorphToBuilder(this.$state.self, options as any, relationName);
  }

  /** Has-many-through from an instance. See the static `hasManyThrough()`. */
  hasManyThrough<R extends typeof BaseModel>(
    related: R,
    options: HasManyThroughOptions<Record<string, any>, Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    const through = options.through() as unknown as typeof BaseModel;
    const localKey = options.localKey ?? (this.constructor as typeof BaseModel).primaryKeyColumn;
    const secondLocalKey = options.secondLocalKey ?? through.primaryKeyColumn;
    const localValue = this.getRawAttribute(localKey);
    const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
    builder.whereIn(options.secondKey, (q) =>
      q.table(through.table).select(secondLocalKey).where(options.firstKey, "=", localValue),
    );

    return builder as EloquentBuilder<any>;
  }

  /** Has-one-through from an instance, `hasManyThrough` with a `.first()` at the call site. */
  hasOneThrough<R extends typeof BaseModel>(
    related: R,
    options: HasOneThroughOptions<Record<string, any>, Record<string, any>, Record<string, any>>,
  ): EloquentBuilder<any> {
    return this.hasManyThrough(related, options);
  }
}

/**
 * Whether `value` is a class constructor rather than an ordinary method.
 *
 * Used by the instance proxy to decide what must not be bound. Class
 * constructors are the only functions reachable through a model instance
 * that are not methods, `constructor` itself, plus anything a model
 * stores as a static class reference, and binding one destroys its
 * static side (see the proxy's `get` trap).
 *
 * `class X {}` compiles to a function whose source starts with `class`,
 * which is the check V8's own `util.inspect` uses. It is exact for real
 * classes, and the fallback (treating something as a method) is the
 * pre-existing behaviour, so a false negative is never worse than before.
 */
function isClassConstructor(value: (...args: any[]) => any): boolean {
  return Function.prototype.toString.call(value).startsWith("class ");
}

/**
 * The `Proxy` handler wrapping every `Model` instance so attribute access
 * casts transparently (`post.published` reads the DB `0`/`1` as a
 * `boolean`; assigning a `boolean` writes back the int) while real
 * methods (`save()`, `fill()`, ...) and loaded relations still resolve.
 * A small, documented use of a `Proxy`, the payoff (Eloquent-style
 * attribute ergonomics with full type safety) is exactly the case the
 * "no magic" guideline was never meant to forbid.
 *
 * Methods are bound to the **proxy (receiver)**, not the target, so that
 * reading a cast column off `this` inside a method (`this.published`)
 * routes back through this handler and resolves the cast value. Binding
 * to the target instead would leave `this.title` undefined at runtime
 * while the declaration merge says otherwise. Per-instance state lives in
 * a `WeakMap` keyed by both
 * target and proxy, so `this.$state` resolves whichever `this` is.
 *
 * The `constructor` property is deliberately returned UNBOUND (the raw
 * class), so `Object.getPrototypeOf(instance).constructor` and
 * `instance.constructor.table` still reach the model class's statics.
 * A bound function would lose them.
 */
const MODEL_PROXY_HANDLER: ProxyHandler<Model> = {
  get(target, prop, receiver) {
    if (typeof prop !== "string") {
      return Reflect.get(target, prop, target);
    }

    if (prop in target) {
      const value = Reflect.get(target, prop, target);

      if (typeof value !== "function") {
        return value;
      }

      // A class constructor must NOT be bound. `Function.prototype.bind`
      // returns an exotic wrapper whose prototype is the bound target's
      // *prototype chain entry*, not the class itself, so
      // `instance.constructor` came back as something that is neither
      // `Post` nor carries any of its statics: `.table`,
      // `.primaryKeyColumn` and `.morphAlias()` all read `undefined`,
      // silently, on the proxy every caller actually holds. Any code
      // doing `this.constructor as typeof Model` on a proxied instance
      // therefore addressed the wrong class. Constructors have no
      // private-field access to preserve (that is what the binding is
      // for), so they are handed back untouched.
      if (isClassConstructor(value)) {
        return value;
      }

      // Everything else binds to the RECEIVER, the proxy, when that is
      // what the caller holds. This is what makes `this` inside an
      // instance method read casted attributes (`this.published` as a
      // `boolean`). Falls back to the target when there is no receiver.
      return value.bind(receiver ?? target);
    }

    if (target.relationLoaded(prop)) {
      return target.getRelation(prop);
    }

    if (target.hasAppended(prop)) {
      return target.getAppended(prop);
    }

    return target.getAttribute(prop);
  },
  set(target, prop, value) {
    if (typeof prop === "string" && !(prop in target)) {
      target.setAttribute(prop, value);

      return true;
    }

    return Reflect.set(target, prop, value, target);
  },
  has(target, prop) {
    if (typeof prop === "string" && target.hasAttribute(prop)) {
      return true;
    }

    return Reflect.has(target, prop);
  },
  ownKeys(target) {
    return Object.keys(target.toObject());
  },
  getOwnPropertyDescriptor(target, prop) {
    if (typeof prop === "string" && target.hasAttribute(prop)) {
      return { enumerable: true, configurable: true, value: target.getAttribute(prop) };
    }

    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
  deleteProperty(target, prop) {
    if (typeof prop === "string" && target.hasAttribute(prop)) {
      target.unsetAttribute(prop);

      return true;
    }

    return Reflect.deleteProperty(target, prop);
  },
};

/**
 * Dispatches a single `RelationDefinition` for `instance` through the
 * matching generic instance relation helper, returning the relation's
 * builder scoped to that row, the runtime behind the `relations`
 * namespace getter.
 *
 * Returns a `MorphToBuilder` for `morphTo` and an `EloquentBuilder` for
 * everything else. The union is what `RelationBuilders` mirrors at the
 * type level, so `comment.relations.commentable()` is statically known to
 * be the former.
 *
 * The `EloquentBuilder` branch then has its relation **write** methods
 * attached (`attach()`/`associate()`/`create()`, per relation kind) by
 * `attachRelationWrites()`. They are added to the builder the relation
 * already produced rather than swapping in a write-capable subclass,
 * because that builder may be the related model's own custom `Builder`.
 * See `relationship-writes.ts`'s docstring. `morphTo` needs no such
 * step: `MorphToBuilder` declares its own `associate()`/`dissociate()`.
 *
 * `relationName` is threaded through solely so `associate()`/
 * `dissociate()` can set and clear the *loaded* relation under the name
 * the caller knows it by.
 *
 * NB: `definition.related()` is resolved per-case, not up front.
 * `morphTo` is the one member with no `related` thunk.
 */
function buildRelationBuilder(
  instance: Model,
  relationName: string,
  definition: RelationDefinition,
): EloquentBuilder<Record<string, any>> | MorphToBuilder<Model> {
  // `morphTo` first: it is the one member with no `related` thunk, and
  // the only one whose accessor isn't an `EloquentBuilder` to write onto.
  if (definition.type === "morphTo") {
    return instance.morphToBuilder(definition.options as any, relationName);
  }

  const builder = buildRelationReadBuilder(instance, definition);

  return attachRelationWrites(instance, relationName, definition, builder);
}

/** The read-side builder for one relation, the per-`type` dispatch `buildRelationBuilder()` wraps. */
function buildRelationReadBuilder(
  instance: Model,
  definition: Exclude<RelationDefinition, { type: "morphTo" }>,
): EloquentBuilder<Record<string, any>> {
  switch (definition.type) {
    case "belongsTo":
      return instance.belongsTo(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "hasMany":
      return instance.hasMany(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "hasOne":
      return instance.hasOne(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "belongsToMany":
      return instance.belongsToMany(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "morphMany":
      return instance.morphMany(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "morphOne":
      return instance.morphOne(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "morphToMany":
      return instance.morphToMany(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "morphedByMany":
      return instance.morphedByMany(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "hasManyThrough":
      return instance.hasManyThrough(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
    case "hasOneThrough":
      return instance.hasOneThrough(
        definition.related() as unknown as typeof BaseModel,
        definition.options as any,
      );
  }
}

/**
 * Applies `intermediate`'s global scopes to a **subquery over that
 * model's own table**, the fix for through/pivot links that silently
 * ignored them.
 *
 * A `hasManyThrough` compiles to `related.second_key IN (SELECT
 * second_local_key FROM through WHERE first_key = ?)`, and that inner
 * `SELECT` is built as a bare `QueryBuilder` over `through.table`. It
 * never went through `Through.query()`, so a soft-deleted (or otherwise
 * scoped-out) *through* row still linked its related rows to the parent.
 * A deleted `User` kept their `Country`'s `Post`s attached, which is
 * exactly the outcome soft-deleting the `User` was meant to prevent. The
 * same applies to a pivot with its own model and scopes.
 *
 * Scopes are written for an `EloquentBuilder`, so a throwaway one is
 * built for `intermediate` and its accumulated where-tree merged into
 * the subquery as a single group, the same merge `where(callback)` uses.
 * Models with no scopes (the common case, and every pivot table without
 * a model) add nothing and emit identical SQL to before.
 */
function applyIntermediateScopes(
  subquery: QueryBuilder<Record<string, any>>,
  intermediate: typeof BaseModel,
): void {
  intermediate.bootIfNotBooted();

  if (intermediate.scopes.length === 0) {
    return;
  }

  const scoped = intermediate.query() as unknown as EloquentBuilder<Record<string, any>>;
  const wheres = scoped.toBase().getWheres();

  if (wheres.length > 0) {
    subquery.pushWhereGroup("and", false, wheres);
  }
}

/**
 * The correlated builder behind `hasManyThrough()`/`hasOneThrough()`:
 * the related model's own scoped builder, narrowed to the rows reachable
 * through `options.through()` from this row.
 *
 * Shared by both statics because they differ only in intent (`.first()`
 * vs `.get()`), never in the SQL, and because the through model's
 * global scopes have to be applied in exactly one place to stay
 * consistent (see `applyIntermediateScopes()`).
 */
function throughBuilder(
  model: typeof BaseModel,
  related: typeof BaseModel,
  row: Record<string, any>,
  options: {
    through: () => typeof BaseModel;
    firstKey: string;
    secondKey: string;
    localKey?: string;
    secondLocalKey?: string;
  },
): any {
  const through = options.through();
  const localKey = options.localKey ?? model.primaryKeyColumn;
  const secondLocalKey = options.secondLocalKey ?? through.primaryKeyColumn;
  const localValue = row[localKey];

  const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
  builder.whereIn(options.secondKey, (q) => {
    q.table(through.table).select(secondLocalKey).where(options.firstKey, "=", localValue);
    applyIntermediateScopes(q, through);
  });

  return builder;
}

/**
 * The pivot-relation shape, normalised across `belongsToMany`,
 * `morphToMany` and `morphedByMany`. The three differ only in which
 * pivot column points where and whether a discriminant is involved, so
 * they all funnel through `buildPivotQuery()` rather than repeating the
 * compilation three times.
 */
interface PivotQuerySpec {
  pivotTable: string;
  /** Pivot column pointing at THIS (declaring) model. */
  thisPivotKey: string;
  /** Pivot column pointing at the RELATED model. */
  relatedPivotKey: string;
  /** This row's key value, which `thisPivotKey` is matched against. */
  localValue: unknown;
  /** Column on the RELATED table `relatedPivotKey` points at. */
  relatedKey: string;
  /** Discriminant column on the pivot, for the polymorphic variants. */
  morphType?: string;
  /** Discriminant value to filter the pivot by. Which SIDE it names differs per relation. See the option interfaces. */
  morphValue?: string;
  withPivot?: string[];
  withTimestamps?: boolean;
}

/**
 * Builds the related model's builder for a pivot-backed relation, scoped
 * to one row.
 *
 * Two compilations, chosen by whether pivot columns were requested:
 *
 * - **No pivot columns**, a subquery (`where id in (select ... from
 *   pivot where ...)`). Keeps the result rows exactly the related
 *   model's, with no join-multiplied duplicates and no ambiguous column
 *   names, and leaves the related model's global scopes and custom
 *   builder untouched. This is the long-standing behaviour and stays the
 *   default.
 * - **Pivot columns requested**, an inner join projecting
 *   `pivot.{col} as pivot__{col}`, because the values have to travel back
 *   with the row. `select("{related}.*")` keeps the related model's own
 *   columns unambiguous.
 *
 * The join form is strictly opt-in: a caller who never says `withPivot`
 * sees no change in emitted SQL.
 */
function buildPivotQuery(
  related: typeof BaseModel,
  spec: PivotQuerySpec,
): EloquentBuilder<Record<string, any>> {
  const builder = related.query() as unknown as EloquentBuilder<Record<string, any>>;
  const columns = pivotColumns(spec);

  if (columns.length === 0) {
    builder.whereIn(spec.relatedKey, (q) => {
      q.table(spec.pivotTable)
        .select(spec.relatedPivotKey)
        .where(spec.thisPivotKey, "=", spec.localValue as any);

      if (spec.morphType) {
        q.where(spec.morphType, "=", spec.morphValue as any);
      }
    });

    return builder;
  }

  builder
    .join(spec.pivotTable, (join) => {
      join.onRef(
        `${spec.pivotTable}.${spec.relatedPivotKey}`,
        "=",
        `${related.table}.${spec.relatedKey}`,
      );
      join.on(`${spec.pivotTable}.${spec.thisPivotKey}`, spec.localValue as any);

      if (spec.morphType) {
        join.on(`${spec.pivotTable}.${spec.morphType}`, spec.morphValue as any);
      }
    })
    .select(`${related.table}.*`, ...pivotSelections(spec.pivotTable, columns));

  return builder;
}

/**
 * Resolves a `morphTo` discriminant value to the model class it names,
 * the single place the local-`types`-then-global-map precedence lives, so
 * the static helper, the instance helper and the eager loader can't
 * disagree about it.
 *
 * Local `types` wins: it's declared on the relation itself, so it's the
 * more specific statement, and it's also what carries the compile-time
 * union. The global map is the fallback, which is what lets a relation
 * omit `types` entirely and still resolve.
 *
 * Returns `undefined` for an unresolvable discriminant rather than
 * throwing. A `*_type` value is *data*: a stale or unknown one should
 * behave like a dangling foreign key (no parent), not crash a query that
 * merely read the row.
 */
/**
 * Creates a row and, on a unique-constraint collision, re-reads the row
 * that beat us to it. The read-then-insert race guard shared by
 * `firstOrCreate()`/`updateOrCreate()`. A module-level helper (not a
 * private static) so it stays off the class's public type, keeping
 * `typeof Subclass` assignable to `typeof BaseModel`.
 */
async function createOrRecoverFromCollision(
  modelClass: typeof BaseModel,
  attributes: Record<string, any>,
  payload: Record<string, any>,
): Promise<Model> {
  try {
    return (await modelClass.create(payload)) as unknown as Model;
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) {
      throw error;
    }

    const winner = (await modelClass.matching(attributes).first()) as unknown as Model | undefined;

    if (winner === undefined) {
      throw error;
    }

    return winner;
  }
}

/** The declared soft-delete scope's constructor for a model, for `withoutGlobalScope()`. Throws when the model doesn't soft-delete. */
function softDeleteScopeClassOf(modelClass: typeof BaseModel): new (...args: any[]) => GlobalScope {
  modelClass.bootIfNotBooted();
  const scope = findSoftDeleteScope(modelClass.scopes);

  if (!scope) {
    throw new Error(
      `${modelClass.name} does not use soft deletes — configure \`softDeletes\` to use withTrashed()/onlyTrashed().`,
    );
  }

  return (scope as object).constructor as new (...args: any[]) => GlobalScope;
}

export function resolveMorphType(
  typeValue: string,
  types?: Record<string, () => typeof BaseModel>,
): typeof BaseModel | undefined {
  const thunk = types?.[typeValue];

  if (thunk) {
    return thunk();
  }

  return Relation.getMorphedModel(typeValue);
}

/**
 * Normalises `load()`/`loadMissing()`'s arguments into one
 * `EagerLoadRequest`, so both accept varargs names/dot paths *and* a
 * single constraining map without the callers branching.
 */
function normalizeLoadArgs(args: [EagerLoadRequest] | string[]): EagerLoadRequest {
  return isConstraintMap(args[0]) ? (args[0] as EagerLoadRequest) : (args as string[]);
}

/**
 * `true` when `record` has any entry at all (no `key`), the named entry
 * (`key: string`), or **any** of the named entries (`key: string[]`),
 * the shared body of `isDirty()`/`wasChanged()`, whose Laravel semantics
 * for a list are OR, not AND.
 */
function containsAny(record: Record<string, any>, key?: string | string[]): boolean {
  if (key === undefined) {
    return Object.keys(record).length > 0;
  }

  if (Array.isArray(key)) {
    return key.some((k) => k in record);
  }

  return key in record;
}

/**
 * `true` for a value that is (or spells) a finite number, the guard for
 * Laravel's numeric-string rule in `originalIsEquivalent()`, which treats
 * a column read back as `"1"` and re-assigned as `1` as unchanged.
 * Deliberately excludes booleans (`Number(true)` is `1`, but a `true`
 * that replaced a `1` in a column with no boolean cast is a real change
 * the caller should see) and blank strings (`Number("")` is `0`).
 */
function isNumericLike(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "bigint") {
    return true;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }

  return Number.isFinite(Number(value));
}

/**
 * Compares two DB-shape values through `cast`'s **model** side, the
 * "same meaning, different spelling" test `originalIsEquivalent()` needs
 * for JSON, `DateTime`, boolean and decimal columns.
 *
 * Model values are compared by `Object.is` first (primitives: booleans,
 * decimal strings, numbers), then by `valueOf()` for the wrapper types
 * that define one (`DateTime`, `Date`, both reduce to an epoch
 * millisecond count, which is exactly the equality wanted), and finally
 * structurally via a canonical JSON encoding for objects and arrays.
 *
 * A cast that throws on a malformed stored value (`JSON.parse` on a
 * column someone wrote by hand) must not take `save()` down with it. An
 * un-decodable value is reported as *not* equivalent, i.e. as a change,
 * which is the safe direction: the write still happens.
 */
function castedValuesAreEquivalent(
  cast: Cast<any, any>,
  current: unknown,
  previous: unknown,
): boolean {
  let a: unknown;
  let b: unknown;
  try {
    a = cast.toModelType(current);
    b = cast.toModelType(previous);
  } catch {
    return false;
  }

  if (Object.is(a, b)) {
    return true;
  }

  if (a == null || b == null) {
    return false;
  }

  if (typeof a === "object" && typeof b === "object") {
    const aValue = (a as { valueOf(): unknown }).valueOf();
    const bValue = (b as { valueOf(): unknown }).valueOf();

    // `valueOf()` on a plain object returns the object itself, so this
    // only fires for the wrappers that define a primitive reduction.
    if (aValue !== a || bValue !== b) {
      return Object.is(aValue, bValue);
    }

    return canonicalJson(a) === canonicalJson(b);
  }

  return false;
}

/**
 * A stable JSON encoding, object keys sorted at every depth, so two
 * structurally equal values compare equal regardless of the key order
 * their serialisation happened to use. `{a:1,b:2}` and `{b:2,a:1}` are
 * the same JSON document, and re-assigning one over the other is not a
 * change worth writing.
 *
 * Returns a unique, never-matching sentinel for a value JSON cannot
 * encode (a cycle, a `BigInt`), which falls out as "not equivalent".
 */
function canonicalJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }

      const sorted: Record<string, unknown> = {};

      for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
        sorted[key] = (entry as Record<string, unknown>)[key];
      }

      return sorted;
    });
  } catch {
    return `\u0000uncomparable:${String(Math.random())}`;
  }
}

/** Serializes a loaded relation value (instance / instance[] / Collection / plain) for `toJSON()`. */
function serializeRelation(value: unknown): unknown {
  if (value instanceof Collection) {
    return value.toArray().map(serializeRelation);
  }

  if (Array.isArray(value)) {
    return value.map(serializeRelation);
  }

  if (value instanceof BaseModel) {
    return value.toJSON();
  }

  return value;
}

/**
 * Inserts `values` for `modelClass` and, when `modelClass.incrementing`
 * is true, reads back the DB-generated `primaryKeyColumn` and merges it
 * into the returned row.
 *
 * How the key is read back depends on the engine, because they do not
 * agree on the mechanism:
 *
 * - **Postgres/SQLite** use `RETURNING`. Postgres has no `insertId`
 *   concept at all, Kysely's driver leaves `InsertResult.insertId`
 *   `undefined` there, so without this branch `post.id` was
 *   `undefined` after `create()`, and the next `save()` compiled to
 *   `UPDATE ... WHERE id = NULL`.
 * - **MySQL** has no `RETURNING`, so it keeps `LAST_INSERT_ID()` via
 *   `insertId`. That value is a `bigint`; it is narrowed to a `number`
 *   only when exactly representable, so an id past 2^53 is preserved as
 *   a string rather than silently rounded, an unconditional `Number()`
 *   would truncate it.
 *
 * Skips the read-back entirely if the caller already supplied the
 * primary key. There is nothing to read back, the value came from the
 * caller rather than the DB.
 *
 * Bypasses `QueryBuilder.insert()` (which has no read-back support and
 * stays that way. See its own docstring). A standalone function (not a
 * `Model` static) so both `Model.create()` and `Factory`'s insert path
 * can share it without either calling into the other.
 */
/**
 * Fills `primaryKeyColumn` from `newUniqueId()` when `incrementing` is
 * false and the payload has no key yet. Shared by `Model.create()` and
 * `Factory.insertRows()` so factory-created rows get the same generated
 * IDs as `create()`. A standalone function (not a `Model` static) for
 * the same reason as `insertAndReadGeneratedId`.
 */
export async function assignGeneratedPrimaryKey(
  modelClass: typeof BaseModel,
  attributes: Record<string, any>,
): Promise<void> {
  if (modelClass.incrementing) {
    return;
  }

  const key = modelClass.primaryKeyColumn;

  if (attributes[key] != null && attributes[key] !== "") {
    return;
  }

  const id = await modelClass.newUniqueId();

  if (id !== undefined) {
    attributes[key] = id;
  }
}

export async function insertAndReadGeneratedId(
  modelClass: typeof BaseModel,
  values: Record<string, any>,
): Promise<Record<string, any>> {
  const db = modelClass.resolveConnection();
  const key = modelClass.primaryKeyColumn;
  const insert = db.insertInto(modelClass.table).values(modelClass.prepareWrite(values) as any);

  // The caller already chose the key, no generated value to read back.
  if (values[key] !== undefined) {
    await insert.executeTakeFirst();

    return { ...values };
  }

  if (dialectOf(db) === "mysql") {
    const result = await insert.executeTakeFirst();
    const row = { ...values };

    if (result?.insertId !== undefined) {
      // Kept as the `bigint` MySQL reports, matching what a SELECT of
      // this column now yields on every engine. Narrowing it to a
      // number or a string here would make the id returned by `create()`
      // a different type from the same id read back by `find()`.
      row[key] = result.insertId;
    }

    return row;
  }

  const returned = await insert.returning(key as any).executeTakeFirst();

  return { ...values, ...(returned ?? {}) };
}

/**
 * A model instance for an attributes map `A`, the base runtime plus the
 * resolved attribute shape (columns as declared, relation markers as
 * their loaded value, computed markers as their type) and the query-side
 * `relations` namespace. This is the "one type" a finder, a builder
 * terminal, and `this` inside a method all agree on.
 */
export type ModelInstance<A> = BaseModel &
  ResolvedAttributes<A> & { relations: RelationBuildersFor<A> } & HasAttributes<A>;

/**
 * The type-space companion to the `Model()` factory value. `Model` refers
 * to *any* model instance (`BaseModel`), so existing `instanceof`-style
 * annotations and `value instanceof BaseModel` keep working, while the
 * value `Model` is the factory function. A value and a type may share a
 * name (as `Facade` does).
 */
export type Model = BaseModel;

/**
 * Any model **class** (constructor + statics), the value-side counterpart
 * to the `Model` instance type. The morph map, the model registry and
 * relation helpers use this rather than `typeof Model`, which names the
 * factory function, not a class.
 */
export type AnyModelClass = typeof BaseModel;

/** The plain-column attribute shape of `A` (no relations, no computed). */
export type ModelAttributes<A> = { [K in ColumnKeys<A>]: A[K] };

/**
 * The attribute shape accepted on **write** (`create()`, `update()`,
 * `firstOrCreate()`, the constructor, ...). Identical to
 * `ModelAttributes<A>` except that a column with a declared cast also
 * accepts that cast's database-facing type.
 *
 * This is the type-level half of the contract `Cast.toDatabaseType()`
 * already implements at runtime: it takes `ModelType | DbType`, so
 * `post.published = 1` (the stored `0`/`1`) is as valid as
 * `post.published = true`. Documented in `docs/models/README.md` under
 * "The lenient `DbType` unions are on purpose", but `ModelAttributes`
 * alone admitted only the model-facing side, so every documented lenient
 * write failed to compile.
 */
export type WritableAttributes<A, C> = {
  [K in ColumnKeys<A>]: C extends { casts: infer M }
    ? K extends keyof M
      ? NonNullable<M[K]> extends Cast<infer ModelType, infer DbType>
        ? // `Extract<A[K], null | undefined>` re-adds the column's own
          // nullability: a cast's `ModelType`/`DbType` describe the
          // non-null value (every built-in short-circuits on `null`), so
          // a nullable column would otherwise stop accepting `null`.
          ModelType | DbType | Extract<A[K], null | undefined>
        : A[K]
      : A[K]
    : A[K];
};

/** The primary-key column of a config `C` over attributes `A` (default `"id"`). */
type PrimaryKeyColumn<A, C> = C extends { primaryKey: infer P extends ColumnKeys<A> }
  ? P
  : "id" extends ColumnKeys<A>
    ? "id"
    : never;

/**
 * The primary-key value type for a model instance `M`. Defaults to the
 * `id` column's type when present, else `string | number`. (A model with a
 * non-`id` primary key uses the precise `find()` signature the factory
 * generates from `config.primaryKey`; this looser form is the fallback for
 * structural consumers that only have the instance type.)
 */
export type Key<M> = M extends { id: infer I } ? I : string | number;

/**
 * `M` with the relations named by `K` guaranteed present (non-`undefined`),
 * what `with()`/`load()`/`loadMissing()` return.
 */
export type Loaded<M, K extends PropertyKey> = M & {
  [P in K & keyof M]-?: Exclude<M[P], undefined>;
};

/** The loaded value-side accessors for an attributes map `A`. */
export type LoadedRelationValues<A> = { [K in RelationKeys<A>]: LoadedValueOf<A[K]> };

/**
 * The query-side `relations` namespace for `A`: one nullary accessor per
 * relation returning the related model's builder (a `MorphToBuilder` for a
 * `morphTo`). The custom builder marker on a relation narrows the return.
 *
 * Each accessor is **intersected** with that relation kind's write API
 * (`RelationWritesFor`), so `post.relations.tags()` offers `attach()`
 * while `post.relations.author()` offers `associate()` and not
 * `attach()`, and a read-only `hasManyThrough` offers neither. The
 * intersection is what keeps a custom builder intact: replacing the type
 * with a fixed write-capable subclass would silently delete the related
 * model's own scopes from the accessor. The runtime half is
 * `attachRelationWrites()`; see `relationship-writes.ts`.
 *
 * `RelationWritesFor` discriminates on a `{ type }` field, which is the
 * shape a `RelationDefinition` has, a marker carries the same kind under
 * `KindOf`, so it is re-wrapped here rather than duplicating the mapping.
 */
export type RelationBuildersFor<A> = {
  [K in RelationKeys<A>]: KindOf<A[K]> extends "morphTo"
    ? () => MorphToBuilder<RelatedOf<A[K]>>
    : () => (BuilderMarkerOf<A[K]> extends infer B
        ? unknown extends B
          ? EloquentBuilder<
              Record<string, any>,
              Record<never, never>,
              Record<never, never>,
              RelatedOf<A[K]>
            >
          : B
        : never) &
        RelationWritesFor<{ type: KindOf<A[K]>; related: () => RelatedClassOfMarker<A[K]> }>;
};

/**
 * A constructor type for a marker's related instance, what
 * `RelationWritesFor`'s `HasManyWrites` needs to recover the related
 * model from a synthesised definition shape.
 */
type RelatedClassOfMarker<V> = abstract new (...args: any[]) => RelatedOf<V>;

/**
 * `Attributes<Row, C>` and `RelationAccessors<R>`, retained names the
 * `EloquentBuilder` and legacy call sites import. Under the redesign these
 * are permissive shims: the builder threads the resolved instance type
 * `TInstance` for precision, so these only need to stay structurally
 * compatible.
 */
// Both deliberately discard a parameter they must still accept: the
// arity is part of the retained public signature (`Attributes<Row,
// Casts>`, `RelationAccessors<Rels>`) that `eloquent-builder.ts` and
// downstream call sites pass, while the redesign derives the precision
// from `TInstance` instead. The lint's `^_` convention covers arguments,
// not type parameters, so it needs saying here.
/* eslint-disable @typescript-eslint/no-unused-vars */
export type Attributes<Row, _Casts = unknown> = Row;
export type RelationAccessors<_R> = { relations: Record<string, (...args: any[]) => any> };
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * The shape `EloquentBuilder` needs from its owning model class, kept
 * minimal to avoid a circular type dependency. Structurally satisfied by
 * every factory-produced class.
 */
export interface ModelClass {
  readonly name: string;
  readonly table: string;
  readonly primaryKeyColumn: string;
  readonly relations: RelationDefinitions;
  readonly scopes: readonly GlobalScope[];
  readonly timestamps: boolean;
  readonly updatedAtColumn: string | null;
  /** The model's cast map, read by the builder to cast where/write bindings. See `EloquentBuilder`'s "Casts" section. */
  readonly casts: Record<string, Cast<any, any>>;
  morphAlias(): string;
  currentTimestamp(): string;
  /** Datetime columns respelled for this model's engine, the last step before any builder insert/update. */
  prepareWrite<T extends Record<string, any>>(values: T): T;
  resolveConnection(): Kysely<any>;
  newEloquentBuilder(): EloquentBuilder<any>;
  query(): EloquentBuilder<any>;
  hydrate(row: Record<string, any>): Model;
  fireRetrieved(instance: Model): Promise<void>;
}

/**
 * The configuration object passed to the curried `Model<A>()(config)`
 * factory, the single place a model's runtime shape is declared. Every
 * key but `table` is optional and type-checked against the attributes map
 * `A` (column keys are checked against real columns; the primary key must
 * be a column; casts' model types must equal the declared attribute type).
 */
export interface ModelConfig<A> {
  table: string;
  connection?: string;
  primaryKey?: ColumnKeys<A>;
  keyType?: "increment" | "uuid" | KeyStrategy;
  timestamps?: boolean | { createdAt?: ColumnKeys<A> | null; updatedAt?: ColumnKeys<A> | null };
  softDeletes?: boolean | { column: ColumnKeys<A> };
  casts?: { [K in ColumnKeys<A>]?: Cast<A[K], any> };
  fillable?: ColumnKeys<A>[];
  guarded?: (ColumnKeys<A> | "*")[];
  hidden?: (keyof A & string)[];
  visible?: (keyof A & string)[];
  appends?: ComputedKeys<A>[];
  morphName?: string;
  deleteWhenMissingModels?: boolean;
  strictRelations?: boolean;
}

declare const MODEL_TYPE_ERROR: unique symbol;
/** A branded `never`-like carrying a human-readable message, surfaces a type-lint failure at the class declaration. */
export type ModelTypeError<Msg extends string> = { readonly [MODEL_TYPE_ERROR]: Msg };

/**
 * Column keys of `A` that are `boolean` and have no cast (and aren't a
 * timestamp/soft-delete column). Those need an explicit `Cast.boolean()`
 * because SQLite/MySQL return `0`/`1`.
 */
type BooleanColumnsNeedingCast<A, Casts> = {
  [K in ColumnKeys<A>]: A[K] extends boolean
    ? boolean extends A[K]
      ? K extends keyof Casts
        ? never
        : K
      : never
    : never;
}[ColumnKeys<A>];

/** Reserved instance-member names a column may not collide with. */
export type ReservedKeys =
  | "save"
  | "fill"
  | "delete"
  | "relations"
  | "toJSON"
  | "getKey"
  | "getAttribute"
  | "setAttribute"
  | "exists"
  | "refresh"
  | "replicate"
  | "load"
  | "loadMissing"
  | "toObject"
  | "isDirty"
  | "isClean"
  | "getDirty"
  | "getOriginal"
  | "forceFill";

/** Column keys of `A` that collide with a reserved member name. */
type ReservedCollisions<A> = Extract<ColumnKeys<A>, ReservedKeys>;

/**
 * Column keys of `A` typed `DateTime` with no cast declared.
 *
 * Same failure as the boolean rule and a nastier one: the driver hands
 * back a string (or a JS `Date`), so `post.published_at.addDays(1)`
 * throws `not a function` at runtime while the type says it is fine.
 *
 * The timestamp and soft-delete columns are excluded, the factory
 * installs their casts implicitly from `timestamps`/`softDeletes`, so
 * demanding an explicit one would be wrong.
 */
type DateTimeColumnsNeedingCast<A, C extends ModelConfig<A>, Casts> = Exclude<
  {
    [K in ColumnKeys<A>]: [NonNullable<A[K]>] extends [DateTime]
      ? K extends keyof Casts
        ? never
        : K
      : never;
  }[ColumnKeys<A>],
  ImplicitlyCastColumns<A, C>
>;

/**
 * The columns whose casts the factory installs on its own: the
 * `created_at`/`updated_at` pair (unless `timestamps` is off or the
 * column is nulled out) and the soft-delete column.
 */
type ImplicitlyCastColumns<A, C extends ModelConfig<A>> =
  (C extends { timestamps: false } ? never : TimestampColumns<A, C>) | SoftDeleteColumn<A, C>;

type TimestampColumns<A, C> = C extends { timestamps: infer T extends object }
  ? | (T extends { createdAt: infer K extends string } ? K : "created_at")
    | (T extends { updatedAt: infer K extends string } ? K : "updated_at")
  : "created_at" | "updated_at";

type SoftDeleteColumn<A, C> = C extends { softDeletes: infer S }
  ? S extends { column: infer K extends string }
    ? K
    : S extends true
      ? "deleted_at"
      : never
  : never;

/*
 * There is deliberately NO rule for "`primaryKey` names a relation or a
 * computed key". `ModelConfig` already types that field as
 * `ColumnKeys<A>`, which excludes both, so the assignment is rejected
 * before a lint rule could ever see it, such a rule is unreachable by
 * construction, and writing one would only imply a check that isn't
 * doing any work. The error you get instead is a plain "Type '"author"'
 * is not assignable to type '"id"'", pointed at the offending line.
 */

/**
 * `keyType` and the primary key's declared type must agree: `"uuid"` and
 * a `KeyStrategy` both assign strings, so `id: number` with
 * `keyType: "uuid"` is a guaranteed runtime type mismatch on insert.
 */
type KeyTypeMismatch<A, C extends ModelConfig<A>> = C extends { keyType: infer KT }
  ? [KT] extends ["increment"]
    ? never
    : [A[PrimaryKeyColumn<A, C>]] extends [string]
      ? never
      : PrimaryKeyColumn<A, C> & string
  : never;

/**
 * `relationships` keys must be relation-marker keys of `A`, and
 * `accessors` keys must be `Computed<>` keys. Both are declared as
 * statics on the class body rather than in the config, so neither is
 * checked by `ModelConfig`, a typo'd or stale key there is silently
 * dead code (`with("athor")` then fails at runtime with a confusing
 * "no such relation").
 *
 * Checked in the factory's return type rather than here, since they are
 * class-body statics; see `Relationships<A>` and `ModelStatics`'
 * `accessors`, both of which are already keyed on the right union.
 */

/** The soft-delete column must be nullable. `restore()` writes `null` to it. */
type SoftDeleteColumnNotNullable<A, C extends ModelConfig<A>> =
  SoftDeleteColumn<A, C> extends infer K
    ? K extends ColumnKeys<A>
      ? null extends A[K]
        ? never
        : K & string
      : never
    : never;

/**
 * The "no casts declared" sentinel for the lint. Must be an empty
 * interface, not `Record<string, never>`: the latter's `keyof` is
 * `string`, so `K extends keyof Casts` would hold for every column and
 * the boolean-cast lint would silently never fire.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface NoCasts {}

type DeclaredCasts<C> = C extends { casts: infer Casts extends object } ? Casts : NoCasts;

/**
 * `unknown` (intersects away to nothing) when `Offenders` is empty,
 * otherwise a `ModelTypeError` naming them. Lets each rule below read as
 * one line instead of another level of nested ternary.
 */
type Rule<Offenders, Msg extends string> = [Offenders] extends [never]
  ? unknown
  : ModelTypeError<`${Msg}: ${Offenders & string}`>;

/**
 * The lint verdict for `A`/`config`: `unknown` when everything checks
 * out, otherwise a `ModelTypeError` whose message names the problem and
 * the offending column, surfaced at the class declaration.
 *
 * An intersection rather than a chain of ternaries, so every rule is
 * evaluated and a model breaking two of them reports both. The rules:
 *
 * 1. a `boolean` column with no `Cast.boolean()` (SQLite/MySQL give 0/1);
 * 2. a `DateTime` column with no cast (the driver gives a string);
 * 3. a column colliding with a reserved instance member;
 * 4. `keyType` disagreeing with the primary key's declared type;
 * 5. a non-nullable soft-delete column (`restore()` writes `null`).
 */
type ModelLint<A, C extends ModelConfig<A>> = Rule<
  BooleanColumnsNeedingCast<A, DeclaredCasts<C>>,
  "boolean column needs a Cast.boolean()"
> &
  Rule<
    DateTimeColumnsNeedingCast<A, C, DeclaredCasts<C>>,
    "DateTime column needs a Cast.datetime()"
  > &
  Rule<ReservedCollisions<A>, "column collides with a reserved model member"> &
  Rule<
    KeyTypeMismatch<A, C>,
    "keyType generates a string, so the primary key column must be typed string"
  > &
  Rule<SoftDeleteColumnNotNullable<A, C>, "the soft-delete column must be nullable">;

/**
 * The static + constructor side the factory returns for attributes `A`
 * and config `C`. Extends the runtime `BaseModel` statics but overrides
 * the finder / query / config members with precisely-typed versions, and
 * makes `new` produce a `ModelInstance<A>` (plus, when soft deletes are
 * configured, the trashed/restore/forceDelete methods).
 */
/** Static members `ModelStatics` overrides with precise types (excluded from the inherited base). */
type OverriddenStatics =
  | "prototype"
  | "table"
  | "primaryKey"
  | "primaryKeyColumn"
  | "casts"
  | "relationships"
  | "accessors"
  | "find"
  | "findOrFail"
  | "findMany"
  | "first"
  | "firstOrFail"
  | "all"
  | "create"
  | "firstOrNew"
  | "firstOrCreate"
  | "updateOrCreate"
  | "update"
  | "delete"
  | "query"
  | "queryWithoutScopes"
  | "newModelQuery"
  | "hydrate"
  | "withTrashed"
  | "onlyTrashed";

export interface ModelStatics<A, C extends ModelConfig<A>> extends Omit<
  typeof BaseModel,
  OverriddenStatics
> {
  new (
    attributes?: Partial<WritableAttributes<A, C>>,
  ): ModelInstance<A> & SoftDeleteInstanceMethods<C>;

  readonly table: string;
  readonly primaryKey: PrimaryKeyColumn<A, C>;
  readonly primaryKeyColumn: string;
  casts: Record<string, Cast<any, any>>;
  relationships: Relationships<A>;
  accessors: {
    [K in ComputedKeys<A>]?: AccessorDefinition<
      ModelInstance<A>,
      A[K] extends Computed<infer T> ? T : never
    >;
  };

  find<T extends abstract new (...a: any) => any>(
    this: T,
    id: A[PrimaryKeyColumn<A, C>],
  ): Promise<InstanceType<T> | undefined>;
  findOrFail<T extends abstract new (...a: any) => any>(
    this: T,
    id: A[PrimaryKeyColumn<A, C>],
  ): Promise<InstanceType<T>>;
  findMany<T extends abstract new (...a: any) => any>(
    this: T,
    ids: A[PrimaryKeyColumn<A, C>][],
  ): Promise<Collection<InstanceType<T>>>;
  first<T extends abstract new (...a: any) => any>(this: T): Promise<InstanceType<T> | undefined>;
  firstOrFail<T extends abstract new (...a: any) => any>(this: T): Promise<InstanceType<T>>;
  all<T extends abstract new (...a: any) => any>(this: T): Promise<Collection<InstanceType<T>>>;
  create<T extends abstract new (...a: any) => any>(
    this: T,
    values: Partial<WritableAttributes<A, C>>,
  ): Promise<InstanceType<T>>;
  firstOrNew<T extends abstract new (...a: any) => any>(
    this: T,
    attributes: Partial<WritableAttributes<A, C>>,
    values?: Partial<WritableAttributes<A, C>>,
  ): Promise<InstanceType<T>>;
  firstOrCreate<T extends abstract new (...a: any) => any>(
    this: T,
    attributes: Partial<WritableAttributes<A, C>>,
    values?: Partial<WritableAttributes<A, C>>,
  ): Promise<InstanceType<T>>;
  updateOrCreate<T extends abstract new (...a: any) => any>(
    this: T,
    attributes: Partial<WritableAttributes<A, C>>,
    values?: Partial<WritableAttributes<A, C>>,
  ): Promise<InstanceType<T>>;
  update(id: A[PrimaryKeyColumn<A, C>], values: Partial<WritableAttributes<A, C>>): Promise<void>;
  delete(id: A[PrimaryKeyColumn<A, C>]): Promise<void>;

  // This-polymorphic like the finders above: the builder terminates in
  // the *subclass* instance type, so `Post.query()...firstOrFail()` and
  // `Post.find()` hand back the same `Post`, methods included.
  //
  // The `DefaultBuilder<A>` overload comes SECOND but is what a custom
  // `static query(): PostBuilder` override is checked against: an
  // override must be assignable to the inherited member, and the
  // this-polymorphic signature (whose return depends on `T`) admits no
  // fixed narrower builder. Declaring the concrete signature as well
  // gives the override something satisfiable to match, while call sites
  // still resolve the first (more precise) overload.
  query<T extends abstract new (...a: any) => any>(this: T): BuilderFor<A, InstanceType<T>>;
  query(): DefaultBuilder<A>;
  queryWithoutScopes<T extends abstract new (...a: any) => any>(
    this: T,
  ): BuilderFor<A, InstanceType<T>>;
  newModelQuery<T extends abstract new (...a: any) => any>(this: T): BuilderFor<A, InstanceType<T>>;
  hydrate<T extends abstract new (...a: any) => any>(
    this: T,
    row: Record<string, any>,
  ): InstanceType<T>;

  /**
   * Soft-delete query entry points. Present on every model (inherited from
   * the base), but only meaningful, and only non-throwing, when
   * `softDeletes` is configured. Typed to return this model's builder.
   */
  withTrashed<T extends abstract new (...a: any) => any>(this: T): BuilderFor<A, InstanceType<T>>;
  onlyTrashed<T extends abstract new (...a: any) => any>(this: T): BuilderFor<A, InstanceType<T>>;
}

/**
 * The runtime relation-definition map derived from a model's markers,
 * the branded helper definitions are structurally `RelationDefinition`s,
 * so threading this into the builder lets `with()`/`whereHas()` name-check
 * against the real relation names.
 */
export type RelationDefsOf<A> = Relationships<A>;

/** The default builder for a model with attributes `A`, threads the resolved instance and relation map. */
/**
 * This model's builder, terminating in instance type `I`.
 *
 * `I` is a parameter rather than always `ModelInstance<A>` so the query
 * entry points can stay this-polymorphic: `Post.query()` must terminate
 * in `Post` (subclass methods and all), exactly as `Post.find()` does.
 * Without it a builder terminal and a finder result would disagree about
 * the same row, the "one type everywhere" guarantee this redesign is
 * built on.
 */
export type BuilderFor<A, I> = EloquentBuilder<
  ModelAttributes<A>,
  RelationDefsOf<A> extends RelationDefinitions ? RelationDefsOf<A> : RelationDefinitions,
  Record<never, never>,
  I
>;

/** This model's builder terminating in the bare derived instance shape. */
export type DefaultBuilder<A> = BuilderFor<A, ModelInstance<A>>;

/** Whether a config `C` enables soft deletes. */
type SoftDeletesEnabled<C> = C extends { softDeletes: infer S }
  ? S extends false
    ? false
    : S extends undefined
      ? false
      : true
  : false;

/**
 * The instance-side soft-delete methods, present only when configured.
 * The empty case is `unknown` (which intersects away cleanly) rather than
 * `{}` (lint) or `Record<string, never>` (which would poison the instance
 * intersection with a `[string]: never` index that rejects subclass
 * methods).
 */
type SoftDeleteInstanceMethods<C> =
  SoftDeletesEnabled<C> extends true
    ? { trashed(): boolean; restore(): Promise<Model>; forceDelete(): Promise<void> }
    : unknown;

/**
 * The curried model factory. `Model<PostAttributes>()({ table, … })`
 * returns a base class to extend:
 *
 *   class Post extends Model<PostAttributes>()({ table: "posts", … }) { … }
 *
 * The `()` is required because TypeScript has no partial type-argument
 * inference, the empty call fixes `A` explicitly, the second call infers
 * `const C` from the config literal (preserving `primaryKey: "id"`,
 * `softDeletes: true`, and the casts map as literal types the derivation
 * depends on). See the plan's spike S1.
 *
 * At runtime it validates the config, builds a subclass of `BaseModel`
 * with the config projected onto readonly statics, registers implicit
 * timestamp/datetime casts, installs the soft-delete global scope when
 * configured, and attaches the resolved key strategy.
 */
export function Model<A>() {
  return function defineModel<const C extends ModelConfig<A>>(
    config: C & ModelLint<A, C>,
  ): ModelStatics<A, C> & {
    new (
      attributes?: Partial<WritableAttributes<A, C>>,
    ): ModelInstance<A> & SoftDeleteInstanceMethods<C>;
  } {
    return buildModelClass(config as unknown as ModelConfig<A_ANY>) as unknown as ModelStatics<
      A,
      C
    > & {
      new (
        attributes?: Partial<WritableAttributes<A, C>>,
      ): ModelInstance<A> & SoftDeleteInstanceMethods<C>;
    };
  };
}

/**
 * The runtime behind `Model<A>()(config)`, builds and returns a subclass
 * of `BaseModel` with the config baked into statics. Validation mirrors
 * the type-level lint so a plain-JS consumer gets the same guarantees.
 */
function buildModelClass(config: ModelConfig<A_ANY>): typeof BaseModel {
  validateModelConfig(config);

  const timestampsOn = config.timestamps !== false;
  const createdAt =
    typeof config.timestamps === "object" ? (config.timestamps.createdAt ?? null) : "created_at";
  const updatedAt =
    typeof config.timestamps === "object" ? (config.timestamps.updatedAt ?? null) : "updated_at";
  const softColumn =
    config.softDeletes === true
      ? "deleted_at"
      : typeof config.softDeletes === "object"
        ? config.softDeletes.column
        : undefined;

  // Implicit casts: timestamp/soft-delete columns and any datetime column
  // become `DateTimeCast` automatically.
  const casts: Record<string, Cast<any, any>> = { ...(config.casts ?? {}) };

  if (timestampsOn) {
    if (createdAt && !casts[createdAt]) {
      casts[createdAt] = DateTimeCastValue;
    }

    if (updatedAt && !casts[updatedAt]) {
      casts[updatedAt] = DateTimeCastValue;
    }
  }

  if (softColumn && !casts[softColumn]) {
    casts[softColumn] = DateTimeCastValue;
  }

  const keyStrategy = resolveKeyType(config.keyType);

  class GeneratedModel extends BaseModel {
    static override table = config.table;
    static override primaryKey = config.primaryKey ?? "id";
    static override connection = config.connection;
    static override keyStrategy = keyStrategy;
    static override casts = casts;
    static override timestamps = timestampsOn;
    static override createdAtColumn = timestampsOn ? createdAt : null;
    static override updatedAtColumn = timestampsOn ? updatedAt : null;
    static override fillable = (config.fillable ?? []) as string[];
    static override guarded = (config.guarded ?? []) as string[];
    static override hidden = (config.hidden ?? []) as string[];
    static override visible = (config.visible ?? []) as string[];
    static override appends = (config.appends ?? []) as string[];
    static override morphName = config.morphName;
    static override deleteWhenMissingModels = config.deleteWhenMissingModels ?? false;
    static override strictRelations = config.strictRelations ?? false;
    static override bootHooks: Array<(this: typeof BaseModel) => void> = softColumn
      ? [
          function installSoftDeleteScope(this: typeof BaseModel) {
            this.addGlobalScope(new ConfigSoftDeleteScope(softColumn!));
          },
        ]
      : [];
  }

  return GeneratedModel;
}

// `A` is only meaningful at the type level; the runtime builder is untyped.
type A_ANY = Record<string, any>;

/**
 * Runtime config validation, for consumers whose config never met the
 * type-checker: plain JS, a config assembled dynamically, or a `as any`.
 *
 * **This deliberately does not mirror the type-level lint.** Every rule
 * in `ModelLint` is a statement about `A`, "this column is a `boolean`
 * and has no cast", and `A` is a type parameter that does not exist at
 * runtime. There is no attributes map to inspect: a model declares its
 * columns in an interface, not a value. Claiming to mirror the lint
 * would mean claiming checks that cannot be written.
 *
 * What it does instead is check the config *object*, which is a real
 * value, for the malformed shapes that would otherwise fail later and
 * far from the cause, a bad `keyType` surfacing as a missing primary
 * key on the first insert, a `casts` entry that isn't a `Cast` throwing
 * `toModelType is not a function` inside hydration.
 */
function validateModelConfig(config: ModelConfig<A_ANY>): void {
  const fail = (message: string): never => {
    throw new Error(`Model config for "${config?.table ?? "<unknown>"}": ${message}`);
  };

  if (!config || typeof config !== "object") {
    throw new Error("Model config: expected a config object.");
  }

  if (!config.table || typeof config.table !== "string") {
    throw new Error("Model config: `table` is required and must be a string.");
  }

  if (config.connection !== undefined && typeof config.connection !== "string") {
    fail("`connection` must be a string naming a configured connection.");
  }

  if (config.primaryKey !== undefined && typeof config.primaryKey !== "string") {
    fail("`primaryKey` must be a column name.");
  }

  if (config.morphName !== undefined && typeof config.morphName !== "string") {
    fail("`morphName` must be a string.");
  }

  // `keyType` is either one of the two built-in names or a KeyStrategy.
  const keyType = config.keyType;

  if (keyType !== undefined && keyType !== "increment" && keyType !== "uuid") {
    if (typeof keyType !== "object" || keyType === null || typeof keyType.generate !== "function") {
      fail(
        '`keyType` must be "increment", "uuid", or a KeyStrategy ' +
          "({ type, generate }) — e.g. snowflake() from @mahiframework/snowflake.",
      );
    }

    if (keyType.type !== "string" && keyType.type !== "number") {
      fail('`keyType.type` must be "string" or "number".');
    }
  }

  // A cast that isn't a Cast throws deep inside hydration otherwise.
  for (const [column, cast] of Object.entries(config.casts ?? {})) {
    if (
      typeof cast !== "object" ||
      cast === null ||
      typeof (cast as Cast<any, any>).toModelType !== "function" ||
      typeof (cast as Cast<any, any>).toDatabaseType !== "function"
    ) {
      fail(
        `casts.${column} is not a Cast. A Cast is ` +
          "{ toModelType, toDatabaseType } — see the Cast helpers (Cast.boolean(), Cast.json(), …).",
      );
    }
  }

  for (const key of ["fillable", "guarded", "hidden", "visible", "appends"] as const) {
    const value = config[key];

    if (value === undefined) {
      continue;
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      fail(`\`${key}\` must be an array of column names.`);
    }
  }

  // Laravel's precedence is fillable-wins, which silently ignores the
  // `guarded: ["*"]` the author wrote to lock the model down. Declaring
  // both is a contradiction, so say so rather than pick a winner.
  if (config.fillable !== undefined && config.guarded?.includes("*")) {
    fail('declares both `fillable` and `guarded: ["*"]` — use one or the other.');
  }

  if (typeof config.timestamps === "object" && config.timestamps !== null) {
    for (const key of ["createdAt", "updatedAt"] as const) {
      const value = config.timestamps[key];

      if (value !== undefined && value !== null && typeof value !== "string") {
        fail(`\`timestamps.${key}\` must be a column name, or null to disable it.`);
      }
    }
  } else if (config.timestamps !== undefined && typeof config.timestamps !== "boolean") {
    fail("`timestamps` must be a boolean or { createdAt, updatedAt }.");
  }

  if (typeof config.softDeletes === "object" && config.softDeletes !== null) {
    if (typeof config.softDeletes.column !== "string" || config.softDeletes.column === "") {
      fail("`softDeletes` object form requires a `column` name.");
    }
  } else if (config.softDeletes !== undefined && typeof config.softDeletes !== "boolean") {
    fail("`softDeletes` must be a boolean or { column }.");
  }
}
