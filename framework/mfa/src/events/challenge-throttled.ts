import { MfaEvent } from "./mfa-event.js";

/**
 * A challenge was refused because one was issued too recently.
 *
 * Dispatched by `EmailDriver.challenge()` on the `throttled` path, where
 * no code is minted and no row written.
 *
 * This is the per-mailbox throttle, not the route's rate limiter, and the
 * two answer different questions: middleware limits how often one client
 * may ask, this limits how often one mailbox may be written to. An
 * attacker rotating IPs to flood an inbox defeats the first and trips
 * this. Which makes a burst of these the more interesting signal of the
 * two.
 */
export class ChallengeThrottled extends MfaEvent {
  static override eventName = "mfa.ChallengeThrottled";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly intentId: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(userId);
  }
}
