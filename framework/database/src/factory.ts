import {
  assignGeneratedPrimaryKey,
  insertAndReadGeneratedId,
  BaseModel,
  type AnyModelClass,
} from "./model.js";
import { dispatchModelEvent } from "./model-events.js";

/** The instance type a model class `M` constructs. */
type InstanceOfModel<M> = M extends abstract new (...args: any) => infer I ? I : never;
/** The plain model-shape attributes a factory's `definition()` returns for model `M`. */
type ModelShape<M> = Partial<InstanceOfModel<M>> & Record<string, any>;

/**
 * A `state()` argument, either a partial-attribute object merged
 * directly over whatever's been built so far, or a resolver receiving
 * those attributes and returning the partial to merge. Mirrors Laravel's
 * `Factory::state()` closure signature (`fn (array $attributes) =>
 * [...]`), just typed instead of duck-typed.
 */
export type FactoryState<T> = Partial<T> | ((attributes: T) => Partial<T>);

/** An `afterMaking()`/`afterCreating()` callback, may be sync or async. */
export type FactoryCallback<T> = (row: T) => void | Promise<void>;

/**
 * Base class for generating realistic fake model instances on demand,
 * the thing tests actually want most (`TodoFactory.make()` / `.create()`
 * with sensible random-but-valid defaults, optionally overridden per
 * test). Not a database seeder replacement. `Seeder` stays the
 * `db:seed`-driven, fixed "populate my dev database" mechanism; `Factory`
 * is the test/ad-hoc "give me N valid rows" mechanism. Seeders can (and
 * often should) use factories internally
 * (`await new TodoFactory().times(20).create()` inside a `Seeder.run()`).
 *
 * Bound to a `Model` subclass (not a raw Kysely handle), matches
 * `Model` itself being static/self-resolving now, so a `Factory` needs
 * no constructor arguments at all:
 *
 *   class TodoFactory extends Factory<typeof Todo> {
 *     protected model = Todo;
 *     protected definition(): TodoTable {
 *       return { id: randomUUID(), title: `Todo ${Math.random()...}`, done: 0, created_at: ... };
 *     }
 *   }
 *
 *   const todo = await new TodoFactory().createOne();               // one row, defaults
 *   const done = await new TodoFactory().createOne({ done: 1 });    // one row, overridden
 *   const many = await new TodoFactory().times(5).create();         // five rows, defaults
 *
 * `create()`/`make()` always return an array (`ModelShape<M>[]`, length ==
 * `times()`, default 1); `createOne()`/`makeOne()` always return a single
 * row and ignore any `times()` call, use those when you know you
 * only want one row and don't want an array to unwrap. `make()`/
 * `makeOne()` build in-memory rows only, no DB write; `create()`/
 * `createOne()` build then insert (`times(n).create()` is one batch
 * insert, not `n` round trips).
 *
 * ## States
 *
 * `state()` layers a partial-attribute override (or a resolver receiving
 * the attributes built so far, Laravel-style) on top of `definition()`.
 * Multiple `state()` calls compose in call order; whatever's passed
 * directly to `make()`/`create()`/etc. is applied last and always wins:
 *
 *   class TodoFactory extends Factory<typeof Todo> {
 *     protected model = Todo;
 *     protected definition(): TodoTable { return { ...(defaults)..., done: 0 }; }
 *
 *     done(): this {
 *       return this.state({ done: 1 });
 *     }
 *   }
 *
 *   const done = await new TodoFactory().done().createOne();
 *
 * ## Lifecycle callbacks
 *
 * `afterMaking()` runs against every row right after it's built (before
 * any DB write, fires for `make()`/`makeOne()` too, not just
 * `create()`/`createOne()`); `afterCreating()` runs right after a row is
 * inserted. Both may be sync or return a `Promise`, and both stack,
 * register more than once to add more callbacks rather than replacing
 * the previous one:
 *
 *   new TodoFactory()
 *     .afterMaking((todo) => { todo.title = todo.title.trim(); })
 *     .afterCreating(async (todo) => { await TodoTag.create({ todo_id: todo.id, tag: "seeded" }); })
 *     .createOne();
 *
 * Deliberately does NOT bundle `@faker-js/faker` or any fake-data
 * generation library. `definition()` is just a plain function returning
 * a row; apps wanting realistic fake names/emails/etc. add
 * `@faker-js/faker` themselves and call it from their own `definition()`.
 *
 * ## Chaining mutates `this`
 *
 * `times()`/`state()`/`afterMaking()`/`afterCreating()` each mutate the
 * factory and return the SAME instance (not a new cloned one), matching
 * `QueryBuilder`'s ergonomics. See its docstring for the "why". So a
 * factory held in a variable accumulates, and `times()` in particular
 * sticks across terminal calls:
 *
 *   const factory = Post.factory();
 *   await factory.times(3).create();  // three rows
 *   await factory.create();           // three MORE, times(3) still set
 *
 * This rarely bites, because `Model.factory()` constructs a fresh factory
 * on every call (that's what the override returns), so the usual
 * `Post.factory().times(10).create()` is always independent. It only
 * matters once a factory is held and reused. `clone()` is the explicit
 * escape hatch for branching one.
 *
 * ## Model events & timestamps
 *
 * `create()`/`createOne()` (and `times(n).create()`) route through the
 * same `timestamps`/`incrementing`/lifecycle-event behavior as
 * `Model.create()`. See `Model`'s own docstring. `createQuietly()`/
 * `createOneQuietly()` are the `Model.withoutEvents()`-wrapped
 * equivalents, for seeding/tests that want rows inserted without firing
 * observers/listeners/`dispatchesEvents`:
 *
 *   await new TodoFactory().times(50).createQuietly(); // no TodoCreated events fired
 */
