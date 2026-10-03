import { MfaEvent } from "./mfa-event.js";

/**
 * An intent reached `maxAttempts` and is now terminal.
 *
 * Dispatched by `MfaManager.verify()` alongside `VerificationFailed`, on
 * the one failure that crosses the threshold. Two events for one write is
 * deliberate: a listener alerting on lockouts registers here and gets
 * exactly those, instead of registering on every failure and comparing
 * counters it would have to learn the configured maximum to interpret.
 *
 * The lock is **per intent, not per user**, so this is not an account
 * lockout and must not be reported as one. The user starts a new intent
 * and tries again; the design is deliberate, because a per-user lock would
 * let an attacker lock a victim out of step-up entirely.
 */
export class IntentLocked extends MfaEvent {
  static override eventName = "mfa.IntentLocked";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly intentId: string,
    public readonly attempts: number,
  ) {
    super(userId);
  }
}
