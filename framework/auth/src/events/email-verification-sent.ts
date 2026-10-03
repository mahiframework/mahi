import { UserAuthEvent } from "./auth-event.js";

/**
 * A verification link was minted for a user's email address.
 *
 * Dispatched by `EmailVerificationBroker.sendVerificationLink()` on the
 * `"sent"` path only, so neither an unknown user nor an
 * already-verified one fires it.
 *
 * **The signed URL is deliberately absent.** It is a capability: anyone
 * holding it can verify the address. The broker returns it to its caller,
 * which delivers it; an event carrying it would spread it to every
 * listener, audit row and log line in the application.
 *
 * A listener's legitimate use is counting: repeated verification sends to
 * one address is a signal, and that needs no URL.
 */
export class EmailVerificationSent extends UserAuthEvent {
  static override eventName = "auth.EmailVerificationSent";

  constructor(
    userId: string,
    public readonly email: string,
    public readonly user: unknown,
  ) {
    super(userId);
  }
}
