import { app, AUTH_TOKEN } from "@mahiframework/core";
import { BaseModel } from "@mahiframework/database";
import type { Assignee } from "../assignee.js";

/** The shape read off the `AuthManager` to find the current user. */
interface CurrentUserSource {
  userOrNull(): unknown | null;
}

/**
 * The authenticated subject, or null for a guest.
 *
 * Reads `AUTH_TOKEN` directly rather than `request.user()`, which wraps
 * its lookup in a `try`/`catch` and returns `undefined` on any failure.
 * That is the wrong shape here: it would turn "the route forgot
 * `authenticate()`, so there is no auth scope at all" into "this is a
 * guest", which is an authorization decision made by accident. The
 * underlying `MissingAuthContextError` must propagate and 500, exactly
 * as it does through `can()`.
 *
 * Returns null when auth isn't bound at all, so these pipes still behave
 * (as deny) in an app with no authentication.
 *
 * Only a `BaseModel` is usable: the pivots need a morph alias and a
 * `bigint` key, and a non-model user (a token-guard adapter, a stub)
 * has neither. Treated as a guest rather than thrown, because a pipe's
 * job is to answer allow/deny and a subject that cannot hold a role
 * holds none.
 */
export function currentSubject(): Assignee | null {
  const container = app();

  if (!container.has(AUTH_TOKEN)) {
    return null;
  }

  const user = container.make<CurrentUserSource>(AUTH_TOKEN).userOrNull();

  return user instanceof BaseModel ? user : null;
}
