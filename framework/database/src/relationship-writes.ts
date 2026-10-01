import { sql, type Kysely } from "kysely";
import { sameKey } from "./key-identity.js";
import type { EloquentBuilder } from "./eloquent-builder.js";
import type { AnyModelClass, Model } from "./model.js";
import { QueryBuilder, type SqlBinding } from "./query-builder.js";
import type {
  BelongsToManyOptions,
  BelongsToOptions,
  HasManyOptions,
  MorphedByManyOptions,
  MorphManyOptions,
  MorphToManyOptions,
  RelatedInstanceOf,
  RelatedRowOf,
  RelationDefinition,
} from "./relations.js";
import { currentTimestampFor } from "./timestamps.js";
import { transaction } from "./transaction.js";

/**
 * # Relationship writes
 *
 * The write half of the relation surface, `attach()`/`detach()`/
 * `sync()`/`toggle()` on a pivot relation, `associate()`/`dissociate()`
 * on a `belongsTo`/`morphTo`, and `save()`/`create()` through a
 * `hasMany`/`morphMany`. Laravel's `BelongsToMany`, `BelongsTo` and
 * `HasOneOrMany` write methods, with this framework's explicit-keys
 * stance kept intact: every column these touch comes from the relation
 * *definition*, never from a name guess.
 *
 * ## Why these are mixed in, not a builder subclass
 *
 * The obvious shape, `class BelongsToManyBuilder extends EloquentBuilder`
 * returned by `buildRelationBuilder()`, is wrong here, and the reason
 * is `BuilderOf<M>`. A relation accessor returns the *related model's*
 * builder, which for a model declaring `static Builder`/
 * `newEloquentBuilder()` is that model's own custom subclass
 * (`tests/types.test-d.ts`'s `ArticleBuilder`). Returning a fixed
 * `BelongsToManyBuilder` instead would silently drop every custom scope
 * the related model defines. `user.relations.articles().published()`
 * would stop compiling and stop existing.
 *
 * So the write methods are **attached to the builder the relation
 * already produced**, and the type side intersects rather than replaces
 * (`RelationBuilders` in `model.ts`). A custom builder keeps its scopes
 * and gains `attach()`; the methods only appear on the relations where
 * they're valid, which is what the plan asked for.
 *
 * `morphTo` is the exception, as it is everywhere else: it has no
 * `EloquentBuilder` to attach to, so `associate()`/`dissociate()` are
 * real methods on `MorphToBuilder`.
 *
 * ## Pivot writes bypass the related model
 *
 * Every pivot statement here is built as a bare `QueryBuilder` over the
 * pivot table, never through the related model's builder. That is
 * required for correctness: the related model's
 * global scopes describe which *related rows are readable*, and have no
 * business filtering which *pivot rows exist*. Reading the current ids
 * for a `sync()` diff through a scoped builder would omit the pivot rows
 * whose related row is soft-deleted, and `sync()` would then cheerfully
 * re-insert them, turning a soft delete into a duplicate-key error, or
 * worse, a resurrection.
 *
 * ## Pivot attributes are raw
 *
 * Pivot payloads are written in DB shape with no casts applied, matching
 * Laravel. A pivot table has no model, so there is no `casts` map to
 * consult. `withTimestamps` is the one value this layer fills in itself.
 */

/** A pivot row's extra columns, raw DB-shape values, no casts (see the module docstring). */
export type PivotAttributes = Record<string, SqlBinding>;

/** Anything accepted where a related key is expected: the key itself, or a model instance to read it off. */
export type RelatedKey = SqlBinding | Model;

/**
 * The ids argument to `attach()`/`sync()`: a single key, a list of keys,
 * or a `{ key: pivotAttributes }` map for per-row pivot payloads.
 *
 * The map form is keyed by the *stringified* key, because JS object keys
 * are strings, `{ 1: { weight: 9 } }` and `{ "1": ... }` are the same
 * thing. Numeric keys survive the round trip because the value is
 * matched against the DB, not compared in JS; see `normalizeIdMap()`.
 */
export type AttachIds = RelatedKey | RelatedKey[] | Record<string, PivotAttributes>;

