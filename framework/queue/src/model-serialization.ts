import { Collection } from "@mahiframework/core";
import {
  BaseModel,
  ModelNotFoundError,
  type Model,
  type ModelRegistry,
} from "@mahiframework/database";

/**
 * The on-the-wire shape a serialized model reference takes inside a job
 * payload. Deliberately verbose keys (`__model`/`__id`) so a plain data
 * object a user happens to put in a payload is very unlikely to collide.
 *
 * `__id` carries a 64-bit key as a **decimal string**. A payload is
 * `JSON.stringify`d by every driver, which throws on a `bigint`
 * outright, and a JSON number would round a 19-digit id into a
 * different one. `decodeModels()` reads it back through
 * `modelClass.keyStrategy`, so the model is looked up with the type its
 * column actually uses.
 */
export interface ModelReference {
  __model: string;
  __id: string | number;
}

/**
 * The on-the-wire shape of a bare `bigint` in a job payload — a 64-bit
 * id carried as data rather than as a model instance.
 *
 * JSON has no 64-bit integer type and `JSON.stringify` throws on a
 * `bigint`, so it travels as text. Tagged rather than written as a plain
 * string so it can be restored to a `bigint`: a job declaring
 * `readonly ids: bigint[]` must not receive strings after a round trip
 * through the queue table, or `whereIn("id", ids)` would match nothing.
 */
export interface BigintReference {
  __bigint: string;
}

/**
 * Thrown by `decodeModels()` when a referenced model no longer resolves
 * *and* that model opted into `static deleteWhenMissingModels = true`.
 * Caught by `runJobThroughMiddleware()`, which treats it as "skip this
 * job successfully". The job is removed from the queue without running
 * and without being marked failed. Not exported from the package: it's an
 * internal control-flow signal, never something a job author handles.
 */
export class SkipJobMissingModelError extends Error {
  constructor(
    public readonly morphName: string,
    public readonly id: string | number,
  ) {
    super(
      `Skipping job: model [${morphName}] with id [${String(id)}] no longer ` +
        `exists and deleteWhenMissingModels is enabled.`,
    );
    this.name = "SkipJobMissingModelError";
  }
}

function isModelReference(value: unknown): value is ModelReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ModelReference).__model === "string" &&
    "__id" in value
  );
}

function isBigintReference(value: unknown): value is BigintReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BigintReference).__bigint === "string"
  );
}

/**
 * Walks a job payload and replaces every live `Model` instance (and any
 * `Model` inside a `Collection` or array) with a `{ __model, __id }`
 * reference, leaving all other data untouched. Runs synchronously at
 * dispatch time, *before* the payload reaches a driver's `JSON.stringify`,
 * so a durable driver persists the small reference, not the model's full
 * `toJSON()` attribute dump.
 *
 * A model whose class has no `static morphName` throws here (loudly, at
 * dispatch) rather than being silently serialized as opaque data. You
 * can't accidentally enqueue an unserializable model.
 *
 * Only `Model`/`Collection` instances are transformed; other class
 * instances pass through untouched (predictable, no surprising deep
 * traversal of arbitrary objects). Plain objects and arrays are recursed.
 */
export function encodeModels(payload: unknown, registry: ModelRegistry): unknown {
  return encodeValue(payload, registry, new WeakSet());
}

function encodeValue(value: unknown, registry: ModelRegistry, seen: WeakSet<object>): unknown {
  if (value instanceof BaseModel) {
    const morphName = registry.nameFor(value);

    if (morphName === undefined) {
      throw new Error(
        `Cannot serialize model [${value.constructor.name}] into a job payload: ` +
          `it has no static morphName. Add \`static override morphName = "..."\` ` +
          `and register it via a provider's models() hook.`,
      );
    }

    const id = value.getKey();

    if (id === null || id === undefined) {
      throw new Error(
        `Cannot serialize model [${value.constructor.name}] into a job payload: ` +
          `it has no primary-key value (has it been saved?).`,
      );
    }

    // A `bigint` key goes over the wire as a string: `JSON.stringify`
    // throws on one, and a JSON number could not hold it exactly.
    return {
      __model: morphName,
      __id: typeof id === "bigint" ? id.toString() : (id as string | number),
    } satisfies ModelReference;
  }

  if (value instanceof Collection) {
    return value.all().map((item) => encodeValue(item, registry, seen));
  }

  if (Array.isArray(value)) {
    return value.map((item) => encodeValue(item, registry, seen));
  }

  // A bare `bigint` in a payload — an id the caller passed as data
  // rather than as a model — would otherwise make the driver's
  // `JSON.stringify` throw at dispatch. Tagged so `decodeModels()` can
  // restore it as a `bigint` rather than silently handing `handle()` a
  // string where it declared one.
  if (typeof value === "bigint") {
    return { __bigint: value.toString() } satisfies BigintReference;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return value;
    }

    seen.add(value);
    const out: Record<string, unknown> = {};

    for (const [key, v] of Object.entries(value)) {
      out[key] = encodeValue(v, registry, seen);
    }

    return out;
  }

  return value;
}

