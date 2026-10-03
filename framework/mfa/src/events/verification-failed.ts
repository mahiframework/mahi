import { MfaEvent } from "./mfa-event.js";

/**
 * A wrong code was submitted against an intent.
 *
 * Dispatched by `MfaManager.verify()` only for a genuinely incorrect code,
 * matching which outcomes count against `maxAttempts`. An expired
 * challenge, a missing one, or an intent with no driver chosen yet are not
 * guesses, so they neither increment the counter nor fire this — counting
 * them would let a slow user lock themselves out and would make the event
 * stream disagree with `attempts`.
 *
 * `attempts` is the count **after** this failure, and `remaining` is how
 * many are left before the intent locks, so a listener can warn at the
 * last one without knowing the configured maximum. `remaining` is 0 on the
 * failure that locks, which is the same moment `IntentLocked` fires.
 */
export class VerificationFailed extends MfaEvent {
  static override eventName = "mfa.VerificationFailed";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly intentId: string,
    public readonly attempts: number,
    public readonly remaining: number,
  ) {
    super(userId);
  }
}
