import type { AnyModelClass } from "@mahiframework/database";
import { DateTime } from "@mahiframework/datetime";

/**
 * Email verification as plain composable functions, NOT a trait/mixin,
 * `Model` rows are plain objects, so there's no class to mix into. These
 * mirror the free-function shape of `requireAuth`/`requireGuest` in
 * `@mahiframework/authorization`, operating on any row that carries an
 * `email_verified_at` column.
 *
 * There is deliberately no `MustVerifyEmail` interface to implement and
 * no base class: opting a model in is just adding the nullable
 * `email_verified_at` column in its migration. Sending the notification
 * is the app's job (it needs `@mahiframework/mail` and a signed URL from
 * `@mahiframework/http`'s `signedUrl()`); these helpers only cover the
 * state-check and state-transition mechanics.
 */

/** The column verification state lives in. Kept configurable per call for unusual schemas. */
const DEFAULT_COLUMN = "email_verified_at";

/**
 * A row with (at least) an `email_verified_at` field.
 *
 * `object`, not `Record<string, unknown>`: the column is chosen at runtime,
 * so nothing here can be checked statically anyway, and a `Record`
 * constraint would reject every model instance whose attributes are
 * declared with an `interface` (interfaces have no implicit index
 * signature). Which is exactly how the model docs teach declaring them.
 */
export type Verifiable = object;

/** Whether `user`'s email has been verified (its `email_verified_at` is set). */
export function hasVerifiedEmail(user: Verifiable, column: string = DEFAULT_COLUMN): boolean {
  const value = (user as Record<string, unknown>)[column];

  return value !== null && value !== undefined;
}

/**
 * Stamp `email_verified_at = now` for the user with the given primary
 * key, via the model's static `update()`. Returns the timestamp written.
 *
 * Idempotent at the storage layer, calling it twice simply rewrites the
 * timestamp; callers that must not "re-verify" should guard with
 * `hasVerifiedEmail()` first. `EmailVerificationBroker.verify()` does
 * exactly that, and dispatches `EmailVerified` only on the transition.
 * This function fires nothing: it is the raw write, and a caller stamping
 * the column directly has not necessarily verified anything.
 */
export async function markEmailAsVerified(
  model: AnyModelClass,
  userId: string,
  column: string = DEFAULT_COLUMN,
): Promise<string> {
  // Written as a `DateTime`, the builder converts to UTC and spells it
  // for the engine, and it is correct whether the app's model declares
  // the column as a cast `DateTime` or as plain text. The ISO string is
  // still what's *returned*, since the column is chosen at runtime and
  // callers have no cast information to interpret a richer type with.
  const now = DateTime.now();
  await model.update(userId, { [column]: now });

  return now.setTimezone("UTC").toISOString();
}