/**
 * Walks a (decoded-from-JSON or in-memory) job payload and replaces every
 * `{ __model, __id }` reference with the live model instance it names,
 * loading each via its registered class. Runs just before `handle()`, for
 * both the sync driver and the worker, so a job always sees rehydrated
 * models regardless of which driver ran it.
 *
 * Lookups are batched per model type (all ids for one `morphName` load in
 * a single `findMany()`), so a payload carrying an array/`Collection` of
 * the same model doesn't cause an N+1.
 *
 * Missing rows: if a referenced id has no row, behaviour depends on that
 * model's `static deleteWhenMissingModels`.
 *
 *   - `false` (the default) throws `ModelNotFoundError`, and the worker
 *     treats that as a **failure of this job**: it goes to `failed_jobs`
 *     with the error, and the worker carries on. It is not retried.
 *     The row will still be missing next time.
 *   - `true` throws `SkipJobMissingModelError` and the worker deletes the
 *     job without running or failing it: "this work no longer applies".
 *
 * (Under `sync` there is no queue, so `ModelNotFoundError` simply
 * surfaces to the dispatch site.)
 */
export async function decodeModels(payload: unknown, registry: ModelRegistry): Promise<unknown> {
  // Pass 1: collect every referenced id, grouped by morphName.
  const idsByModel = new Map<string, Set<string | number>>();
  collectReferences(payload, idsByModel);

  // Still walked when there are no models: a payload can carry tagged
  // `bigint`s on their own, and returning here would hand `handle()` a
  // `{ __bigint }` object where it declared a `bigint`.
  if (idsByModel.size === 0) {
    return rehydrateValue(payload, new Map());
  }

  // Pass 2: batch-load each model type, keyed by stringified id.
  const loaded = new Map<string, Map<string, Model>>();

  for (const [morphName, ids] of idsByModel) {
    const modelClass = registry.resolve(morphName);
    // A 64-bit key travelled as a decimal string (JSON has no bigint),
    // so it has to be widened back or the lookup would compare text
    // against a `bigInteger` column and match nothing.
    //
    // Guarded by the spelling rather than by `keyStrategy.type` alone:
    // the default strategy reports `"bigint"` because an auto-increment
    // column is 64-bit, but a model is free to declare a `string` key
    // and assign it by hand, and `BigInt("u1")` throws.
    const collection = await modelClass.findMany(
      [...ids].map((id) =>
        modelClass.keyStrategy.type === "bigint" && isDecimalInteger(id) ? BigInt(id) : id,
      ),
    );
    const byId = new Map<string, Model>();

    for (const instance of collection.all()) {
      byId.set(String(instance.getKey()), instance);
    }

    // Fail fast on any missing id, honoring deleteWhenMissingModels.
    for (const id of ids) {
      if (!byId.has(String(id))) {
        if (modelClass.deleteWhenMissingModels) {
          throw new SkipJobMissingModelError(morphName, id);
        }

        throw new ModelNotFoundError(modelClass.name, id);
      }
    }

    loaded.set(morphName, byId);
  }

  // Pass 3: rebuild the payload, swapping references for instances.
  return rehydrateValue(payload, loaded);
}

/**
 * Whether a serialized `__id` is a plain decimal integer, and so may
 * have been a `bigint` before JSON flattened it to text.
 *
 * Anything else — a UUID, a slug, `"u1"` — is a genuine string key and
 * must be left alone.
 */
function isDecimalInteger(id: string | number): boolean {
  return typeof id === "string" && /^-?\d+$/.test(id);
}

function collectReferences(value: unknown, into: Map<string, Set<string | number>>): void {
  if (isModelReference(value)) {
    let set = into.get(value.__model);

    if (set === undefined) {
      set = new Set();
      into.set(value.__model, set);
    }

    set.add(value.__id);

    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, into);
    }

    return;
  }

  if (isPlainObject(value)) {
    for (const v of Object.values(value)) {
      collectReferences(v, into);
    }
  }
}

function rehydrateValue(value: unknown, loaded: Map<string, Map<string, Model>>): unknown {
  if (isModelReference(value)) {
    // Presence already validated in decodeModels; non-null assertion is safe.
    return loaded.get(value.__model)!.get(String(value.__id))!;
  }

  if (isBigintReference(value)) {
    return BigInt(value.__bigint);
  }

  if (Array.isArray(value)) {
    return value.map((item) => rehydrateValue(item, loaded));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};

    for (const [key, v] of Object.entries(value)) {
      out[key] = rehydrateValue(v, loaded);
    }

    return out;
  }

  return value;
}

/**
 * A "plain" data object, one worth recursing into. Excludes class
 * instances (whose prototype isn't `Object.prototype`/`null`), so a
 * `Model` proxy, `DateTime`, `Collection`, etc. are never walked as if
 * they were anonymous data bags. `Model`/`Collection` are handled by
 * their own branches before this is ever reached.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}
