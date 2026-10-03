import { UserAuthEvent } from "./auth-event.js";

/**
 * A user was logged in through a stateful guard, and a session now
 * exists.
 *
 * Dispatched by `SessionGuard.login()` AFTER the session row and cookie
 * are written, so a listener observing it can rely on the session being
 * live. It fires once per session established, including on a
 * `remember: true` login.
 *
 * This is distinct from `Authenticated`, which fires on every subsequent
 * request that resolves the same session. Conflating them is the usual
 * mistake: "notify on new login" wants this one, and would otherwise send
 * a notification on every page load.
 *
 * `user` is the full user object (the guard has it in hand to validate
 * the id), so a listener needs no second lookup to read an email or a
 * name.
 */
export class Login extends UserAuthEvent {
  static override eventName = "auth.Login";

  constructor(
    userId: string,
    public readonly user: unknown,
    public readonly sessionId: string,
    public readonly remember: boolean,
    public readonly guard: string,
  ) {
    super(userId);
  }
}
