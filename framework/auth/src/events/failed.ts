import { AuthEvent } from "./auth-event.js";

/**
 * A credential check failed.
 *
 * Dispatched by `AuthManager.attempt()` alongside `Attempted`, so a
 * listener interested only in failures (the common case: alerting,
 * lockout, fail2ban-style blocking) registers once and gets exactly
 * those, rather than registering on `Attempted` and branching.
 *
 * Named `Failed` to match Laravel's `Illuminate\Auth\Events\Failed`.
 *
 * `credentials` has the secret stripped. `user` is always null here, for
 * the reason given on `Attempted`: `attempt()` cannot distinguish "no such
 * account" from "wrong password" and deliberately does not try.
 */
export class Failed extends AuthEvent {
  static override eventName = "auth.Failed";

  constructor(
    public readonly credentials: Record<string, string>,
    public readonly guard: string | null = null,
  ) {
    super();
  }
}
