/**
 * A user object's primary key as a string, or null when it has none.
 *
 * `AuthManager.id()` asserts the key exists and throws otherwise, which is
 * right for a caller that has already authenticated. Building an event has
 * weaker standing: a user source keyed on something other than `id` is
 * unusual but legal, and authentication must not fail because an event
 * could not be constructed. So this returns null and the dispatch is
 * skipped.
 *
 * `bigint` and `number` both stringify, matching how the framework treats
 * keys as decimal strings for cross-engine identity. The scaffolded `User`
 * keys on a snowflake, which is a `bigint`.
 *
 * Its own module rather than a member of `AuthManager` so the guards can
 * use it without importing the manager, which would create a cycle
 * through `AuthServiceProvider`.
 */
export function userKey(user: unknown): string | null {
  if (user === null || typeof user !== "object") {
    return null;
  }

  const value = (user as Record<string, unknown>)["id"];

  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
}