/**
 * What `sync()`/`syncWithoutDetaching()` report, Laravel's three buckets,
 * same names.
 *
 * `updated` is every id that was **already linked and was supplied
 * attributes**, which is what it has always meant in practice: the diff
 * reads only the pivot's keys (`currentPivotIds()`), never its payloads,
 * so it has never been in a position to compare an old value against a
 * new one and report "changed". Deriving it from the pre-write link set
 * rather than from an affected-row count also makes it mean the same
 * thing on every engine, where MySQL reports 0 affected rows for an
 * update that wrote identical values and the others report 1.
 */
export interface SyncResult {
  attached: SqlBinding[];
  detached: SqlBinding[];
  updated: SqlBinding[];
}

/** What `toggle()` reports. */
export interface ToggleResult {
  attached: SqlBinding[];
  detached: SqlBinding[];
}

/**
 * The write-side view of a pivot relation, normalised across
 * `belongsToMany`, `morphToMany` and `morphedByMany`, the same
 * flattening `PivotQuerySpec` does for reads, and for the same reason:
 * the three differ only in which pivot column points where.
 */
interface PivotWriteSpec {
  pivotTable: string;
  /** Pivot column pointing at THIS (declaring) model. */
  thisPivotKey: string;
  /** Pivot column pointing at the RELATED model. */
  relatedPivotKey: string;
  /** This row's key value, written into `thisPivotKey`. */
  localValue: SqlBinding;
  /** Discriminant column on the pivot, for the polymorphic variants. */
  morphType?: string;
  /** Discriminant value. Which SIDE it names differs per relation. See the option interfaces. */
  morphValue?: string;
  /** Whether to stamp `created_at`/`updated_at` on pivot rows. */
  withTimestamps: boolean;
}

/** The write API a `belongsToMany`/`morphToMany`/`morphedByMany` accessor gains. */
export interface BelongsToManyWrites {
  /**
   * Inserts pivot rows linking this parent to `ids`. Accepts a key, a
   * model instance, a list of either, or a `{ key: pivotAttrs }` map;
   * `pivot` supplies attributes shared by every row.
   *
   *   await post.relations.tags().attach(tag);
   *   await post.relations.tags().attach([1, 2], { source: "import" });
   *   await post.relations.tags().attach({ 1: { weight: 9 } });
   *
   * Inserts nothing for an empty list. A duplicate link surfaces the
   * database's own unique-constraint error as
   * `UniqueConstraintViolationException`. `attach()` does not dedupe,
   * exactly like Laravel; use `syncWithoutDetaching()` for that.
   */
  attach(ids: AttachIds, pivot?: PivotAttributes): Promise<void>;

  /**
   * Deletes pivot rows, returning how many went. With **no argument**
   * detaches every related row; with a list, only those.
   *
   *   await post.relations.tags().detach();      // all
   *   await post.relations.tags().detach([1]);   // one
   *   await post.relations.tags().detach([]);    // NOTHING. See below
   *
   * `detach([])` is a **no-op**, not "detach all". Laravel has the same
   * rule and it is a well-known footgun: `detach($request->input('ids'))`
   * with an empty selection must not wipe the relation. The distinction
   * is `undefined` (no argument) vs an empty list.
   */
  detach(ids?: RelatedKey | RelatedKey[]): Promise<number>;

  /**
   * Makes the pivot match `ids` exactly: inserts links that are missing,
   * deletes links not present (unless `detaching` is `false`), and
   * rewrites the pivot attributes of links that are already present and
   * were supplied some.
   *
   *   await post.relations.tags().sync([1, 2, 3]);
   *   await post.relations.tags().sync({ 1: { weight: 9 } });
   *
   * Runs in a transaction, joining the caller's via savepoint when there
   * is one, so a partially-applied diff can't survive an error.
   *
   * The `updated` bucket only ever contains ids given *with* attributes:
   * `sync([1,2,3])` supplies none, so it never reports an update.
   *
   * **Four statements at most, whatever the size of `ids`**: the SELECT
   * that reads the current links, then one UPDATE
   * (`batchUpdatePivotRows()`), one INSERT (`insertPivotRows()`) and one
   * DELETE (`deletePivotRows()`), each skipped when its bucket is empty.
   */
  sync(ids: AttachIds, detaching?: boolean): Promise<SyncResult>;

  /** `sync()` without the delete half, adds and updates, never removes. */
  syncWithoutDetaching(ids: AttachIds): Promise<SyncResult>;

