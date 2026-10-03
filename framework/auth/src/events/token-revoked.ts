import { AuthEvent } from "./auth-event.js";

/**
 * One or all of a user's personal access tokens were revoked.
 *
 * Dispatched by `TokenGuard.revokeToken()` (one token) and
 * `revokeAllTokens()` (every token for a user). One class with an `all`
 * flag rather than two classes: a listener auditing credential
 * destruction wants both, and the pair is the same act at two
 * granularities.
 *
 * `userId` is null for a single-token revocation, because
 * `revokeToken(id)` takes only the token id and does not read the row it
 * is deleting. Adding a lookup so the event could carry the owner would
 * put a query in a revocation path for the benefit of a listener that may
 * not exist; a listener that needs the owner can resolve `tokenId`
 * itself, and a listener auditing bulk revocation gets `userId` from the
 * `all` form where it is already known.
 *
 * `tokenId` is correspondingly null for the `all` form.
 */
export class TokenRevoked extends AuthEvent {
  static override eventName = "auth.TokenRevoked";

  constructor(
    public readonly tokenId: string | null,
    public readonly userId: string | null,
    public readonly all: boolean,
    public readonly reason: "requested" | "password_reset" = "requested",
  ) {
    super();
  }
}
