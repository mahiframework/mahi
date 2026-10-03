import { randomUUID } from "node:crypto";
import type { CookieOptions, Request } from "@mahiframework/http";
import type { Signer } from "@mahiframework/encryption";
import type { StatefulGuard } from "../guard.js";
import type { UserProvider } from "../user-provider.js";
import type { SessionStore } from "../session/session-store.js";
import { currentAuthState } from "../auth-context.js";

export interface SessionGuardConfig {
  provider?: string;
  /** Which session store to use: `"database"` (default) or `"cache"`. */
  store?: string;
  /** Cookie name. Defaults to `"session"`. */
  cookie?: string;
  /** Sliding session lifetime in minutes. Defaults to 120. */
  lifetimeMinutes?: number;
  /**
   * Lifetime (minutes) for a "remember me" session. Defaults to ~400 days
   * (matching browsers' modern cap on cookie `Max-Age`, which is also
   * roughly Laravel's remember-me window). Only used when `login()` is
   * called with `{ remember: true }`.
   */
  rememberMinutes?: number;
  /**
   * `"lax"` is right for same-origin deployments. A cross-origin SPA
   * needs `"none"`, which browsers only honour alongside `secure: true`,
   * meaning cookie sessions do NOT work over plain HTTP across origins in
   * local development. That's a browser rule, not a framework
   * limitation; use the token guard for cross-origin clients.
   */
  sameSite?: "Strict" | "Lax" | "None";
  /** Send the cookie only over HTTPS. Should be true in production. */
  secure?: boolean;
  domain?: string;
  path?: string;
  /**
   * Cookie name prefix the browser itself enforces. `"host"` yields
   * `__Host-<cookie>`, which cannot be set or overwritten by a sibling
   * subdomain, the strongest available defense against session fixation
   * from a compromised `other.example.com`. It requires `secure: true`,
   * `path: "/"`, and no `domain`, so it is opt-in rather than the
   * default: those constraints break plain-HTTP local development.
   */
  prefix?: "secure" | "host";
  /**
   * The guard's own config name, recorded in the ambient auth scope by
   * `login()` so `Auth.currentGuard()` reports the guard that actually
   * logged the user in. Set by `AuthServiceProvider` when it resolves the
   * guard; defaults to `"session"`.
   */
  name?: string;
  /**
   * Re-send the cookie when a sliding session's expiry is renewed.
   * Defaults to `true`.
   *
   * Without this the server-side expiry slides forward on every request
   * but the browser still deletes its cookie `lifetimeMinutes` after
   * LOGIN, so an actively-used session dies mid-use, which is exactly
   * what sliding expiry exists to prevent. Set `false` for an absolute
   * session lifetime that no amount of activity extends.
   */
  slidingCookie?: boolean;
}

/**
 * Cookie-based sessions: the cookie carries a SIGNED session id and
 * nothing else; the session itself lives server-side in a `SessionStore`.
 *
 * Signing (via `Signer`, which already supports key rotation) means a
 * forged or edited cookie is rejected before it ever reaches the store,
 * so an attacker can't enumerate session ids by tampering. And because
 * only the id travels, deleting the stored row revokes the session
 * immediately, the property that rules out JWT for this framework.
 *
 * The injected `Signer` is narrowed to the `"session"` purpose in the
 * constructor, giving cookies their own derived key. A signature minted
 * by any other consumer of the root signer (signed URLs, say) therefore
 * won't verify as a session cookie, even if an attacker can influence
 * what that consumer signs.
 *
 * NOTE: cookie auth is what makes CSRF possible, since browsers attach
 * cookies automatically. Pair this guard with the `csrf()` middleware.
 * The token guard needs no such pairing, which is precisely because an
 * `Authorization` header is never sent automatically.
 *
 * COOKIES ARE QUEUED ON THE REQUEST (`request.queueCookie()`), not set
 * through Hono. Hono only merges its context-queued headers into a
 * response it built itself, and Mahi handlers return platform `Response`
 * objects, so a cookie set via `hono/cookie` here was silently dropped
 * and login never reached the browser at all. See `@mahiframework/http`'s
 * `cookies.ts`.
 */

/**
 * Thrown by `login()` when the given user id resolves to no user, a
 * deleted account, or an id the caller made up. Minting a session for a
 * nonexistent user would leave a live cookie whose every subsequent
 * request resolves to `null`, so this fails loudly instead.
 */
