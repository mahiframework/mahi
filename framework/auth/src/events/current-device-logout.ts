import { UserAuthEvent } from "./auth-event.js";

/**
 * Every session for a user was destroyed, including the current one.
 *
 * Dispatched by `SessionGuard.logoutEverywhere()`. Its most important
 * caller is not a user action at all: `PasswordBroker.reset()` revokes
 * credentials on a successful reset, which is what makes account recovery
 * actually recover the account from whoever was already in it.
 *
 * So this event fires in two quite different situations, and
 * `reason` distinguishes them. An audit log that reports "signed out of
 * all devices" for a password reset is technically true and practically
 * misleading.
 *
 * Named after Laravel's `CurrentDeviceLogout`, which has the same
 * everything-including-me meaning.
 */
export class CurrentDeviceLogout extends UserAuthEvent {
  static override eventName = "auth.CurrentDeviceLogout";

  constructor(
    userId: string,
    public readonly reason: "requested" | "password_reset" = "requested",
    public readonly guard: string | null = null,
  ) {
    super(userId);
  }
}
