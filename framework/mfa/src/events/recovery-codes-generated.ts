import { MfaEvent } from "./mfa-event.js";

/**
 * A set of recovery codes was generated, replacing any previous set.
 *
 * Dispatched by `RecoveryDriver.generate()`. `replaced` is how many rows
 * the call deleted, which is what distinguishes a first-time generation
 * (`0`) from a regeneration without the caller having to track it.
 *
 * That distinction is the reason the count is captured at all. A user
 * regenerates because they believe the old list is lost or compromised,
 * and a regeneration they did not perform is an attacker locking them out
 * of their own recovery path.
 *
 * **The codes are deliberately absent.** `generate()` returns the
 * plaintext set exactly once, to its caller, and nothing can read it back
 * afterwards. An event carrying them would make that claim false.
 */
export class RecoveryCodesGenerated extends MfaEvent {
  static override eventName = "mfa.RecoveryCodesGenerated";

  constructor(
    userId: string,
    public readonly count: number,
    public readonly replaced: number,
  ) {
    super(userId);
  }
}
