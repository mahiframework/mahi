import { MfaEvent } from "./mfa-event.js";

/**
 * A second factor was proved and an intent is now verified.
 *
 * Dispatched by `MfaManager.verify()` when the driver accepts the code,
 * after the intent row is written, so a listener observing it can rely on
 * `hasVerified()` already being true.
 *
 * Fires **once per intent**, not once per submission: `verify()`
 * short-circuits an already-verified intent to keep a double-click
 * idempotent, and that path dispatches nothing. A listener counting
 * successful step-ups therefore counts step-ups rather than clicks.
 *
 * `purpose` is the action the intent was raised for, or null for a
 * generic check. It is on the payload because "verified for
 * `billing.payout`" and "verified for anything" are materially different
 * facts to record.
 */
export class Verified extends MfaEvent {
  static override eventName = "mfa.Verified";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly intentId: string,
    public readonly purpose: string | null,
  ) {
    super(userId);
  }
}
