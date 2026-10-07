/**
 * Primary-key generation strategies, the `keyType` config replacing the
 * `incrementing` boolean + `newUniqueId()` override pair.
 *
 * Built-ins named by string:
 *
 * - `"increment"`, the DB generates the key (auto-increment / identity).
 *   The insert path reads it back (`RETURNING` on PG/SQLite, `insertId`
 *   on MySQL). Requires the primary-key column to be a `number`.
 * - `"uuid"`, a client-generated `randomUUID()` (v4) string, assigned
 *   before insert. Requires a `string` primary-key column. Random, so it
 *   does not sort chronologically — see `uuidv7()` when it should.
 * - `"uuidv7"`, a client-generated UUID **v7** string. Same as above but
 *   time-ordered, which is almost always what you want for a primary
 *   key. See `uuidv7KeyStrategy()`.
 * - a `KeyStrategy` object, for a custom generator.
 *
 * A `KeyStrategy` runs after the `saving` hook (so that hook can still
 * supply an explicit key) and before `creating` (so both `creating` and
 * the insert see the value).
 */

import { randomUUID, randomUUIDv7 } from "node:crypto";

/**
 * Context handed to a `KeyStrategy.generate()` call. `modelName` lets a
 * custom strategy vary by model (a per-model prefix, a per-model
 * counter); the built-ins ignore it.
 */
export interface KeyStrategyContext {
  modelName: string;
}

/**
 * A client-side primary-key generator. `type` declares what the key is
 * (used to validate against the column type); `generate` produces the
 * value, sync or async.
 *
 * `"bigint"` is for a 64-bit integer key the application assigns. It
 * needs its own arm because such a key can exceed
 * `Number.MAX_SAFE_INTEGER`, so a `number` would round it into a
 * different id.
 */
export interface KeyStrategy<T extends string | number | bigint = string | number | bigint> {
  type: T extends string ? "string" : T extends bigint ? "bigint" : "number";
  generate(context: KeyStrategyContext): T | Promise<T>;
}

/** How a resolved `keyType` behaves at runtime. */
export interface ResolvedKeyType {
  /** `true` when the DB generates the key (read it back after insert). */
  incrementing: boolean;
  /** Generates a client-side key when `incrementing` is false, or `undefined` for none. */
  generate?: KeyStrategy["generate"];
  /**
   * What type the key is, so a caller holding one as text can restore it.
   *
   * Needed wherever a key makes a round trip through a format with no
   * 64-bit integer: a queue payload's `__id`, a pagination cursor, a
   * route parameter. A `bigint` key travels through those as a decimal
   * string, and querying a `bigInteger` column with one would match
   * nothing unless it is converted back.
   *
   * `"bigint"` for an auto-increment key too — those are 64-bit on every
   * engine (`bigserial`, `BIGINT AUTO_INCREMENT`, a SQLite rowid) and
   * read back as `bigint`.
   */
  type: "string" | "number" | "bigint";
}

/**
 * The built-in `"uuid"` strategy: a random (v4) UUID.
 *
 * Prefer `uuidv7KeyStrategy()` for a primary key. A v4 UUID is pure
 * entropy, so rows land in random index positions (poor insert locality)
 * and `ORDER BY id` is meaningless.
 */
export function uuidKeyStrategy(): KeyStrategy<string> {
  return {
    type: "string",
    generate() {
      return randomUUID();
    },
  };
}

/**
 * The built-in `"uuidv7"` strategy: a time-ordered UUID.
 *
 * The default choice for a client-generated primary key, and what
 * `make:model --uuidv7` scaffolds. A v7 UUID is a 48-bit millisecond
 * timestamp followed by 74 bits of entropy, which buys three things a v4
 * UUID does not:
 *
 * - **`ORDER BY id` is chronological**, so a cursor paginating on the
 *   primary key is stable and needs no secondary sort column;
 * - **insert locality**: consecutive inserts land next to each other in
 *   the index rather than scattering across it;
 * - **no coordination**: uniqueness comes from entropy, not from an
 *   operator assigning a distinct node/worker id per process. Several
 *   processes, containers or hosts can generate keys concurrently with
 *   no shared state and no configuration.
 *
 * Ordering is millisecond-granular: ids generated within the same
 * millisecond have no guaranteed order relative to each other. That is
 * fine for pagination and for "roughly when did this happen", and it is
 * not a monotonic sequence — do not use it as one.
 *
 * Requires a `string` primary key, stored in a `uuid` column
 * (`table.uuid("id").primary()`).
 */
export function uuidv7KeyStrategy(): KeyStrategy<string> {
  return {
    type: "string",
    generate() {
      return randomUUIDv7();
    },
  };
}

/**
 * A time-ordered UUID (v7) `KeyStrategy`, for use as a model's `keyType`:
 *
 *   interface WidgetAttributes { id: string; name: string; }
 *
 *   class Widget extends Model<WidgetAttributes>()({
 *     table: "widgets",
 *     primaryKey: "id",
 *     keyType: uuidv7(),
 *   }) {}
 *
 * Equivalent to the `keyType: "uuidv7"` string form; both exist so a
 * model can read either way. See `uuidv7KeyStrategy()` for why v7 rather
 * than v4, and the column requirements.
 */
export function uuidv7(): KeyStrategy<string> {
  return uuidv7KeyStrategy();
}

/**
 * Normalises a `keyType` config value into its runtime behaviour.
 * `"increment"` (the default) → DB-generated; `"uuid"` → random UUID;
 * `"uuidv7"` → time-ordered UUID; a `KeyStrategy` object → its own
 * `generate`.
 */
export function resolveKeyType(
  keyType: "increment" | "uuid" | "uuidv7" | KeyStrategy | undefined,
): ResolvedKeyType {
  if (keyType === undefined || keyType === "increment") {
    // An auto-increment key is 64-bit on every engine this framework
    // supports, and reads back as a `bigint`.
    return { incrementing: true, type: "bigint" };
  }

  if (keyType === "uuid") {
    return { incrementing: false, generate: uuidKeyStrategy().generate, type: "string" };
  }

  if (keyType === "uuidv7") {
    return { incrementing: false, generate: uuidv7KeyStrategy().generate, type: "string" };
  }

  return { incrementing: false, generate: keyType.generate, type: keyType.type };
}
