import { currentAuthState } from "@mahiframework/auth";
import type { SettingActor } from "./setting-definition.js";

/**
 * The key of whoever is authenticated right now, or null.
 *
 * `currentAuthState()`, NEVER `Auth.user()` or `Auth.userOrNull()`. Both
 * of those throw `MissingAuthContextError` outside a request scope —
 * `userOrNull()` included, deliberately, so a route that forgot
 * `authenticate()` fails loudly rather than silently reporting a guest.
 * `currentAuthState()` returns `undefined` instead, and is the only
 * non-throwing primitive.
 *
 * That distinction is the whole reason this exists. A setting written by
 * a seeder, a `settings:set` command or a queue worker has no actor, and
 * that is a `null` rather than an error — so reaching for `userOrNull()`
 * here would make every write outside a request throw. The same call
 * `activity-logs` makes, for the same reason.
 */
export function ambientActorKey(): string | null {
  const state = currentAuthState();

  if (state === undefined || state.user === null || state.user === undefined) {
    return null;
  }

  return stringifyActor(state.user);
}

/**
 * Resolve the `editedBy` argument into the key to store.
 *
 * Tri-state, matching `ActivityLogger.resolveUser()`: `undefined` means
 * "whoever is authenticated right now", an explicit `null` means
 * "deliberately unattributed". They are not the same thing, and a
 * command that means the second should not get the first by accident.
 */
export function resolveActor(actor: SettingActor | undefined): string | null {
  if (actor === undefined) {
    return ambientActorKey();
  }

  if (actor === null) {
    return null;
  }

  if (typeof actor === "object") {
    return stringifyActor(actor);
  }

  return String(actor);
}

/**
 * A user's key as a string, or null when it has none.
 *
 * `getKey()` first, which every `Model` exposes and which is right even
 * when the primary key is not named `id`, then `id` itself for a
 * non-model user (a token-guard adapter, a test stub). `bigint` and
 * `number` both stringify: the framework treats keys as decimal strings
 * for cross-engine identity, and the scaffolded `User` keys on an
 * auto-increment `bigint`.
 *
 * Returns null rather than throwing on an unusual user source. A missing
 * attribution is a weaker failure than a rejected write, and the setting
 * change should still land.
 */
function stringifyActor(user: object): string | null {
  const candidate = user as Record<string, unknown> & { getKey?: () => unknown };

  if (typeof candidate.getKey === "function") {
    const key = candidate.getKey();

    if (key !== null && key !== undefined) {
      return normalise(key);
    }
  }

  return normalise(candidate["id"]);
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