export class LoginUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`Cannot log in user "${userId}": no matching user was found by the user provider.`);
    this.name = "LoginUserNotFoundError";
  }
}

export class SessionGuard<TUser = unknown> implements StatefulGuard<TUser> {
  private readonly signer: Signer;

  constructor(
    private readonly users: UserProvider<TUser>,
    private readonly sessions: SessionStore,
    signer: Signer,
    private readonly config: SessionGuardConfig = {},
  ) {
    this.signer = signer.for("session");
  }

  private get cookieName(): string {
    return this.config.cookie ?? "session";
  }

  private get lifetimeMinutes(): number {
    return this.config.lifetimeMinutes ?? 120;
  }

  private get rememberMinutes(): number {
    return this.config.rememberMinutes ?? 400 * 24 * 60; // ~400 days
  }

  async user(request: Request): Promise<TUser | null> {
    const sessionId = this.readSessionId(request);

    if (sessionId === null) {
      return null;
    }

    const session = await this.sessions.read(sessionId);

    if (session === null) {
      return null;
    }

    // Sliding expiry: an active session keeps renewing, an abandoned one
    // lapses. Renew to the LATER of the normal sliding window and the
    // session's own current expiry, so a "remember me" session (whose
    // expiry is already far in the future) is never shrunk back to the
    // short lifetime, while an ordinary session still slides forward.
    const slid = this.expiresAt(this.lifetimeMinutes);
    const slidWins = new Date(session.expiresAt).getTime() <= new Date(slid).getTime();
    const renewed = slidWins ? slid : session.expiresAt;
    await this.sessions.touch(sessionId, renewed);

    // Re-issue the cookie alongside the renewal, or the browser would
    // still drop it `lifetimeMinutes` after LOGIN while the server
    // happily kept sliding the row forward, an active session that dies
    // mid-use, which is the opposite of what sliding expiry is for. Only
    // when the slide actually moved the expiry: a remembered session's
    // far-future cookie needs no refresh, and re-sending it on every
    // request would be pure header weight.
    if (slidWins && this.config.slidingCookie !== false) {
      this.writeCookie(request, sessionId, this.lifetimeMinutes);
    }

    return this.users.retrieveById(session.userId);
  }

  /**
   * Establish a session and set the cookie.
   *
   * ALWAYS mints a fresh session id, and destroys any pre-existing
   * session first. That is the defense against session fixation, an
   * attacker who plants a known session id in a victim's browser before
   * login must not still know it afterwards. It's the one session-
   * specific attack a naive implementation reliably gets wrong, so this
   * behaviour is covered by a dedicated test; don't "optimise" it into
   * reusing an existing id.
   *
   * REMEMBER ME (`{ remember: true }`) is deliberately NOT Laravel's
   * recaller-cookie mechanism. Laravel keeps a *second*, long-lived
   * credential (an `id|token|hmac` cookie + a `remember_token` column)
   * specifically to AVOID holding a session row alive for months. A
   * concern that doesn't apply here, because these sessions are already
   * fully server-side and revocable by deleting the row (the very
   * property that rules out a parallel, harder-to-revoke recaller
   * cookie). So "remember me" here simply means one long-lived session:
   * `expiresAt`/cookie `maxAge` use `rememberMinutes` instead of
   * `lifetimeMinutes`. One optional param, one branch, no separate
   * cookie, table, or password-HMAC binding.
   */
  async login(
    request: Request,
    userId: string,
    options: { remember?: boolean } = {},
  ): Promise<string> {
    const user = await this.users.retrieveById(userId);

    if (user === null) {
      throw new LoginUserNotFoundError(userId);
    }

    const existing = this.readSessionId(request);

    if (existing !== null) {
      await this.sessions.destroy(existing);
    }

    const minutes = options.remember === true ? this.rememberMinutes : this.lifetimeMinutes;

    const sessionId = randomUUID();
    await this.sessions.write(sessionId, userId, this.expiresAt(minutes));
    this.writeCookie(request, sessionId, minutes);

    // Publish into the ambient auth scope, so `Auth.user()` works for the
    // REST OF THIS REQUEST rather than only from the next one. Without
    // it, a login controller that logs in and then renders the user has
    // to re-fetch it, and `Auth.user()` throws `UnauthenticatedError` in
    // the handler that just authenticated someone.
    //
    // Best-effort: outside a request scope (a CLI command seeding a
    // session, a test) there is nothing to publish into, and that is not
    // an error, the session row and cookie are still written.
    const state = currentAuthState();

    if (state !== undefined) {
      state.user = user;
      state.guard = this.config.name ?? "session";
    }

    return sessionId;
  }