  /**
   * `sync()` applying one shared pivot payload to every id, Laravel's
   * `syncWithPivotValues()`.
   *
   *   await post.relations.tags().syncWithPivotValues([1, 2], { source: "import" });
   *
   * Because every id carries attributes, ids already linked land in
   * `updated` (their payload is rewritten), not silently skipped.
   */
  syncWithPivotValues(
    ids: RelatedKey | RelatedKey[],
    values: PivotAttributes,
    detaching?: boolean,
  ): Promise<SyncResult>;

  /**
   * Flips each id: attaches the ones not currently linked, detaches the
   * ones that are, Laravel's `toggle()`. Runs in a transaction.
   */
  toggle(ids: RelatedKey | RelatedKey[]): Promise<ToggleResult>;

  /**
   * Updates the pivot row for one already-attached id, returning the
   * number of pivot rows written (0 if the link doesn't exist).
   * Stamps `updated_at` when the relation declares `withTimestamps`.
   *
   * One id, so one plain `UPDATE` (`updatePivotRow()`), not the batched
   * form `sync()` uses. This is also the only caller that needs the
   * affected-row count, since "the link doesn't exist" is a result here
   * rather than something the caller already knows.
   */
  updateExistingPivot(id: RelatedKey, attributes: PivotAttributes): Promise<number>;
}

/** The write API a `belongsTo` accessor gains. */
export interface BelongsToWrites<TParent = Model> {
  /**
   * Points the parent's foreign key at `target` and sets the loaded
   * relation, so `post.author` reads back as the new owner immediately.
   *
   *   post.relations.author().associate(user);
   *   await post.save();
   *
   * **Does not save**. Laravel doesn't either. It sets an attribute on
   * the parent, and persisting the parent is the caller's call (which is
   * what lets several associates and a field edit share one `UPDATE`).
   * Accepts a bare key as well as an instance; passing a key can't set
   * the loaded relation, so that is left untouched rather than filled
   * with a half-truth.
   */
  associate(target: RelatedKey): TParent;

  /** Nulls the foreign key and clears the loaded relation. Does not save. */
  dissociate(): TParent;
}

/**
 * The write API a `hasOne`/`hasMany`/`morphOne`/`morphMany` accessor
 * gains. `TRelated` is the related model's instance type and `TAttrs`
 * its attribute shape, so `create()` name-checks its columns.
 */
export interface HasManyWrites<TRelated = Model, TAttrs = Record<string, any>> {
  /**
   * Points `model` at this parent (setting the foreign key, and the
   * morph type for a polymorphic relation) and saves it.
   *
   *   await user.relations.posts().save(new Post({ title: "Hi" }));
   *
   * Works for an unsaved instance (an `INSERT`) and an existing one (a
   * re-parenting `UPDATE`).
   */
  save(model: TRelated): Promise<TRelated>;

  /** `save()` for several models, in order. Returns them. */
  saveMany(models: TRelated[]): Promise<TRelated[]>;

  /**
   * Creates a related row already pointing at this parent.
   *
   *   const post = await user.relations.posts().create({ title: "Hi" });
   *
   * Goes through the related model's `create()`, so its timestamps,
   * generated-id read-back and `creating`/`created` events all fire.
   *
   * The foreign key is `Partial` here because this call supplies it,
   * requiring the caller to pass the very column the relation is about
   * to overwrite would be nonsense.
   */
  create(attributes?: Partial<TAttrs>): Promise<TRelated>;

  /** `create()` for several rows, in order. */
  createMany(attributes: Partial<TAttrs>[]): Promise<TRelated[]>;
}

/**
 * The extra methods a relation of each `type` contributes to its
 * accessor's return type. `RelationBuilders` (model.ts) intersects this
 * onto `BuilderOf<Related>` so a custom builder keeps its own scopes.
 * See this module's docstring.
 *
 * `morphTo` maps to `unknown` because its accessor is a `MorphToBuilder`,
 * which declares `associate()`/`dissociate()` as real methods; there is
 * nothing to intersect on. `hasManyThrough`/`hasOneThrough` map to
 * `unknown` because they are read-only (Laravel too): a write would have
 * to invent the intermediate row, and there is no single correct guess.
 */
export type RelationWritesFor<Def> = Def extends {
  type: "belongsToMany" | "morphToMany" | "morphedByMany";
}
  ? BelongsToManyWrites
  : Def extends { type: "belongsTo" }
    ? BelongsToWrites
    : Def extends { type: "hasOne" | "hasMany" | "morphOne" | "morphMany" }
      ? HasManyWrites<RelatedInstanceOf<Def>, RelatedRowOf<Def>>
      : unknown;

