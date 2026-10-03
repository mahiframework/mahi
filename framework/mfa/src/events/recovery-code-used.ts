import { MfaEvent } from "./mfa-event.js";

/**
 * A recovery code was consumed, and cannot be used again.
 *
 * Dispatched by `RecoveryDriver.verify()` on success. `remaining` is the
 * count **after** consuming, because the actionable thing for a listener
 * is "warn them to regenerate", and that needs the number left rather
 * than the number used.
 *
 * Reaching for a recovery code is itself a signal: it usually means the
 * user has lost their authenticator, so this is the event behind "we
 * noticed you used a recovery code" mail. `remaining === 0` is the urgent
 * case, since the user now has no recovery path at all.
 */
export class RecoveryCodeUsed extends MfaEvent {
  static override eventName = "mfa.RecoveryCodeUsed";

  constructor(
    userId: string,
    public readonly intentId: string,
    public readonly remaining: number,
  ) {
    super(userId);
  }
}
