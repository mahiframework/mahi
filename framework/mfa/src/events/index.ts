/**
 * MFA events.
 *
 * ## Why these exist
 *
 * A second factor is the thing an application most wants to notify users
 * about and audit: a factor appearing on an account nobody added it to is
 * an account takeover in progress, a burst of failed verifications is an
 * attack, and a recovery code being used means someone lost their phone.
 * None of that was observable before, so every application had to
 * reimplement it around the controllers that call this package.
 *
 * ## Nine events, over verified state transitions
 *
 * | Event | Dispatched by |
 * | --- | --- |
 * | `MethodEnrolled` | `TotpDriver.enroll()` — unconfirmed, not yet usable |
 * | `MethodConfirmed` | `TotpDriver.confirm()` — now usable |
 * | `ChallengeIssued` | `EmailDriver.challenge()`, `issued` path |
 * | `ChallengeThrottled` | `EmailDriver.challenge()`, `throttled` path |
 * | `Verified` | `MfaManager.verify()`, once per intent |
 * | `VerificationFailed` | `MfaManager.verify()`, wrong code only |
 * | `IntentLocked` | `MfaManager.verify()`, the failure that locks |
 * | `RecoveryCodesGenerated` | `RecoveryDriver.generate()` |
 * | `RecoveryCodeUsed` | `RecoveryDriver.verify()`, on success |
 *
 * ## No credential is ever on an event
 *
 * The TOTP secret, the emailed code, the magic link and the generated
 * recovery codes are all absent by design. Each is returned by the method
 * that mints it, to its one caller, which delivers or displays it. The
 * models protect serialisation with `hidden`, but an event payload bypasses
 * that, and a listener persisting its payload would write the credential
 * to disk. Events carry ids, driver names, counts and expiries.
 *
 * ## Errors propagate
 *
 * `fireMfaEvent()` does not catch. A throwing listener fails the MFA
 * operation, matching `@mahiframework/auth` rather than
 * `@mahiframework/queue`. See that function's docstring.
 *
 * ## What is deliberately not dispatched
 *
 * - **No intent-created event.** `createIntent()` returns an existing live
 *   intent when one matches, so it is idempotent by reuse and a dispatch
 *   there would fire on every page load that re-entered the flow.
 * - **No intent-expired event.** Expiry is enforced on read; there is no
 *   `expired` status and no write at the moment of expiry, so there is
 *   nothing to observe. `mfa:gc` reports an aggregate count instead.
 * - **Nothing on a failed confirmation.** `confirm()` returns `false` for a
 *   wrong code, a stale row and an already-confirmed row alike, without
 *   distinguishing them, so an event could not say which happened.
 * - **No method-removed event**, because the package has no removal path.
 *   An app that deletes an `MfaMethod` row itself should log that itself.
 *
 * ## Soft dependency
 *
 * Dispatch is a no-op when `EVENTS_TOKEN` is unbound, so an application
 * with no `EventsServiceProvider` gets working MFA and no events.
 *
 * `@mahiframework/events` is nonetheless a declared dependency, for the
 * same reason `@mahiframework/auth` declares it: it is already an
 * unavoidable transitive one (`mfa` depends on `auth`, which depends on
 * `events`), so naming it adds nothing to the install graph and buys
 * `AbstractEvent`. That matters beyond types — it is what makes
 * `Event.suppress()` silence these events and what gives them a stable
 * `eventName` for pattern matching.
 */

export { MfaEvent } from "./mfa-event.js";
export { fireMfaEvent } from "./fire-mfa-event.js";

export { ChallengeIssued } from "./challenge-issued.js";
export { ChallengeThrottled } from "./challenge-throttled.js";
export { IntentLocked } from "./intent-locked.js";
export { MethodConfirmed } from "./method-confirmed.js";
export { MethodEnrolled } from "./method-enrolled.js";
export { RecoveryCodeUsed } from "./recovery-code-used.js";
export { RecoveryCodesGenerated } from "./recovery-codes-generated.js";
export { VerificationFailed } from "./verification-failed.js";
export { Verified } from "./verified.js";
