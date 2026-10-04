import { currentAuthState } from "@mahiframework/auth";

/**
 * The key of whoever triggered the current action, or null.
 *
 * `currentAuthState()`, NEVER `Auth.user()` or `Auth.userOrNull()`. Both
 * of those throw `MissingAuthContextError` outside a request scope —
 * `userOrNull()` included, deliberately, so a route that forgot
 * `authenticate()` fails loudly instead of silently reporting a guest.
 * `currentAuthState()` returns `undefined` instead and is the only
 * non-throwing primitive.
 *
 * That distinction is the whole reason this function exists: an activity
 * log written from a queue job or a CLI command has no actor, and that is
 * a `null` rather than an error. Using `userOrNull()` here would make
 * every logged model write inside a worker throw.
 */
export function currentActorKey(userKey: string): string | null {
  const state = currentAuthState();

  if (state === undefined || state.user === null || state.user === undefined) {
    return null;
  }

  return stringifyKey(state.user, userKey);
}

/**
 * A user object's key as a string, or null when it has none.
 *
 * Tries `getKey()` first, which every `Model` exposes and which is right
 * even when the primary key is not named `id`, then the configured
 * attribute. Both `bigint` and `number` stringify, matching how the
 * framework treats keys as decimal strings for cross-engine identity —
 * the scaffolded `User` keys on a snowflake, which is a `bigint`.
 *
 * Returns null rather than throwing on an unusual user source: a missing
 * actor is a weaker failure than a failed request, and the write should
 * still happen with `user_id` null.
 */
export function stringifyKey(user: unknown, userKey: string): string | null {
  if (user === null || typeof user !== "object") {
    return null;
  }

  const candidate = user as Record<string, unknown> & { getKey?: () => unknown };

  if (typeof candidate.getKey === "function") {
    const key = candidate.getKey();

    if (key !== null && key !== undefined) {
      return normalise(key);
    }
  }

  return normalise(candidate[userKey]);
}

function normalise(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
}

/**
 * The morph alias of a model instance, or undefined.
 *
 * Reads the class off the PROTOTYPE, not `instance.constructor`. A live
 * `Model` is `Proxy`-wrapped and the `get` trap binds every
 * function-valued property it returns, including `constructor`; a bound
 * function carries none of the original's statics, so
 * `instance.constructor.morphAlias` is undefined on a real model. The
 * prototype's own `constructor` is the unwrapped class.
 *
 * `morphAlias()` can throw `ClassMorphViolationError` under
 * `Relation.requireMorphMap()`. That is NOT caught here: enforcement
 * exists so an unregistered model fails loudly rather than silently
 * writing a string nothing can resolve later.
 */
export function morphAliasOf(instance: object): string | undefined {
  const modelClass = Object.getPrototypeOf(instance) as { constructor?: unknown } | null;
  const candidate = modelClass?.constructor as
    { morphAlias?: () => string; table?: string } | undefined;

  if (candidate === undefined) {
    return undefined;
  }

  if (typeof candidate.morphAlias === "function") {
    return candidate.morphAlias();
  }

  return candidate.table;
}

/** A model instance's primary key, stringified. */
export function modelKeyOf(instance: object): string | null {
  const candidate = instance as { getKey?: () => unknown; id?: unknown };

  if (typeof candidate.getKey === "function") {
    return normalise(candidate.getKey());
  }

  return normalise(candidate.id);
}
