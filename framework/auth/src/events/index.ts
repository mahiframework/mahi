/**
 * Authentication events.
 *
 * ## Why these exist
 *
 * Authentication is the subsystem an application most often needs to
 * observe without modifying: audit logs, failed-login alerting, "new
 * device" notifications, session-count metrics, forced re-verification.
 * Every one of those is a cross-cutting concern, and every one of them
 * had to be bolted onto a controller before these events existed, which
 * meant each application reimplemented them and an application that
 * forgot had a silent gap in its security record.
 *
 * ## Dispatch is in-band and a throwing listener propagates
 *
 * `fireAuthEvent()` does NOT catch listener errors. A listener that
 * throws fails the operation that dispatched it, so a listener registered
 * on `LoginFailed` can refuse a login by throwing, and a listener that
 * cannot write its audit row stops the action it was unable to record.
 * This follows `@mahiframework/database`'s model events rather than
 * `@mahiframework/queue`'s job events, which swallow.
 *
 * The consequence is real and must be understood before writing one: an
 * unhandled error in ANY auth listener is an authentication outage. A
 * listener doing something failure-prone (an HTTP call, a third-party
 * SDK) is responsible for its own `try`/`catch`. See
 * `docs/authentication/README.md`.
 *
 * ## Past tense only
 *
 * There are no `-ing` events. `Authenticating`/`LoggingOut` style hooks
 * would be a second, weaker authorization layer sitting beside the one
 * the framework already has, and "deny by throwing from a listener"
 * produces an error no route can translate into a sensible response.
 * Where a decision needs to be made, make it in a guard, a middleware, or
 * a gate. These events report what happened.
 *
 * ## Soft dependency
 *
 * Dispatch is a no-op when `EVENTS_TOKEN` is unbound, so an application
 * that does not register `EventsServiceProvider` is unaffected. Note that
 * `@mahiframework/events` is nonetheless a hard dependency of this
 * package: it is already an unavoidable transitive one through
 * `@mahiframework/database`, so declaring it adds nothing to the install
 * graph and buys compile-time types.
 */

export { AuthEvent, UserAuthEvent } from "./auth-event.js";

export { Attempted } from "./attempted.js";
export { Authenticated } from "./authenticated.js";
export { CurrentDeviceLogout } from "./current-device-logout.js";
export { EmailVerificationSent } from "./email-verification-sent.js";
export { EmailVerified } from "./email-verified.js";
export { Failed } from "./failed.js";
export { Login } from "./login.js";
export { Logout } from "./logout.js";
export { OtherDeviceLogout } from "./other-device-logout.js";
export { PasswordReset } from "./password-reset.js";
export { PasswordResetLinkSent } from "./password-reset-link-sent.js";
export { TokenCreated } from "./token-created.js";
export { TokenRevoked } from "./token-revoked.js";
export { CsrfTokenMismatch } from "./csrf-token-mismatch.js";
