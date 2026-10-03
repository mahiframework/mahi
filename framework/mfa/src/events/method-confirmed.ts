import { MfaEvent } from "./mfa-event.js";

/**
 * A factor was proved and is now usable.
 *
 * Dispatched by `TotpDriver.confirm()` on success only. This is the
 * transition that makes `enrolled()` true, so it is the one an app should
 * treat as "MFA is now on for this account" — and the one worth notifying
 * the user about, since a second factor appearing on an account they did
 * not add it to is an account takeover in progress.
 *
 * A failed confirmation dispatches nothing: a mistyped code during setup
 * is a typo, not an event, and `confirm()` returns `false` for a wrong
 * code, a stale row and an already-confirmed one alike without
 * distinguishing them.
 */
export class MethodConfirmed extends MfaEvent {
  static override eventName = "mfa.MethodConfirmed";

  constructor(
    userId: string,
    public readonly driver: string,
    public readonly methodId: string,
  ) {
    super(userId);
  }
}