/** Reads the key off a model instance, or passes a bare key through. */
function keyOf(value: RelatedKey): SqlBinding {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Model).getKey === "function"
  ) {
    return (value as Model).getKey();
  }

  return value as SqlBinding;
}

/** Normalises the `detach()`/`toggle()` argument (key | key[] | instances) to a key list. */
function keyList(ids: RelatedKey | RelatedKey[]): SqlBinding[] {
  return (Array.isArray(ids) ? ids : [ids]).map(keyOf);
}

/**
 * `true` for the `{ key: pivotAttrs }` map form of `AttachIds`.
 *
 * A `Model` is an object too, so instances are excluded explicitly.
 * `attach(tag)` must be read as one id, not as a map of its columns.
 * Arrays are likewise objects and are handled before this is reached.
 */
function isIdMap(ids: AttachIds): ids is Record<string, PivotAttributes> {
  return (
    typeof ids === "object" &&
    ids !== null &&
    !Array.isArray(ids) &&
    typeof (ids as Model).getKey !== "function"
  );
}

/**
 * Flattens any `AttachIds` into `[key, attributes]` pairs, preserving
 * order and merging in the shared `pivot` payload (per-row attributes
 * win over the shared ones).
 *
 * Map keys come back as strings, which is correct for the write path.
 * They are bound as parameters and compared by the database, where
 * `'1'` and `1` match an integer column alike. Restoring their original
 * JS type is impossible (the object already stringified them) and
 * unnecessary; `sync()` compares against DB-returned ids through
 * `sameKey()`, which is deliberately type-insensitive for exactly this
 * reason.
 */
function normalizeIdMap(ids: AttachIds, shared?: PivotAttributes): [SqlBinding, PivotAttributes][] {
  if (isIdMap(ids)) {
    return Object.entries(ids).map(([key, attributes]) => [
      key as SqlBinding,
      { ...shared, ...attributes },
    ]);
  }

  return keyList(ids as RelatedKey | RelatedKey[]).map((key) => [key, { ...shared }]);
}

/**
 * Key equality across the JS/DB type boundary, `1` and `"1"` are the
 * same row.
 *
 * `sync()` compares ids the caller supplied against ids the driver
 * returned, and those can legitimately differ in JS type: an object-map
 * key is always a string, MySQL hands back `BIGINT` columns as strings,
 * SQLite returns integers. A strict `===` would see no overlap, report
 * every existing link as both detached and attached, and churn the
 * pivot on every sync. Comparing the string spelling is what the
 * database itself does for these columns.
 */

/**
 * Derives the write spec for a pivot relation from its definition and
 * the parent instance, the single place the three pivot relations'
 * column layouts are resolved, mirroring `buildPivotQuery()` on the read
 * side so the two cannot drift.
 *
 * Returns `undefined` for a non-pivot relation.
 */
function pivotSpecFor(parent: Model, definition: RelationDefinition): PivotWriteSpec | undefined {
  const owner = parent.constructor as AnyModelClass;

  if (definition.type === "belongsToMany") {
    const options = definition.options as BelongsToManyOptions<
      Record<string, any>,
      Record<string, any>
    >;

    return {
      pivotTable: options.pivotTable,
      thisPivotKey: options.foreignPivotKey,
      relatedPivotKey: options.relatedPivotKey,
      localValue: parent.getRawAttribute(options.localKey ?? owner.primaryKeyColumn),
      withTimestamps: options.withTimestamps === true,
    };
  }

  if (definition.type === "morphToMany") {
    const options = definition.options as MorphToManyOptions<
      Record<string, any>,
      Record<string, any>
    >;

    return {
      pivotTable: options.pivotTable,
      thisPivotKey: options.morphId,
      relatedPivotKey: options.relatedPivotKey,
      localValue: parent.getRawAttribute(options.localKey ?? owner.primaryKeyColumn),
      morphType: options.morphType,
      // The pivot discriminates THIS model. See MorphToManyOptions.
      morphValue: options.type ?? owner.morphAlias(),
      withTimestamps: options.withTimestamps === true,
    };
  }

  if (definition.type === "morphedByMany") {
    const options = definition.options as MorphedByManyOptions<
      Record<string, any>,
      Record<string, any>
    >;
    const related = definition.related() as unknown as AnyModelClass;

    return {
      pivotTable: options.pivotTable,
      thisPivotKey: options.foreignPivotKey,
      relatedPivotKey: options.morphId,
      localValue: parent.getRawAttribute(options.localKey ?? owner.primaryKeyColumn),
      morphType: options.morphType,
      // The pivot discriminates the RELATED model on this side.
      morphValue: options.type ?? related.morphAlias(),
      withTimestamps: options.withTimestamps === true,
    };
  }

  return undefined;
}

