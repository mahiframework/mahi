import { DateTime } from "@mahiframework/datetime";
import { formatTimestamp } from "./timestamps.js";
import type { SqlBinding } from "./query-builder.js";
import type { Dialect } from "./schema/dialect.js";

/**
 * A value a caller may hand to a `where()`, a `whereIn()` list, a raw
 * binding, or a write payload, the *author-facing* counterpart to
 * `SqlBinding` (which is the narrower set a driver will actually bind).
 *
 * The distinction matters: `SqlBinding` is a contract with `pg` /
 * `mysql2` / `better-sqlite3`, and it cannot widen, because those
 * libraries reject anything else. `Bindable` is a contract with the
 * person writing the query, and it *should* be wide, because the
 * alternative is making every call site serialise by hand:
 *
 *     .where("expires_at", "<=", DateTime.now("UTC").toISOString())
 *
 * That spelling has two problems beyond the noise. It puts the UTC
 * decision on the caller (get it wrong and you write local wall-clock
 * into a UTC column. See `normalizeBinding()`), and it produces an
 * ISO `Z` string that MySQL rejects outright for a `DATETIME` column.
 * Both are decisions the layer that knows the dialect should be making,
 * so `Bindable` lets the caller pass the value and `normalizeBinding()`
 * resolves it.
 *
 * The model member is structural (`{ getKey(): SqlBinding }`) rather
 * than `Model`: `bindings.ts` sits underneath the ORM, and importing
 * the class would close a cycle (`model.ts` → `eloquent-builder.ts` →
 * `query-builder.ts` → here). It also matches how the relationship
 * writers already sniff for an instance (`relationship-writes.ts`).
 */
export type Bindable = SqlBinding | DateTime | Date | bigint | { getKey(): SqlBinding };

/** Whether `value` is a model instance, by the presence of a callable `getKey`. */
function hasKey(value: unknown): value is { getKey(): SqlBinding } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getKey?: unknown }).getKey === "function"
  );
}

/**
 * One value on its way to a driver, converted into a shape that driver
 * can bind, the single place object-to-scalar serialisation happens,
 * so no call site has to.
 *
 * The conversions:
 *
 * - **`DateTime` → text, always in UTC.** Delegating to
 *   `formatTimestamp()` buys both halves of the problem at once. It
 *   calls `setTimezone("UTC")` first, which matters:
 *   `DateTime.toISOString()` renders in *the instance's own zone*, so a
 *   `DateTime.now()` created in Perth stringifies as
 *   `...T14:30:00.000+08:00`. Postgres `timestamptz` understands that,
 *   but `timestamp`, MySQL and SQLite do not. They store the local
 *   wall clock as though it were UTC, silently shifting the value by
 *   the offset. Converting here means `DateTime.now()` and
 *   `DateTime.now("UTC")` bind identically, which is the only defensible
 *   behaviour when the column stores UTC. `formatTimestamp()` also
 *   applies MySQL's space-separated spelling, since MySQL rejects the
 *   ISO `Z`.
 * - **`Date` → the same**, routed through `DateTime` so there is one
 *   formatting path rather than two.
 * - **`bigint` → itself.** All three drivers bind one natively
 *   (better-sqlite3 directly, `pg` and `mysql2` by stringifying it
 *   losslessly), and it is what a 64-bit column now reads back as, so
 *   `where("id", row.id)` has to round-trip unchanged. Converting to a
 *   `number` here would round any id past `MAX_SAFE_INTEGER` into a
 *   query for a different row.
 * - **A model instance → its key.** `where("user_id", user)` is what
 *   the caller means; `getKey()` returns the already-DB-shaped raw
 *   attribute, so the result needs no further work.
 *
 * Anything else is returned **by identity**, unchanged. Callers rely on
 * that (`normalized === original` is how they skip allocating a copy),
 * and it is what keeps the function **idempotent**: a value that has
 * already been through `castWrite()`/`prepareWrite()` is a string by
 * then and passes straight through, so applying this twice is safe.
 *
 * Deliberately *not* handled: plain objects and arrays. Serialising
 * those to JSON here would mean a typo'd value silently lands in the
 * column as `{}` or `[object Object]` instead of failing loudly, and
 * JSON columns already have an explicit, declared answer in
 * `Cast.json()` / `Cast.array()`.
 */
export function normalizeBinding(dialect: Dialect, value: unknown): unknown {
  if (value instanceof DateTime) {
    return formatTimestamp(dialect, value);
  }

  if (value instanceof Date) {
    return formatTimestamp(dialect, DateTime.fromISO(value.toISOString(), "UTC"));
  }

  if (hasKey(value)) {
    return normalizeBinding(dialect, value.getKey());
  }

  return value;
}

/**
 * `normalizeBinding()` across a list, returning the **original array**
 * when nothing changed so the common path allocates nothing.
 */
export function normalizeBindings(
  dialect: Dialect,
  values: readonly unknown[],
): readonly unknown[] {
  let copy: unknown[] | undefined;

  for (let i = 0; i < values.length; i++) {
    const normalized = normalizeBinding(dialect, values[i]);

    if (normalized === values[i]) {
      continue;
    }

    copy ??= [...values];
    copy[i] = normalized;
  }

  return copy ?? values;
}
