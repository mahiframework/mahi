import { AuthEvent } from "./auth-event.js";

/**
 * A password-reset token was minted for a real account.
 *
 * Dispatched by `PasswordBroker.sendResetLink()` on the `"sent"` path
 * only, which has a consequence worth stating plainly: **it does not fire
 * for an unknown address.** `sendResetLink()` returns `{ status: "sent" }`
 * for both a real and an unknown address so a caller relaying the status
 * cannot tell them apart, and this event deliberately does not undo that
 * at the event layer, where an audit row would record the distinction the
 * response worked to hide.
 *
 * It also does not fire on the throttled path, where no token was minted.
 *
 * So the event answers "a reset credential now exists", not "someone
 * asked for a reset". An application wanting the latter, which is the
 * better signal for detecting an enumeration sweep, should count requests
 * at its own controller or with `throttle()` middleware, where the
 * unknown-address attempts are visible.
 *
 * **The token is deliberately absent.** It is a credential; see
 * `TokenCreated`.
 */
export class PasswordResetLinkSent extends AuthEvent {
  static override eventName = "auth.PasswordResetLinkSent";

  constructor(
    public readonly email: string,
    public readonly user: unknown,
  ) {
    super();
  }
}