/**
 * The pivot-table query builder, scoped to this parent (and this morph
 * discriminant, when the relation is polymorphic).
 *
 * Built straight from the owning model's connection thunk rather than
 * the related model's builder, so it is transaction-aware
 * (`resolveConnection()` swaps in an active transaction) while staying
 * free of the related model's global scopes. See the module docstring.
 */
function pivotQuery(owner: AnyModelClass, spec: PivotWriteSpec): QueryBuilder<Record<string, any>> {
  const query = new QueryBuilder<Record<string, any>>(
    () => owner.resolveConnection(),
    spec.pivotTable,
  );
  query.where(spec.thisPivotKey, spec.localValue);

  if (spec.morphType) {
    query.where(spec.morphType, spec.morphValue as SqlBinding);
  }

  return query;
}

/** The pivot columns identifying this parent, the base of every row `attach()` writes. */
function parentPivotColumns(spec: PivotWriteSpec): Record<string, SqlBinding> {
  const columns: Record<string, SqlBinding> = { [spec.thisPivotKey]: spec.localValue };

  if (spec.morphType) {
    columns[spec.morphType] = spec.morphValue as SqlBinding;
  }

  return columns;
}

/** The related-key values currently linked to this parent, one SELECT over the pivot table. */
async function currentPivotIds(owner: AnyModelClass, spec: PivotWriteSpec): Promise<SqlBinding[]> {
  const rows = await pivotQuery(owner, spec).select(spec.relatedPivotKey).get();

  return rows.map((row) => row[spec.relatedPivotKey] as SqlBinding);
}

/**
 * Inserts the pivot rows for `pairs` as a **single multi-row INSERT**,
 * stamping timestamps when the relation asks for them.
 *
 * Goes to Kysely directly rather than looping `QueryBuilder.insert()`,
 * which takes one row: `sync()`ing fifty tags should be one statement,
 * not fifty round trips.
 */
async function insertPivotRows(
  owner: AnyModelClass,
  spec: PivotWriteSpec,
  pairs: [SqlBinding, PivotAttributes][],
): Promise<void> {
  if (pairs.length === 0) {
    return;
  }

  const connection = owner.resolveConnection();
  const now = spec.withTimestamps ? currentTimestampFor(connection) : undefined;
  const base = parentPivotColumns(spec);

  const rows = pairs.map(([key, attributes]) => {
    const row: Record<string, SqlBinding> = { ...base, [spec.relatedPivotKey]: key };

    if (now !== undefined) {
      row.created_at = now;
      row.updated_at = now;
    }

    // Caller-supplied attributes win, so an explicit `created_at` in a
    // pivot payload is honoured rather than overwritten by the stamp.
    return { ...row, ...attributes };
  });

  await connection
    .insertInto(spec.pivotTable)
    .values(rows as any)
    .execute();
}

/** Deletes the pivot rows linking this parent to `keys` (or all of them when `keys` is undefined). */
async function deletePivotRows(
  owner: AnyModelClass,
  spec: PivotWriteSpec,
  keys?: SqlBinding[],
): Promise<number> {
  const query = pivotQuery(owner, spec);

  if (keys !== undefined) {
    if (keys.length === 0) {
      return 0;
    }

    query.whereIn(spec.relatedPivotKey, keys);
  }

  return query.delete();
}

/** Updates one pivot row's attributes, stamping `updated_at` when the relation declares timestamps. */
async function updatePivotRow(
  owner: AnyModelClass,
  spec: PivotWriteSpec,
  key: SqlBinding,
  attributes: PivotAttributes,
): Promise<number> {
  const values: Record<string, SqlBinding> = { ...attributes };

  if (spec.withTimestamps && values.updated_at === undefined) {
    values.updated_at = currentTimestampFor(owner.resolveConnection());
  }

  if (Object.keys(values).length === 0) {
    return 0;
  }

  return pivotQuery(owner, spec).where(spec.relatedPivotKey, key).update(values);
}

