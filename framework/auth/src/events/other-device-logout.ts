import { UserAuthEvent } from "./auth-event.js";

/**
 * Every session for a user was destroyed EXCEPT the one that asked.
 *
 * Dispatched by `SessionGuard.logoutOtherDevices()`, the "sign out
 * everywhere else" action, which re-validates the password before
 * acting. Named after Laravel's `OtherDeviceLogout`.
 *
 * Fires only on success. A call that fails its password check is a failed
 * credential verification, not a logout, and reporting it as one would
 * put a "you were signed out" row in an audit log for an action that
 * destroyed nothing.
 *
 * `keptSessionId` is the session that survived, which is what makes this
 * distinguishable from `CurrentDeviceLogout` in a log.
 */
export class OtherDeviceLogout extends UserAuthEvent {
  static override eventName = "auth.OtherDeviceLogout";

  constructor(
    userId: string,
    public readonly keptSessionId: string,
    public readonly guard: string,
  ) {
    super(userId);
  }
}
