import { AuthEvent } from "./auth-event.js";

/**
 * A user logged out, destroying their session.
 *
 * Dispatched by `SessionGuard.logout()` after the session row is
 * destroyed and the cookie cleared.
 *
 * `userId` and `user` are BOTH nullable, and that is not laziness.
 * `logout()` reads the signed session id and destroys it without ever
 * loading the user, because it does not need one. Loading a user purely
 * so an event could carry it would add a query to every logout for the
 * benefit of listeners that may not exist.
 *
 * The values are populated when they are already known: the ambient auth
 * scope holds the user if `authenticate()` ran earlier in the request,
 * which is the normal shape of a logout route. A logout on a route
 * without `authenticate()` yields nulls, and a listener must handle that
 * rather than assuming.
 *
 * `sessionId` is null when there was no session to destroy, i.e. a logout
 * called by someone who was not logged in. The event still fires: "a
 * logout was attempted against no session" is information, and
 * suppressing it would make the event stream disagree with the request
 * log.
 */
export class Logout extends AuthEvent {
  static override eventName = "auth.Logout";

  constructor(
    public readonly userId: string | null,
    public readonly user: unknown | null,
    public readonly sessionId: string | null,
    public readonly guard: string,
  ) {
    super();
  }
}