/**
 * Updates the pivot rows for `pairs` as a **single UPDATE**, each column
 * assigned a `CASE` over the related key:
 *
 *   UPDATE post_tag
 *      SET weight = CASE WHEN tag_id = ? THEN ? WHEN tag_id = ? THEN ? ELSE weight END,
 *          updated_at = ?
 *    WHERE post_id = ? AND tag_id IN (?, ?)
 *
 * Every pair must already be linked; this writes, it never inserts.
 *
 * Laravel updates one row per statement here, and so did this, but each
 * one was *awaited* inside `runSync()`'s loop, making a refresh of n
 * attribute-carrying links n sequential round trips with the
 * transaction's row locks held across all of them. The insert and delete
 * halves of `sync()` were already single statements
 * (`insertPivotRows()`, `deletePivotRows()`); this is the third.
 *
 * ## Why `CASE`, and not an upsert
 *
 * `ON CONFLICT ... DO UPDATE` would fold this into the insert, but a
 * multi-row `INSERT` must name the same columns for every row, so
 * `sync({ 1: { weight: 9 }, 2: { note: "x" } })` would pad the gaps and
 * overwrite row 1's `note` with a default. Laravel's per-row `UPDATE`
 * names only the columns that id supplied, which is what `ELSE <column>`
 * reproduces: a matched row whose payload omitted a column keeps the
 * value it had. The upsert would also need a unique index on the pivot's
 * key pair, which `attach()` does not require and which MySQL would not
 * complain about the absence of.
 *
 * `ELSE <column>` earns its place twice over: it is also the typed
 * anchor Postgres resolves the untyped `THEN` parameters against, which
 * a bare `CASE WHEN ... THEN $1 END` has no way to do.
 *
 * ## Timestamps
 *
 * `updated_at` is stamped once for every matched row, and `created_at`
 * is never assigned *by this function*, so a refresh cannot rewrite when
 * a link was made. An id that passes either column explicitly still
 * wins for its own row, matching `insertPivotRows()`, where a payload's
 * own `created_at` also beats the stamp. For `updated_at` the stamp
 * becomes that `CASE`'s fallback rather than the column, because every
 * row the statement matches is being written and so none of them should
 * keep an older value.
 *
 * A column whose value is an explicit `null` is written, clearing it; an
 * `undefined` one is treated as "not supplied" and skipped.
 */
async function batchUpdatePivotRows(
  owner: AnyModelClass,
  spec: PivotWriteSpec,
  pairs: [SqlBinding, PivotAttributes][],
): Promise<number> {
  if (pairs.length === 0) {
    return 0;
  }

  // First-seen order across every payload, so the SET list is stable
  // rather than dependent on which id happened to carry which column.
  const columns: string[] = [];

  for (const [, attributes] of pairs) {
    for (const [column, value] of Object.entries(attributes)) {
      if (value !== undefined && !columns.includes(column)) {
        columns.push(column);
      }
    }
  }

  const now = spec.withTimestamps ? currentTimestampFor(owner.resolveConnection()) : undefined;
  const values: Record<string, unknown> = {};

  for (const column of columns) {
    const branches = pairs
      .filter(([, attributes]) => attributes[column] !== undefined)
      .map(
        ([key, attributes]) =>
          sql`when ${sql.ref(spec.relatedPivotKey)} = ${key} then ${attributes[column]}`,
      );

    const fallback = column === "updated_at" && now !== undefined ? now : sql.ref(column);

    values[column] = sql`case ${sql.join(branches, sql` `)} else ${fallback} end`;
  }

  if (now !== undefined && !columns.includes("updated_at")) {
    values.updated_at = now;
  }

  if (Object.keys(values).length === 0) {
    return 0;
  }

  return pivotQuery(owner, spec)
    .whereIn(
      spec.relatedPivotKey,
      pairs.map(([key]) => key),
    )
    .update(values);
}

/**
 * Runs `work` inside a transaction on this model's connection.
 *
 * `transaction()` nests via savepoint when one is already open, so a
 * `sync()` inside a caller's transaction becomes part of it (and is
 * undone with it) rather than committing independently.
 */
function inTransaction<T>(owner: AnyModelClass, work: () => Promise<T>): Promise<T> {
  return transaction(owner.rootConnection() as Kysely<any>, () => work());
}

