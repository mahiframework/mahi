import { AuthEvent } from "./auth-event.js";

/**
 * A password was successfully reset through a reset token.
 *
 * Dispatched by `PasswordBroker.reset()` on success only. Every failure
 * branch (`invalid-token`, `expired-token`, `invalid-user`) is silent at
 * the event layer, because a reset attempt with a bad token is
 * indistinguishable from a probe and the broker burns a hash on those
 * paths precisely so they reveal nothing.
 *
 * This fires AFTER credential revocation, so by the time a listener runs,
 * every pre-existing session and API token for the user is already gone.
 * The `CurrentDeviceLogout`/`TokenRevoked` events for that revocation
 * have already been dispatched, with `reason: "password_reset"`.
 *
 * It is dispatched in addition to, not instead of, the existing
 * `onPasswordReset()` callback list. That callback predates these events
 * and remains supported; applications already using it need change
 * nothing.
 *
 * **The new password is deliberately absent**, hashed or otherwise.
 */
export class PasswordReset extends AuthEvent {
  static override eventName = "auth.PasswordReset";

  constructor(
    public readonly email: string,
    public readonly user: unknown,
  ) {
    super();
  }
}
