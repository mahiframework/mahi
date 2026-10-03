import { app, AUTH_TOKEN } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { HttpError } from "@mahiframework/http";
import type { Request } from "@mahiframework/http";
import type { WhenUnenrolled } from "./mfa-config.js";
import type { MfaManager } from "./mfa-manager.js";
import { MfaIntent } from "./models/mfa-intent.js";
import { MFA_TOKEN } from "./tokens.js";
import { currentMfaState, requireMfaState } from "./mfa-context.js";
import { MfaEnrollmentRequiredError, MfaLockedError, MfaRequiredError } from "./errors.js";

export interface RequireMfaOptions {
  /** Override the configured policy for a user with nothing enrolled. */
  whenUnenrolled?: WhenUnenrolled;
  /**
   * The request to read the session binding from.
   *
   * Only needed outside an HTTP request (a queue job, a CLI command),
   * where there is no ambient MFA scope. Inside one, omit it.
   */
  request?: Request;
}

/**
 * In-controller MFA helpers.
 *
 * Free functions rather than facade statics, matching
 * `@mahiframework/authorization`'s `authorize()`/`allows()`/`denies()`:
 * they read the ambient scope, they are the inline counterpart to a
 * route middleware, and the throwing/boolean pair is the established
 * shape for "framework decides pass/fail, app decides presentation".
 *
 *   await requireMfa("change_password");
 *   if (await mfaVerified()) { ... }
 *
 * ⚠️ THESE ARE ASYNC AND MUST BE AWAITED. A forgotten `await` on
 * `requireMfa()` does not fail: the promise floats, the rejection never
 * reaches the handler, and execution continues past an unverified
 * check. That is an auth bypass, and it is why this repo enables
 * `@typescript-eslint/no-floating-promises` (see `eslint.config.js`).
 * Prefer the `ensureMfa()` route middleware where the check applies to
 * a whole endpoint, since a pipe cannot be mis-awaited.
 */
function manager(): MfaManager {
  return app().make<MfaManager>(MFA_TOKEN);
}

/** The authenticated user id, or throw a 401. */
function currentUserId(): string {
  const auth = app().make<{ userOrNull(): unknown }>(AUTH_TOKEN);
  const user = auth.userOrNull();

  if (user === null || typeof user !== "object") {
    // 401, not 403: this is "we do not know who you are", which
    // authenticating would fix.
    throw HttpError.unauthorized();
  }

  const id = (user as Record<string, unknown>)["id"];

  if (id === undefined || id === null) {
    throw HttpError.unauthorized();
  }

  return String(id);
}

/**
 * The binding for this check.
 *
 * Inside a request the provider's pipe already computed it; outside
 * one, an explicit request is required and the binding is derived on
 * the spot. Passing a request inside a scope overrides the scope, which
 * is what makes the magic-link endpoint able to verify against the
 * request that carries the signature.
 */
function bindingFor(options: RequireMfaOptions): string | null {
  if (options.request !== undefined) {
    return manager().bindingFor(options.request);
  }

  // Throws `MissingMfaContextError` outside a scope, deliberately:
  // neither passing nor denying is a defensible answer to "the wiring
  // is wrong". See that error's docblock.
  return requireMfaState().binding;
}

/**
 * Require a live verified MFA intent, or throw.
 *
 * `purpose` omitted means a generic check, satisfied by ANY live
 * verified intent. A named purpose is satisfied only by its exact
 * match. See `MfaManager.hasVerified()` for why that asymmetry is the
 * right way round.
 */
export async function requireMfa(
  purpose?: string | null,
  options: RequireMfaOptions = {},
): Promise<void> {
  const required = purpose ?? null;
  const mfa = manager();
  const userId = currentUserId();
  const binding = bindingFor(options);

  if (await mfa.hasVerified(userId, required, binding)) {
    return;
  }

  const available = await mfa.available(userId);

  if (available.length === 0) {
    const policy = options.whenUnenrolled ?? mfa.whenUnenrolled;

    if (policy === "allow") {
      return;
    }

    if (policy === "challenge") {
      throw new MfaEnrollmentRequiredError(required, mfa.configuredDrivers());
    }

    // `deny` falls through to MfaRequiredError with an empty
    // `available`, which correctly says "you cannot proceed" without
    // advertising an enrollment path this policy does not offer.
  }

  // A locked intent is reported as such so the client can say "start
  // again" rather than re-prompting into a wall. Only checked on the
  // failure path, so the happy path costs one query.
  if (await hasLockedIntent(userId, required, binding)) {
    throw new MfaLockedError(required);
  }

  throw new MfaRequiredError(required, available);
}

/**
 * Whether a live verified intent satisfies `purpose`. The non-throwing
 * counterpart to `requireMfa()`, for rendering UI conditionally.
 */
export async function mfaVerified(
  purpose?: string | null,
  options: RequireMfaOptions = {},
): Promise<boolean> {
  return manager().hasVerified(currentUserId(), purpose ?? null, bindingFor(options));
}

/**
 * Whether the user's current attempt at this purpose is locked out.
 *
 * Deliberately not exported: it exists to pick the right error, and an
 * app branching on "locked" should read `details.code` off the thrown
 * error instead, so there is one source of truth for the condition.
 */
async function hasLockedIntent(
  userId: string,
  purpose: string | null,
  binding: string | null,
): Promise<boolean> {
  const query = MfaIntent.query()
    .where("user_id", "=", userId)
    .where("status", "=", "locked")
    .where("intent_expires_at", ">", DateTime.now());

  if (purpose !== null) {
    query.where("purpose", "=", purpose);
  }

  if (binding !== null) {
    query.where("binding", "=", binding);
  }

  return (await query.first()) !== undefined;
}

/** The active MFA binding, or null. Exposed for diagnostics and tests. */
export function currentMfaBinding(): string | null {
  return currentMfaState()?.binding ?? null;
}