/** The shared `sync()` engine behind `sync()`/`syncWithoutDetaching()`/`syncWithPivotValues()`. */
async function runSync(
  owner: AnyModelClass,
  spec: PivotWriteSpec,
  ids: AttachIds,
  detaching: boolean,
  shared?: PivotAttributes,
): Promise<SyncResult> {
  const desired = normalizeIdMap(ids, shared);

  return inTransaction(owner, async () => {
    const current = await currentPivotIds(owner, spec);

    const attached: SqlBinding[] = [];
    const updated: SqlBinding[] = [];
    const toInsert: [SqlBinding, PivotAttributes][] = [];
    const toUpdate: [SqlBinding, PivotAttributes][] = [];

    for (const [key, attributes] of desired) {
      if (!current.some((existing) => sameKey(existing, key))) {
        toInsert.push([key, attributes]);
        attached.push(key);
        continue;
      }

      // Already linked. Laravel only reports (and only writes) an update
      // when attributes were actually supplied for this id, a plain
      // `sync([1,2,3])` must not rewrite pivot payloads it said nothing
      // about, nor claim in its result that it did.
      if (Object.keys(attributes).length > 0) {
        toUpdate.push([key, attributes]);
        updated.push(key);
      }
    }

    await batchUpdatePivotRows(owner, spec, toUpdate);
    await insertPivotRows(owner, spec, toInsert);

    const detached: SqlBinding[] = [];

    if (detaching) {
      const extra = current.filter((existing) => !desired.some(([key]) => sameKey(existing, key)));

      if (extra.length > 0) {
        await deletePivotRows(owner, spec, extra);
        detached.push(...extra);
      }
    }

    return { attached, detached, updated };
  });
}

/** Builds the `BelongsToManyWrites` implementation bound to one parent row and relation definition. */
function belongsToManyWrites(parent: Model, spec: PivotWriteSpec): BelongsToManyWrites {
  const owner = parent.constructor as AnyModelClass;

  return {
    async attach(ids: AttachIds, pivot?: PivotAttributes): Promise<void> {
      await insertPivotRows(owner, spec, normalizeIdMap(ids, pivot));
    },

    async detach(ids?: RelatedKey | RelatedKey[]): Promise<number> {
      // `undefined` means "all"; an empty array means "nothing". See the
      // interface docstring. The distinction is the whole point.
      return deletePivotRows(owner, spec, ids === undefined ? undefined : keyList(ids));
    },

    async sync(ids: AttachIds, detaching = true): Promise<SyncResult> {
      return runSync(owner, spec, ids, detaching);
    },

    async syncWithoutDetaching(ids: AttachIds): Promise<SyncResult> {
      return runSync(owner, spec, ids, false);
    },

    async syncWithPivotValues(
      ids: RelatedKey | RelatedKey[],
      values: PivotAttributes,
      detaching = true,
    ): Promise<SyncResult> {
      return runSync(owner, spec, ids, detaching, values);
    },

    async toggle(ids: RelatedKey | RelatedKey[]): Promise<ToggleResult> {
      const keys = keyList(ids);

      return inTransaction(owner, async () => {
        const current = await currentPivotIds(owner, spec);

        const detach = keys.filter((key) => current.some((existing) => sameKey(existing, key)));
        const attach = keys.filter((key) => !current.some((existing) => sameKey(existing, key)));

        if (detach.length > 0) {
          await deletePivotRows(owner, spec, detach);
        }

        await insertPivotRows(
          owner,
          spec,
          attach.map((key) => [key, {}] as [SqlBinding, PivotAttributes]),
        );

        return { attached: attach, detached: detach };
      });
    },

    async updateExistingPivot(id: RelatedKey, attributes: PivotAttributes): Promise<number> {
      return updatePivotRow(owner, spec, keyOf(id), attributes);
    },
  };
}

