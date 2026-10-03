import { UserAuthEvent } from "./auth-event.js";

/**
 * A request resolved to an authenticated user.
 *
 * Dispatched by `AuthManager.resolve()`, which the `authenticate()`
 * middleware calls, so this fires on EVERY authenticated request, not
 * once per login. It is the hook for "touch last_seen_at", per-user
 * request metrics, or enforcing a condition the guard itself cannot know
 * about.
 *
 * It does NOT fire when resolution yields no user: an anonymous request
 * is not an authentication event, and a listener wanting rejections
 * should watch `Failed` or the 401 the middleware raises.
 *
 * ## This is a hot path
 *
 * One dispatch per authenticated request, awaited in-band. A listener
 * here runs on every single API call, and a slow one is a latency
 * regression across the whole application. Anything doing I/O belongs on
 * `Login` (once per session) or behind a sampling check.
 *
 * `viaActingAs` is true when the user came from an `actingAs()` override
 * rather than a real credential check, which is how
 * `TestClient.actingAs()` authenticates. A listener writing an audit
 * trail should treat those rows differently, or skip them, since no
 * credential was presented.
 */
export class Authenticated extends UserAuthEvent {
  static override eventName = "auth.Authenticated";

  constructor(
    userId: string,
    public readonly user: unknown,
    public readonly guard: string,
    public readonly viaActingAs: boolean = false,
  ) {
    super(userId);
  }
}
