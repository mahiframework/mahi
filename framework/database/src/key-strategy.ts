/**
 * Primary-key generation strategies, the `keyType` config replacing the
 * old `incrementing` boolean + `newUniqueId()` override pair.
 *
 * Three built-ins are named by string:
 *
 * - `"increment"`, the DB generates the key (auto-increment / identity).
 *   The insert path reads it back (`RETURNING` on PG/SQLite, `insertId`
 *   on MySQL). Requires the primary-key column to be a `number`.
 * - `"uuid"`, a client-generated `randomUUID()` string, assigned before
 *   insert. Requires a `string` primary-key column.
 * - a `KeyStrategy` object, anything else, e.g. `@mahiframework/snowflake`'s
 *   `snowflake()`.
 *
 * A `KeyStrategy` runs after the `saving` hook (so that hook can still
 * supply an explicit key) and before `creating` (so both `creating` and
 * the insert see the value).
 */

import { randomUUID } from "node:crypto";

/**
 * Context handed to a `KeyStrategy.generate()` call, the model class
 * name, which `@mahiframework/snowflake` uses as its per-model sequence group.
 */
export interface KeyStrategyContext {
  modelName: string;
}

/**
 * A client-side primary-key generator. `type` declares what the key is
 * (used to validate against the column type); `generate` produces the
 * value, sync or async.
 *
 * `"bigint"` is for a 64-bit key the application assigns, which is what
 * `@mahiframework/snowflake`'s `snowflake()` returns. It needs its own
 * arm because a snowflake exceeds `Number.MAX_SAFE_INTEGER`, so a
 * `number` would round it into a different id.
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
   * route parameter. All of those carry a snowflake as a decimal string,
   * and querying a `bigInteger` column with one would match nothing.
   *
   * `"bigint"` for an auto-increment key too — those are 64-bit on every
   * engine (`bigserial`, `BIGINT AUTO_INCREMENT`, a SQLite rowid) and
   * read back as `bigint`.
   */
  type: "string" | "number" | "bigint";
}

/** The built-in `"uuid"` strategy. */
export function uuidKeyStrategy(): KeyStrategy<string> {
  return {
    type: "string",
    generate() {
      return randomUUID();
    },
  };
}

/**
 * Normalises a `keyType` config value into its runtime behaviour.
 * `"increment"` (the default) → DB-generated; `"uuid"` → client UUID;
 * a `KeyStrategy` object → its own `generate`.
 */
export function resolveKeyType(
  keyType: "increment" | "uuid" | KeyStrategy | undefined,
): ResolvedKeyType {
  if (keyType === undefined || keyType === "increment") {
    // An auto-increment key is 64-bit on every engine this framework
    // supports, and reads back as a `bigint`.
    return { incrementing: true, type: "bigint" };
  }

  if (keyType === "uuid") {
    return { incrementing: false, generate: uuidKeyStrategy().generate, type: "string" };
  }

  return { incrementing: false, generate: keyType.generate, type: keyType.type };
}