/** Builds the `BelongsToWrites` implementation for a `belongsTo` relation. */
function belongsToWrites(
  parent: Model,
  name: string,
  definition: Extract<RelationDefinition, { type: "belongsTo" }>,
): BelongsToWrites {
  const options = definition.options as BelongsToOptions<Record<string, any>, Record<string, any>>;
  const related = definition.related() as unknown as AnyModelClass;
  const ownerKey = options.ownerKey ?? related.primaryKeyColumn;

  return {
    associate(target: RelatedKey): Model {
      const isInstance =
        target !== null &&
        typeof target === "object" &&
        typeof (target as Model).getKey === "function";

      const value = isInstance
        ? (target as Model).getRawAttribute(ownerKey)
        : (target as SqlBinding);

      parent.setAttribute(options.foreignKey, value);

      // Only an instance can populate the loaded relation. Given a bare
      // key there is nothing to set, and inventing a stub would make
      // `post.author` a lie; leaving the previous value alone would be
      // worse still, so it is cleared. Both return the casting proxy,
      // which is what the caller holds and must get back.
      return isInstance ? parent.setRelation(name, target) : parent.unsetRelation(name);
    },

    dissociate(): Model {
      parent.setAttribute(options.foreignKey, null);

      return parent.unsetRelation(name);
    },
  };
}

/**
 * Builds the `HasManyWrites` implementation for a `hasOne`/`hasMany`/
 * `morphOne`/`morphMany` relation, the foreign key (and morph
 * discriminant) this parent stamps onto its children.
 */
function hasManyWrites(
  parent: Model,
  definition: Extract<
    RelationDefinition,
    { type: "hasOne" | "hasMany" | "morphOne" | "morphMany" }
  >,
): HasManyWrites {
  const owner = parent.constructor as AnyModelClass;
  const related = definition.related() as unknown as AnyModelClass;

  const foreignKeys = (): Record<string, any> => {
    if (definition.type === "morphOne" || definition.type === "morphMany") {
      const options = definition.options as MorphManyOptions<
        Record<string, any>,
        Record<string, any>
      >;
      const localKey = options.localKey ?? owner.primaryKeyColumn;

      return {
        [options.morphId]: parent.getRawAttribute(localKey),
        [options.morphType]: options.type ?? owner.morphAlias(),
      };
    }

    const options = definition.options as HasManyOptions<Record<string, any>, Record<string, any>>;
    const localKey = options.localKey ?? owner.primaryKeyColumn;

    return { [options.foreignKey]: parent.getRawAttribute(localKey) };
  };

  const saveOne = async (model: Model): Promise<Model> => {
    for (const [column, value] of Object.entries(foreignKeys())) {
      model.setAttribute(column, value);
    }

    // `save()` returns the casting proxy, which is what the caller
    // should hold onto, not the raw target they may have passed in.
    return model.save();
  };

  return {
    async save(model: Model): Promise<Model> {
      return saveOne(model);
    },

    async saveMany(models: Model[]): Promise<Model[]> {
      const saved: Model[] = [];

      for (const model of models) {
        saved.push(await saveOne(model));
      }

      return saved;
    },

    async create(attributes: Record<string, any> = {}): Promise<Model> {
      // Through the related model's own `create()`, so its timestamps,
      // generated-id read-back and creating/created events all fire.
      return (await (related as any).create({ ...attributes, ...foreignKeys() })) as Model;
    },

    async createMany(attributes: Record<string, any>[]): Promise<Model[]> {
      const created: Model[] = [];

      for (const values of attributes) {
        created.push((await (related as any).create({ ...values, ...foreignKeys() })) as Model);
      }

      return created;
    },
  };
}

/**
 * Attaches the write methods for `definition` onto the read builder that
 * relation just produced, and returns it.
 *
 * Called by `buildRelationBuilder()` for every relation except `morphTo`
 * (whose writes live on `MorphToBuilder`) and the two `*Through` kinds
 * (read-only). A relation with no write API is returned untouched.
 *
 * The methods are assigned as own properties rather than mixed into a
 * prototype: the builder is a fresh object per accessor call and each
 * closure needs *this* parent row, so there is nothing to share.
 */
export function attachRelationWrites(
  parent: Model,
  name: string,
  definition: RelationDefinition,
  builder: EloquentBuilder<Record<string, any>>,
): EloquentBuilder<Record<string, any>> {
  const spec = pivotSpecFor(parent, definition);

  if (spec) {
    return Object.assign(builder, belongsToManyWrites(parent, spec));
  }

  if (definition.type === "belongsTo") {
    return Object.assign(builder, belongsToWrites(parent, name, definition));
  }

  if (
    definition.type === "hasOne" ||
    definition.type === "hasMany" ||
    definition.type === "morphOne" ||
    definition.type === "morphMany"
  ) {
    return Object.assign(builder, hasManyWrites(parent, definition));
  }

  return builder;
}