export abstract class Factory<M extends AnyModelClass = AnyModelClass> {
  protected abstract model: M;
  protected abstract definition(): ModelShape<M>;

  private count = 1;
  private states: Array<(attributes: ModelShape<M>) => Partial<ModelShape<M>>> = [];
  private afterMakingCallbacks: FactoryCallback<InstanceType<M>>[] = [];
  private afterCreatingCallbacks: FactoryCallback<InstanceType<M>>[] = [];

  /** Chain before make()/create() to build multiple rows at once. Ignored by makeOne()/createOne(). */
  times(n: number): this {
    this.count = n;

    return this;
  }

  /** Layers a partial-attribute override (or resolver) on top of definition(). See the class docstring's "States" section. */
  state(state: FactoryState<ModelShape<M>>): this {
    this.states.push(
      typeof state === "function"
        ? (state as (attributes: ModelShape<M>) => Partial<ModelShape<M>>)
        : () => state,
    );

    return this;
  }

  /** Registers a callback run against every instance right after it's built, before any DB write. See the class docstring's "Lifecycle callbacks" section. */
  afterMaking(callback: FactoryCallback<InstanceType<M>>): this {
    this.afterMakingCallbacks.push(callback);

    return this;
  }

  /** Registers a callback run against every instance right after create()/createOne() inserts it. See the class docstring's "Lifecycle callbacks" section. */
  afterCreating(callback: FactoryCallback<InstanceType<M>>): this {
    this.afterCreatingCallbacks.push(callback);

    return this;
  }

  /**
   * Returns a new factory of the SAME (possibly custom) subclass with the
   * same accumulated `times()`/`state()`/`afterMaking()`/`afterCreating()`
   * state, mutating the clone (or the original) afterwards does not
   * affect the other. Every chained call mutates `this` (see the class
   * docstring's "Chaining mutates this" section), so `clone()` is the one
   * explicit escape hatch for branching a factory into two independent
   * variations from a shared base, matching `QueryBuilder.clone()`:
   *
   *   const base = Post.factory().state({ user_id: user.id });
   *   const published = await base.clone().state({ published: true }).create();
   *   const drafts = await base.clone().times(3).create();
   *
   * Copies off the prototype rather than calling `new this.constructor()`:
   * a subclass is free to declare a constructor (and must at minimum set
   * `protected model`), so re-running it would either need arguments this
   * has no way to supply or discard the subclass's own fields. The
   * `Object.assign()` carries `model`, `count` and every subclass field
   * over; the array re-assignments after it then break the references
   * that assign would otherwise leave shared. `state()` resolvers and
   * lifecycle callbacks are copied by reference, they're treated as
   * immutable inputs, so registering more on either side never reaches
   * the other.
   */
  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(copy, this);
    copy.states = [...this.states];
    copy.afterMakingCallbacks = [...this.afterMakingCallbacks];
    copy.afterCreatingCallbacks = [...this.afterCreatingCallbacks];

