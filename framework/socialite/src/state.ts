import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Signer } from "@mahiframework/encryption";
import type { CookieOptions, Request } from "@mahiframework/http";
import { InvalidStateError, type InvalidStateReason } from "./errors.js";

/**
 * What the redirect stashes for the callback to check.
 *
 * `provider` is carried so a callback can reject a cookie minted by a
 * different driver. Laravel Socialite writes flat `state` and
 * `code_verifier` session keys, so two concurrent flows in one browser
 * (a user who opens "sign in with GitHub" in two tabs, or starts GitHub
 * and then Google) overwrite each other and one of them fails. Scoping
 * the payload to its driver costs a string and closes that.
 */
export interface SocialiteState {
  provider: string;
  /** The `state` parameter, or null when the driver is stateless. */
  state: string | null;
  /** The PKCE code verifier, or null when PKCE is off. */
  verifier: string | null;
  /**
   * The OIDC `nonce`, or null for a plain OAuth 2.0 flow.
   *
   * Carried here rather than in a second cookie because it has exactly
   * the same lifetime and single-use requirement as the state. Laravel
   * Socialite's `AbstractProvider` has no nonce support at all, which is
   * why the OIDC packages built on it override `redirect()` wholesale.
   */
  nonce?: string | null;
}

/**
 * The cookie name for a driver's in-flight state.
 *
 * Per-driver rather than one shared cookie, so concurrent flows don't
 * clobber each other and so each clears independently.
 */
export function stateCookieName(provider: string): string {
  return `socialite_${provider}`;
}

/** A URL-safe random string, the house idiom for minting a credential. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * The PKCE `code_challenge` for a verifier: base64url of its SHA-256,
 * unpadded (RFC 7636 §4.2). `base64url` already omits the padding.
 */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Cookie attributes for the state cookie.
 *
 * `sameSite: "Lax"` is load-bearing and must not be tightened to
 * `"Strict"`. The provider returns the user by a cross-site top-level
 * GET, and `Strict` withholds the cookie on exactly that navigation, so
 * the callback would see no state and every login would fail with
 * `InvalidStateError`. `Lax` sends cookies on top-level navigations,
 * which is what an OAuth callback is.
 *
 * `maxAge` is short because this is a single round trip through the
 * provider, not a session: ten minutes is long enough to read a consent
 * screen and short enough that an abandoned flow leaves nothing behind.
 */
function cookieOptions(options: StateCookieOptions): CookieOptions {
  return {
    httpOnly: true,
    secure: options.secure ?? true,
    sameSite: "Lax",
    path: options.path ?? "/",
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };
}

export interface StateCookieOptions {
  secure?: boolean;
  path?: string;
  domain?: string;
  prefix?: "secure" | "host";
  /** Cookie lifetime in seconds. Defaults to 600 (ten minutes). */
  ttlSeconds?: number;
}

/**
 * Sign `state` into a cookie queued on `request`.
 *
 * Queued on the **request**, not set on a response, because the driver
 * does not own the response: the app's controller decides what to return
 * from `redirect()`. A queued cookie is written by the HTTP boundary onto
 * whatever that turns out to be, which is the same reason `SessionGuard`
 * and `csrf()` queue theirs.
 */
export function queueState(
  request: Request,
  signer: Signer,
  state: SocialiteState,
  options: StateCookieOptions = {},
): void {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");

  request.queueCookie(stateCookieName(state.provider), signer.sign(payload), {
    ...cookieOptions(options),
    maxAge: options.ttlSeconds ?? 600,
  });
}

/**
 * The outcome of reading the state cookie.
 *
 * A result rather than `SocialiteState | null`, so the four
 * `InvalidStateReason` values stay distinguishable. Collapsing
 * "signature failed" into the same null a stateless driver gets would
 * make `"unsigned"` unreachable, and that is the one reason worth
 * alerting on.
 */
export type PulledState =
  | { ok: true; state: SocialiteState }
  | { ok: false; reason: Extract<InvalidStateReason, "missing" | "unsigned"> };

/**
 * Read, verify and clear the state cookie for `provider`.
 *
 * Always queues the deletion, even when the cookie is missing or
 * unreadable: a cookie that failed to verify is one we will never accept,
 * so leaving it in the browser only guarantees the next attempt fails the
 * same way. Single-use by construction, which is what makes a replayed
 * callback fail.
 */
export function pullState(
  request: Request,
  signer: Signer,
  provider: string,
  options: StateCookieOptions = {},
): PulledState {
  const name = stateCookieName(provider);
  const raw = request.cookie(name, options.prefix);

  request.queueCookieForget(name, cookieOptions(options));

  if (raw === undefined || raw === "") {
    return { ok: false, reason: "missing" };
  }

  const payload = signer.verify(raw);

  if (payload === null) {
    return { ok: false, reason: "unsigned" };
  }

  const decoded = decodeState(payload);

  // A verified signature over a payload we cannot parse means this
  // server signed it, so the shape changed under a deploy rather than
  // an attacker editing it. Same remedy either way: don't trust it.
  if (decoded === null) {
    return { ok: false, reason: "unsigned" };
  }

  return { ok: true, state: decoded };
}

function decodeState(payload: string): SocialiteState | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.provider !== "string") {
    return null;
  }

  return {
    provider: candidate.provider,
    state: typeof candidate.state === "string" ? candidate.state : null,
    verifier: typeof candidate.verifier === "string" ? candidate.verifier : null,
    nonce: typeof candidate.nonce === "string" ? candidate.nonce : null,
  };
}

/**
 * Verify a pulled cookie against the `state` the provider sent back,
 * throwing `InvalidStateError` with the specific reason on any mismatch.
 *
 * The four failure modes are distinguished rather than collapsed into one
 * message, because they mean different things operationally: `"missing"`
 * is usually a user returning to a stale tab, while `"mismatch"` and
 * `"unsigned"` are worth alerting on. See `InvalidStateReason`.
 */
export function assertStateMatches(
  provider: string,
  pulled: PulledState,
  presented: string | undefined,
): SocialiteState {
  if (!pulled.ok) {
    throw new InvalidStateError(provider, pulled.reason);
  }

  const stashed = pulled.state;

  if (stashed.provider !== provider) {
    throw new InvalidStateError(provider, "wrong-provider");
  }

  if (stashed.state === null || presented === undefined || presented === "") {
    throw new InvalidStateError(provider, "mismatch");
  }

  if (!constantTimeEquals(stashed.state, presented)) {
    throw new InvalidStateError(provider, "mismatch");
  }

  return stashed;
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on mismatched lengths, so the length is
 * checked first — which does leak the length, and that is fine: the
 * state's length is fixed by how we mint it, not by a secret.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  return left.length === right.length && timingSafeEqual(left, right);
}

export type { InvalidStateReason };
