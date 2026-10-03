import { MfaEvent } from "./mfa-event.js";

/**
 * A factor was enrolled but is NOT yet usable.
 *
 * Dispatched by `TotpDriver.enroll()`, which writes an unconfirmed row.
 * The user has been shown a secret and has not yet proved a code against
 * it, so `enrolled()` still reports false and `available()` still omits
 * the driver.
 *
 * It fires separately from `MethodConfirmed` because the two answer
 * different questions. This one says "someone started adding a factor",
 * which is the signal that matters if it was not the account owner. A
 * security log that only recorded confirmation would miss an abandoned
 * hostile enrollment entirely, and an unconfirmed row is exactly what an
 * attacker who got interrupted leaves behind.
 *
 * **The secret is deliberately absent.** It is the credential, and
 * `enroll()` returns it to its caller for display precisely once.
 */
export class MethodEnrolled extends MfaEvent {
  static override eventName = "mfa.MethodEnrolled";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly methodId: string,
    public readonly label: string | null,
  ) {
    super(userId);
  }
}