  /** Destroy the current session and clear the cookie. */
  async logout(request: Request): Promise<void> {
    const sessionId = this.readSessionId(request);

    if (sessionId !== null) {
      await this.sessions.destroy(sessionId);
    }

    // `path`/`domain`/`prefix` must match what `writeCookie()` wrote, or
    // the browser treats this as a different cookie and leaves the
    // original in place, a logout that visibly succeeds and doesn't.
    request.queueCookieForget(this.cookieName, this.cookieOptions());

    // Clear the ambient scope too: code running later in this same
    // request must not still see the user it just logged out.
    const state = currentAuthState();

    if (state !== undefined) {
      state.user = null;
      state.guard = null;
    }
  }

  /** Invalidate every session for a user. Requires the database store. */
  async logoutEverywhere(userId: string): Promise<void> {
    await this.sessions.destroyForUser(userId);
  }

  /**
   * "Sign out everywhere else", revoke every OTHER session for the
   * current user while keeping this one alive. Distinct from
   * `logoutEverywhere()`, which also kills the current session.
   *
   * Re-validates `password` first (the standard guard on a security-
   * settings page: confirm it's really the account owner before mass-
   * revoking), returning `false` without touching anything if it doesn't
   * check out, or if there's no current session. Requires the database
   * store (a cache can't be queried by user).
   */
  async logoutOtherDevices(request: Request, password: string): Promise<boolean> {
    const sessionId = this.readSessionId(request);

    if (sessionId === null) {
      return false;
    }

    const session = await this.sessions.read(sessionId);

    if (session === null) {
      return false;
    }

    const user = await this.users.retrieveById(session.userId);

    if (user === null) {
      return false;
    }

    const valid = await this.users.validateCredentials(user, { password });

    if (!valid) {
      return false;
    }

    await this.sessions.destroyForUserExcept(session.userId, sessionId);

    return true;
  }

  /** Delete expired sessions, driven by the `auth:gc` command. */
  async gc(): Promise<number> {
    return this.sessions.gc();
  }

  /**
   * The current request's session id, or null when there is no valid
   * session cookie.
   *
   * The public counterpart to `TokenGuard.currentTokenId()`, and it
   * exists for the same reason: something outside the guard needs a
   * stable per-request identifier for "this client", not just "this
   * user". Binding a step-up verification to one session needs exactly
   * that, so a second concurrent session for the same user cannot
   * consume a verification it never performed.
   *
   * Deliberately NOT the session's contents. A `SessionRecord` holds
   * `{ id, userId, expiresAt }` and nothing else, and `user()` is
   * already the way to read the identity; handing out the record here
   * would invite callers to re-implement it. This returns the id only,
   * and makes no promise that the session still exists server-side,
   * since the cookie's signature verifying does not mean the row does.
   * A caller that needs liveness should go through `user()`.
   *
   * No sliding renewal, no cookie re-issue: reading an identifier is not
   * activity on the session, and renewing here would let an unrelated
   * capability check extend a session's life.
   */
  sessionId(request: Request): string | null {
    return this.readSessionId(request);
  }

  private readSessionId(request: Request): string | null {
    const raw = request.cookie(this.cookieName, this.config.prefix);

    if (!raw) {
      return null;
    }

    // null when the signature doesn't verify, tampered or signed with a
    // key no longer trusted.
    return this.signer.verify(raw);
  }

  private writeCookie(request: Request, sessionId: string, minutes: number): void {
    request.queueCookie(this.cookieName, this.signer.sign(sessionId), {
      ...this.cookieOptions(),
      maxAge: minutes * 60,
    });
  }

  /**
   * The cookie's identity + security attributes, shared by every write so
   * a re-issue, a deletion, and the original all describe the same
   * cookie. Only `Max-Age` varies.
   */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true, // not readable from JS: limits XSS session theft
      secure: this.config.secure ?? true,
      sameSite: this.config.sameSite ?? "Lax",
      path: this.config.path ?? "/",
      ...(this.config.domain === undefined ? {} : { domain: this.config.domain }),
      ...(this.config.prefix === undefined ? {} : { prefix: this.config.prefix }),
    };
  }

  private expiresAt(minutes: number): string {
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }
}
