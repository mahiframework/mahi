import { HttpError } from "@mahiframework/http";

/**
 * The errors `requireMfa()` throws.
 *
 * All three extend `HttpError`, so the framework's existing error
 * handler renders them through the usual JSON envelope with the right
 * status and no special-casing. The payload rides in `details`, which
 * `HttpError` already carries, so none of this needs a change to
 * `@mahiframework/http`.
 *
 * A structured payload rather than a bare 403 because the client has a
 * decision to make: the whole flow is "here are the methods you can use,
 * pick one", and a message string cannot drive that UI.
 */

/** Machine-readable discriminant on every MFA error payload. */
export type MfaErrorCode = "mfa_required" | "mfa_enrollment_required" | "mfa_locked";

export interface MfaRequiredDetails {
  code: "mfa_required";
  /** The purpose that was required, null for a generic check. */
  purpose: string | null;
  /** Driver names this user can verify with right now. */
  available: string[];
}

export interface MfaEnrollmentRequiredDetails {
  code: "mfa_enrollment_required";
  purpose: string | null;
  /** Driver names this user could enroll in. */
  enrollable: string[];
}

export interface MfaLockedDetails {
  code: "mfa_locked";
  purpose: string | null;
}

/**
 * 403: the user is authenticated and enrolled, but has not verified for
 * this purpose (or at all).
 *
 * Also thrown when a verified intent exists for a DIFFERENT named
 * purpose, which is why `purpose` is on the payload: the client has to
 * say "verify again for this action", not "you are not verified". That
 * case cannot arise for a generic check, which any verified intent
 * satisfies.
 *
 * 403 rather than 401 follows the split `HttpError.unauthorized()`
 * documents: authenticating differently could resolve a 401, and no
 * credential change resolves this. The user must perform an action.
 */
export class MfaRequiredError extends HttpError {
  constructor(purpose: string | null, available: string[]) {
    super(403, "Multi-factor verification is required.", {
      code: "mfa_required",
      purpose,
      available,
    } satisfies MfaRequiredDetails);
    this.name = "MfaRequiredError";
  }
}

/**
 * 403: the user has nothing enrolled, and the configured
 * `whenUnenrolled` policy is `challenge`.
 *
 * Distinct from `MfaRequiredError` because the client's next step is
 * different: enrollment, not verification. Under the `deny` policy this
 * is not thrown at all; the user gets `MfaRequiredError` with an empty
 * `available`, which correctly says "you cannot proceed" without
 * implying a path that policy does not offer.
 */
export class MfaEnrollmentRequiredError extends HttpError {
  constructor(purpose: string | null, enrollable: string[]) {
    super(403, "Multi-factor enrollment is required.", {
      code: "mfa_enrollment_required",
      purpose,
      enrollable,
    } satisfies MfaEnrollmentRequiredDetails);
    this.name = "MfaEnrollmentRequiredError";
  }
}

/**
 * 403: too many failed attempts against the intent.
 *
 * Terminal for that intent; the user starts a new one. Per-intent
 * rather than per-user on purpose, so one attacker cannot lock a victim
 * out of step-up verification entirely.
 */
export class MfaLockedError extends HttpError {
  constructor(purpose: string | null) {
    super(403, "Too many failed verification attempts.", {
      code: "mfa_locked",
      purpose,
    } satisfies MfaLockedDetails);
    this.name = "MfaLockedError";
  }
}

/**
 * Thrown when a bare `requireMfa()` runs with no MFA context open.
 *
 * NOT an `HttpError`: reaching this is a wiring bug, not a client
 * error, and rendering it as a 4xx would hide it. Two causes, and the
 * message names both because they need different fixes:
 *
 * - `MfaServiceProvider` is missing from `config/app.ts`, or is listed
 *   after `HttpServiceProvider` so its pipe was never collected.
 * - The call is outside a request entirely (a queue job, a CLI
 *   command), where there is no session to bind to. Those callers pass
 *   an explicit request, or resolve the manager directly.
 *
 * Deliberately neither a pass nor a deny. Passing would be a silent
 * bypass; denying would be a confusing 403 nobody can act on.
 */
export class MissingMfaContextError extends Error {
  constructor() {
    super(
      "No MFA context is active. Either MfaServiceProvider is not registered " +
        "(it must be listed after AuthServiceProvider and before HttpServiceProvider), " +
        "or this call is outside an HTTP request, in which case pass the request explicitly.",
    );
    this.name = "MissingMfaContextError";
  }
}

/** Thrown when a driver is asked for by name and was never registered. */
export class UnknownMfaDriverError extends Error {
  constructor(name: string) {
    super(`MFA driver "${name}" is not registered.`);
    this.name = "UnknownMfaDriverError";
  }
}
