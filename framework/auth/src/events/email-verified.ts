import { UserAuthEvent } from "./auth-event.js";

/**
 * A user's email address was verified.
 *
 * Dispatched by `EmailVerificationBroker.verify()` on the `"verified"`
 * path only. The `already-verified` branch does not fire: nothing changed,
 * and an application granting a one-time bonus on verification would
 * otherwise grant it on every refresh of the confirmation page.
 *
 * `invalid-hash` is also silent, which is worth knowing because that
 * branch is not merely a typo'd link: the hash is derived from the
 * current address, so a stale link failing to verify is the guard against
 * a link minted for an old address verifying a new one. An application
 * wanting to alert on that should watch for it in its own controller,
 * where the `VerificationResult` is in hand.
 *
 * `@mahiframework/auth`'s `email-verification.ts` noted the absence of
 * this event; this is it.
 */
export class EmailVerified extends UserAuthEvent {
  static override eventName = "auth.EmailVerified";

  constructor(
    userId: string,
    public readonly email: string,
    public readonly user: unknown,
  ) {
    super(userId);
  }
}
