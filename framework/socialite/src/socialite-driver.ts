import type { Request } from "@mahiframework/http";
import type { SocialiteToken, SocialiteUser } from "./socialite-user.js";

/**
 * Static metadata about a provider, for rendering a login page.
 *
 * On the class as well as the instance because the instance getters only
 * answer for a driver you can construct, and constructing one needs
 * credentials. An app listing "which providers could I offer?" has no
 * credentials for the ones it hasn't configured.
 */
export interface SocialiteDriverMeta {
  /** English label, e.g. `"GitHub"`. */
  readonly name: string;
  /** FQ URL to the provider's domain root, e.g. `"https://github.com"`. */
  readonly website: string;
}

/** A configured provider, for building a "sign in with…" list. */
export interface AvailableProvider extends SocialiteDriverMeta {
  /** The config name, which is what `Socialite.driver()` takes. */
  readonly driver: string;
}

/**
 * One OAuth provider.
 *
 * STATELESS BY CONTRACT, for the same reason `Guard` is: `Manager` caches
 * a resolved driver for the process lifetime, so one instance is shared
 * by every concurrent request. Nothing per-request may be stored on it.
 * Hence two rules that diverge from Laravel Socialite, where a provider
 * is constructed per request and holds the `Request`:
 *
 * 1. **The `Request` is an argument**, never a constructor dependency.
 * 2. **Every fluent method returns a copy.** Socialite's `scopes()` is
 *    `$this->scopes = x; return $this;`, which on a cached singleton
 *    means one handler calling `.scopes(["repo"])` silently widens the
 *    scopes of every subsequent login in the process — a
 *    privilege-escalation bug TypeScript cannot see. `PendingRequest` in
 *    `@mahiframework/http-client` is immutable for the same reason.
 *
 * Both `redirect()` and `user()` are async even for a driver with
 * nothing to await, so a provider that needs a round trip (OIDC
 * discovery) can be added later without a breaking change to the seam.
 */
export interface SocialiteDriver<TRaw = Record<string, unknown>> {
  /** English label, e.g. `"GitHub"`. */
  getName(): string;

  /** FQ URL to the provider's domain root, e.g. `"https://github.com"`. */
  getWebsite(): string;

  /**
   * The authorization URL to send the user to, having queued whatever
   * state the callback will need onto `request`.
   *
   * Returns a URL rather than a `RedirectResponse` so the app can render
   * an interstitial, return JSON to a SPA, or add headers. The one-line
   * form is `HttpResponse.redirect(await driver.redirect(request))`.
   */
  redirect(request: Request): Promise<string>;

  /** Verify the callback, exchange its code, and fetch the user. */
  user(request: Request): Promise<SocialiteUser<TRaw>>;

  /**
   * A user from a token already held — no callback, no state.
   *
   * The returned `token` carries only the token passed in: a provider's
   * user endpoint says nothing about refresh tokens or expiry.
   */
  userFromToken(token: string): Promise<SocialiteUser<TRaw>>;

  /** Exchange a refresh token for fresh credentials. */
  refreshToken(refreshToken: string): Promise<SocialiteToken>;

  /** Scopes this driver will request. */
  getScopes(): readonly string[];

  /** A copy with `scopes` merged into the existing set. */
  scopes(scopes: string | string[]): SocialiteDriver<TRaw>;

  /** A copy with `scopes` replacing the existing set. */
  setScopes(scopes: string | string[]): SocialiteDriver<TRaw>;

  /**
   * A copy with extra parameters on the authorization URL, e.g.
   * `{ prompt: "consent" }`. Replaces any previously set parameters.
   *
   * Unlike Socialite, these reach the authorization URL **only**. Its
   * `$parameters` is merged into the token request too, so a `with()`
   * meant for the consent screen is also POSTed to the token endpoint.
   * That is upstream behaviour and not defensible; nothing depends on it.
   */
  with(parameters: Record<string, string>): SocialiteDriver<TRaw>;

  /** A copy using `url` as the `redirect_uri`. */
  redirectUrl(url: string): SocialiteDriver<TRaw>;

  /**
   * A copy that issues no `state` and checks none on the way back.
   *
   * This removes the CSRF protection on the callback, and is only
   * appropriate where the round trip is not browser-mediated. Socialite
   * offers the same escape hatch for the same reason.
   */
  stateless(): SocialiteDriver<TRaw>;

  /** A copy that adds PKCE (S256) to the flow. */
  withPkce(): SocialiteDriver<TRaw>;
}
