import type { DateTime } from "@mahiframework/datetime";
import { MfaEvent } from "./mfa-event.js";

/**
 * A challenge credential was minted and handed to the caller to deliver.
 *
 * Dispatched by `EmailDriver.challenge()` on the `issued` path. TOTP and
 * recovery never fire it: they return `ready`, because the user already
 * holds the factor and there is nothing to send.
 *
 * Worth observing for the count. Repeated sends to one address is the
 * signal that someone is hammering a victim's inbox, and the driver's own
 * `throttleSeconds` only rate-limits it rather than reporting it.
 *
 * **The code is deliberately absent**, and so is the magic link. Both are
 * the credential. `challenge()` returns them to its caller, which
 * delivers them; an event carrying either would spread it to every
 * listener, audit row and queued job in the application.
 */
export class ChallengeIssued extends MfaEvent {
  static override eventName = "mfa.ChallengeIssued";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly intentId: string,
    public readonly challengeId: string,
    public readonly expiresAt: DateTime,
  ) {
    super(userId);
  }
}