    return copy;
  }

  /** definition() -> every state() in call order -> the explicit overrides argument (always wins). */
  private buildAttributes(overrides?: Partial<ModelShape<M>>): ModelShape<M> {
    let attributes = this.definition();

    for (const resolve of this.states) {
      attributes = { ...attributes, ...resolve(attributes) };
    }

    return { ...attributes, ...overrides };
  }

  /**
   * Builds one UNSAVED instance from a definition's attributes, running
   * afterMaking callbacks.
   *
   * Attributes go in through `forceFill()`, so each column's cast runs on
   * the way in, a `definition()` is typed as the **model** shape
   * (`ModelShape<M>` is `Partial<InstanceOfModel<M>>`), so `active: true`
   * and `meta: { a: 1 }` are what a factory author naturally writes, and
   * both must reach the database as `1` and `'{"a":1}'`.
   *
   * `setRawAttributes()` (which this used to call) skips casts entirely,
   * so those values were bound as a raw boolean and a raw object:
   * `create()` threw on SQLite and MySQL, while Postgres silently
   * coerced them. `forceFill()` is the right primitive rather than
   * `fill()` because a factory deliberately ignores `fillable`/`guarded`.
   * It is trusted test-fixture code, and a guarded `id` still needs
   * setting.
   */
  private async buildOne(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>> {
    const attributes = this.buildAttributes(overrides);
    const instance = new (this.model as unknown as new () => BaseModel)();
    instance.forceFill(attributes as Record<string, any>);
    const typed = instance as InstanceType<M>;

    for (const callback of this.afterMakingCallbacks) {
      await callback(typed);
    }

    return typed;
  }

  /** Build in-memory instance(s). No DB write. Always an array (length == times(), default 1); use makeOne() for a single instance. */
  async make(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>[]> {
    return Promise.all(Array.from({ length: this.count }, () => this.buildOne(overrides)));
  }

  /** Like make(), but always builds exactly one instance (ignoring times()) and returns it directly, not wrapped in an array. */
  async makeOne(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>> {
    return this.buildOne(overrides);
  }

  /**
   * Build + insert instance(s). Always an array (length == times(),
   * default 1); use createOne() for a single instance. Inserts directly
   * against the model's connection/table (bypassing `Model.create()`'s
   * single-row call) so `times(n).create()` is one batch insert, not `n`
   * round trips.
   */
  async create(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>[]> {
    const instances = await this.make(overrides);
    await this.insertRows(instances);

    return instances;
  }

  /** Like create(), but always builds + inserts exactly one instance (ignoring times()) and returns it directly, not wrapped in an array. */
  async createOne(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>> {
    const instance = await this.makeOne(overrides);
    await this.insertRows([instance]);

    return instance;
  }

  /**
   * Like `create()`, but with `Model` lifecycle events suppressed for
   * every inserted row (`this.model.withoutEvents(...)`. See
   * `Model.withoutEvents()`'s docstring). Rows still get
   * `timestamps`/`incrementing` treatment exactly as `create()` does;
   * only event dispatch (observers, `on()` listeners, `EventDispatcher`)
   * is skipped. `afterMaking`/`afterCreating` callbacks still run. Those
   * are `Factory`'s own hooks, not `Model` lifecycle events.
   */
  async createQuietly(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>[]> {
    return this.model.withoutEvents(() => this.create(overrides));
  }

  /** Like `createOne()`, but with `Model` lifecycle events suppressed. See `createQuietly()`. */
  async createOneQuietly(overrides?: Partial<ModelShape<M>>): Promise<InstanceType<M>> {
    return this.model.withoutEvents(() => this.createOne(overrides));
  }

  /**
   * Stamps `timestamps` columns (unless the caller's `definition()`/
   * `state()`/overrides already supplied them, same "explicit values
   * win" rule as `Model.create()`), fires `saving`/`creating` for every
   * row, inserts, fires `created`/`saved`, then runs `afterCreating`
   * callbacks, matching `Model.create()`'s event/timestamp behavior so
   * factory-created rows aren't a special case apps have to remember
   * about.
   *
   * Batch-inserts in one statement when `model.incrementing` is false
   * (the common `Factory` case, most `definition()`s assign a
   * client-generated id, e.g. `randomUUID()`), preserving `times(n).
   * create()`'s "one batch insert, not `n` round trips" guarantee. When
   * `model.incrementing` is true, inserts row-by-row instead, Kysely's
   * `InsertResult.insertId` only reports the LAST row's generated id for
   * a multi-row `VALUES (...), (...)` insert, so there's no way to read
   * back every row's generated primary key from a single batched insert;
   * correctness (every returned row having its real DB-generated id)
   * wins over the batch-perf guarantee in that case.
   */
  private async insertRows(instances: InstanceType<M>[]): Promise<void> {
    this.model.bootIfNotBooted();
    const now = this.model.currentTimestamp();

    for (const instance of instances) {
      const model = instance as unknown as BaseModel;
      const attrs = model.toObject();

      if (this.model.timestamps) {
        const createdAt = this.model.createdAtColumn;
        const updatedAt = this.model.updatedAtColumn;

        if (createdAt !== null && attrs[createdAt] === undefined) {
          attrs[createdAt] = now;
        }

        if (updatedAt !== null && attrs[updatedAt] === undefined) {
          attrs[updatedAt] = now;
        }
      }

      await dispatchModelEvent(this.model, "saving", instance as never);
      await assignGeneratedPrimaryKey(this.model, attrs);
      model.setRawAttributes(attrs);
      await dispatchModelEvent(this.model, "creating", instance as never);
    }

    if (this.model.incrementing) {
      for (const instance of instances) {
        const model = instance as unknown as BaseModel;
        const inserted = await insertAndReadGeneratedId(this.model, model.toObject());
        model.setRawAttributes(inserted);
        model.markPersisted();
      }
    } else {
      await this.model
        .resolveConnection()
        .insertInto(this.model.table)
        .values(
          instances.map((i) =>
            this.model.prepareWrite((i as unknown as BaseModel).toObject()),
          ) as any,
        )
        .execute();

      for (const instance of instances) {
        (instance as unknown as BaseModel).markPersisted();
      }
    }

    for (const instance of instances) {
      await dispatchModelEvent(this.model, "created", instance as never);
      await dispatchModelEvent(this.model, "saved", instance as never);

      for (const callback of this.afterCreatingCallbacks) {
        await callback(instance);
      }
    }
  }
}
