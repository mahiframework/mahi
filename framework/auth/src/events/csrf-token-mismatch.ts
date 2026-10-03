import { AuthEvent } from "./auth-event.js";

/**
 * A state-changing request was rejected for a bad or missing CSRF token.
 *
 * Dispatched by the `csrf()` middleware immediately before it throws its
 * 403.
 *
 * Worth observing because the base rate is informative: a trickle is
 * expired tabs and double-submits, while a burst against one route from
 * one origin is an attack in progress. Nothing else in the framework
 * reports it; without this event a CSRF rejection is indistinguishable
 * from any other 403 in an access log.
 *
 * `method` and `path` are carried because the request object is not: an
 * event holding a live `Request` invites a listener to read its body,
 * which may already be consumed, and makes the event unserializable for a
 * queued listener. Two strings answer the question listeners actually
 * ask.
 *
 * Note the dispatch is `await`ed before the throw, and a listener that
 * throws replaces the 403 with its own error. That is the documented
 * trade-off of in-band dispatch, and it matters more here than elsewhere
 * because the path is already an error path.
 */
export class CsrfTokenMismatch extends AuthEvent {
  static override eventName = "auth.CsrfTokenMismatch";

  constructor(
    public readonly method: string,
    public readonly path: string,
  ) {
    super();
  }
}
