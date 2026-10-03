import { UserAuthEvent } from "./auth-event.js";

/**
 * A personal access token was issued.
 *
 * Dispatched by `TokenGuard.createToken()`. This is the token guard's
 * equivalent of `Login`: it is the moment a long-lived credential comes
 * into existence, and for an API-only application it is the only
 * login-shaped event there is.
 *
 * `tokenId` is the public half of the token, safe to log and the value
 * `TokenRevoked` will later carry. **The plaintext token is deliberately
 * absent.** It is the credential itself; putting it on an event would
 * write it to any audit table, log line or queued payload a listener
 * touches, which is precisely the mistake
 * `@mahiframework/mail`'s prohibition on queueing credential-bearing
 * messages exists to prevent.
 *
 * `name` is the caller's label for the token ("login", "ci-deploy"),
 * useful for telling an interactive login apart from a machine
 * credential.
 */
export class TokenCreated extends UserAuthEvent {
  static override eventName = "auth.TokenCreated";

  constructor(
    userId: string,
    public readonly tokenId: string,
    public readonly name: string,
    public readonly guard: string | null = null,
  ) {
    super(userId);
  }
}
