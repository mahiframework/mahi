import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { Http } from "@mahiframework/http-client";
import {
  Oauth2SocialiteDriver,
  type MappedSocialiteUser,
  type Oauth2DriverContext,
  type Oauth2DriverOptions,
  type SocialiteDriver,
  type SocialiteDriverMeta,
  type SocialiteState,
  type SocialiteToken,
  type TokenResponse,
} from "@mahiframework/socialite";
import { DiscoveryCache, issuerMatches, type OidcDiscoveryDocument } from "./discovery.js";
import { EndpointUnsupportedError, IdTokenInvalidError, SubjectMismatchError } from "./errors.js";

/** Standard OIDC claims this driver maps. OIDC Core §5.1. */
export interface OidcRawUser extends JWTPayload {
  sub: string;
  name?: string | null;
  preferred_username?: string | null;
  nickname?: string | null;
  email?: string | null;
  email_verified?: boolean | null;
  picture?: string | null;
  [claim: string]: unknown;
}

/** Settings an `oidc` provider config carries beyond the shared keys. */
export interface OidcProviderConfig {
  /** The issuer identifier, e.g. `https://keycloak.test/realms/main`. */
  issuer?: string;
  /**
   * Signing algorithms to accept. Defaults to `["RS256"]`.
   *
   * An **allow-list**, never read from the token. This is the defence
   * against algorithm confusion: an attacker who can set `alg` picks
   * `none`, or picks `HS256` and signs with the issuer's public key as
   * the HMAC secret.
   */
  algorithms?: string[];
  /** Clock skew tolerance in seconds. Defaults to 60. */
  clockToleranceSeconds?: number;
  /** How long to cache the discovery document. Defaults to 3600. */
  discoveryTtlSeconds?: number;
  /**
   * How long to wait between JWKS refetches, in seconds. Defaults to 30.
   *
   * The rate limit on rotation recovery: an unknown `kid` triggers a
   * refetch, but no more often than this, so an attacker cannot turn
   * bogus `kid`s into amplification against the IdP. Lower it only if an
   * issuer rotates keys unusually aggressively.
   */
  jwksCooldownSeconds?: number;
  /** Skip the userinfo call and take identity from the `id_token` alone. */
  idTokenOnly?: boolean;
  /** Human label for a login page. Defaults to the issuer's host. */
  label?: string;

  /**
   * Hosts, besides the issuer's own, whose endpoints are acceptable.
   * Defaults to none.
   *
   * The discovery document supplies four URLs this server afterwards
   * fetches, and they are pinned to the issuer's origin precisely
   * because the issuer is admin-entered configuration and the document
   * is not. Some IdPs genuinely split endpoints across names — Entra
   * ID's `jwks_uri` is on `login.microsoftonline.com` while the issuer
   * is `sts.windows.net` — and those hosts go here.
   *
   * A host named here is trusted as the issuer is, internal addresses
   * included: an admin writing `keys.idp.internal` into config has said
   * what they meant. There is no separate private-address flag, because
   * a self-hosted IdP's endpoints are reachable already — its issuer is
   * the internal URL too.
   */
  allowEndpointHosts?: string[];
}

const DEFAULT_ALGORITHMS = ["RS256"];

/**
 * Generic OpenID Connect.
 *
 * The difference between this and a hardcoded provider like Google or
 * Slack is one sentence: **here the issuer is configuration, not a
 * constant.** Everything below follows from that.
 *
 * Against a hardcoded issuer, "exchange the code over TLS, then call
 * userinfo with the resulting bearer token" is sound — there is no
 * issuer-substitution surface for `id_token` validation to defend
 * against, which is why `GoogleSocialiteDriver` and Socialite's own
 * `*OpenIdProvider` classes ignore the `id_token` entirely. The moment
 * the issuer comes from `.env`, that reasoning collapses, and the full
 * OIDC Core §3.1.3.7 validation becomes mandatory:
 *
 * - **Discovery**, with the document's own `issuer` checked against the
 *   configured one (see `fetchDiscovery`).
 * - **Signature** against the JWKS key named by the token's `kid`.
 * - **An `alg` allow-list**, so `none` and RS256→HS256 confusion fail.
 * - **`iss`** exactly the configured issuer.
 * - **`aud`** containing the client id, and `azp` when `aud` is
 *   multi-valued.
 * - **`exp`/`nbf`/`iat`** within a small clock tolerance.
 * - **`nonce`** equal to the one minted on the redirect, single-use.
 * - **`userinfo.sub === id_token.sub`** (§5.3.2).
 *
 * PKCE is on by default. It is mandatory in OAuth 2.1 and the FAPI
 * profiles, every current IdP supports it, and the threat it closes —
 * code interception — is real for a flow whose endpoints are not known
 * ahead of time.
 */
export class OidcSocialiteDriver extends Oauth2SocialiteDriver<OidcRawUser> {
  protected override readonly scopeSeparator = " ";
  protected override readonly defaultScopes: readonly string[] = ["openid", "profile", "email"];
  protected override readonly requiresPkce = true;

  constructor(
    context: Oauth2DriverContext,
    options: Oauth2DriverOptions,
    private readonly oidc: ResolvedOidcConfig,
    /**
     * Shared across every fluent copy, deliberately: a copy minted by
     * `.scopes()` must not start a cold discovery cache or a cold JWKS
     * cache, or a chained call would refetch both. Hence a mutable
     * holder rather than a field on the driver.
     */
    private readonly caches: OidcCaches,
  ) {
    super(context, options);
  }

  protected meta(): SocialiteDriverMeta {
    return { name: this.oidc.label, website: this.oidc.issuer };
  }

  protected withOptions(options: Oauth2DriverOptions): SocialiteDriver<OidcRawUser> {
    return new OidcSocialiteDriver(this.context, options, this.oidc, this.caches);
  }

  /** OIDC's replay defence. `state` is CSRF; they are not interchangeable. */
  protected override usesNonce(): boolean {
    return true;
  }

  /**
   * Both endpoints come from the discovery document rather than being
   * hardcoded, which is why the base declares them as possibly async.
   */
  protected override async authUrl(): Promise<string> {
    return (await this.discovery().get()).authorization_endpoint;
  }

  protected override async tokenUrl(): Promise<string> {
    return (await this.discovery().get()).token_endpoint;
  }

  private discovery(): DiscoveryCache {
    this.caches.discovery ??= new DiscoveryCache(this.oidc.issuer, this.oidc.discoveryTtlMs, {
      allowHosts: this.oidc.allowEndpointHosts,
    });

    return this.caches.discovery;
  }

  protected mapUser(raw: OidcRawUser): MappedSocialiteUser {
    return {
      // `sub` scoped by issuer is the identity. `email` and
      // `preferred_username` are mutable and reassignable, and keying an
      // account on either is a known takeover vector.
      id: raw.sub,
      // `preferred_username` first: it is the canonical username in
      // Keycloak, Authentik and Entra ID, all of which rarely send
      // `nickname`. `Kovah`'s package maps only `nickname` and so
      // reports null for most real deployments.
      nickname: raw.preferred_username ?? raw.nickname ?? null,
      name: raw.name ?? null,
      email: raw.email ?? null,
      // `Kovah`'s package maps no avatar at all, so `getAvatar()` is
      // always null there.
      avatar: raw.picture ?? null,
    };
  }

  /**
   * The JWKS resolver, built once and shared.
   *
   * The cache lives on the resolver object, so building one per call
   * would defeat it and hammer the IdP. `cooldownDuration` is what makes
   * key rotation self-healing: an unknown `kid` triggers a refetch,
   * rate-limited so an attacker cannot turn bogus `kid`s into
   * amplification. A flat TTL alone — `Kovah`'s one-hour
   * `Cache::remember` — makes rotation an outage for that hour.
   */
  private jwks(document: OidcDiscoveryDocument): ReturnType<typeof createRemoteJWKSet> {
    this.caches.jwks ??= createRemoteJWKSet(new URL(document.jwks_uri), {
      cacheMaxAge: this.oidc.discoveryTtlMs,
      cooldownDuration: this.oidc.jwksCooldownMs,
      timeoutDuration: 10_000,
      // Routed through `@mahiframework/http-client` rather than left on
      // the global `fetch`, so JWKS traffic honours the same timeouts
      // and is interceptable by `Http.fake()` — which is what lets a
      // test exercise key rotation without a network.
      [customFetch]: async (url, init) => {
        const response = await Http.withHeaders(headersFrom(init.headers))
          .withUserAgent("Mahi Socialite")
          .timeout(10_000)
          .get(url);

        // A fresh `Response` over the buffered body, not
        // `toWebResponse()`: that returns the original, whose body this
        // client has already consumed, so `jose` would read nothing.
        return new Response(response.body(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      },
    });

    return this.caches.jwks;
  }

  /** The issuer's metadata, cached. */
  async metadata(): Promise<OidcDiscoveryDocument> {
    return this.discovery().get();
  }

  /**
   * Validate the `id_token` before the user is fetched.
   *
   * Runs as part of `user()`, so an app gets this for free and cannot
   * forget it.
   */
  protected override async verify(
    _token: SocialiteToken,
    stashed: SocialiteState | null,
    response: TokenResponse,
  ): Promise<void> {
    const idToken = response.id_token;

    if (typeof idToken !== "string" || idToken === "") {
      throw new IdTokenInvalidError(this.context.name, "missing");
    }

    const document = await this.discovery().get();

    // Checked before verification, and against our own allow-list rather
    // than the token's claim about itself.
    let header;

    try {
      header = decodeProtectedHeader(idToken);
    } catch {
      throw new IdTokenInvalidError(this.context.name, "malformed");
    }

    if (header.alg === undefined || !this.oidc.algorithms.includes(header.alg)) {
      throw new IdTokenInvalidError(
        this.context.name,
        "algorithm",
        `got "${header.alg ?? "none"}", expected one of ${this.oidc.algorithms.join(", ")}`,
      );
    }

    let payload: JWTPayload;

    try {
      ({ payload } = await jwtVerify(idToken, this.jwks(document), {
        issuer: document.issuer,
        audience: this.context.clientId,
        algorithms: this.oidc.algorithms,
        clockTolerance: this.oidc.clockToleranceSeconds,
        requiredClaims: ["sub", "iat"],
      }));
    } catch (error) {
      throw this.classify(error);
    }

    this.assertIssuer(payload);
    this.assertAudience(payload);
    this.assertNonce(payload, stashed);

    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new IdTokenInvalidError(this.context.name, "claims", "sub");
    }

    this.verifiedSubject = payload.sub;
    this.verifiedClaims = payload as OidcRawUser;
  }

  /**
   * The `sub` from the just-verified `id_token`.
   *
   * Per-call rather than per-instance state would be better, but
   * `fetchUser()` takes only a token — so this is written by `verify()`
   * and read by `fetchUser()` within one awaited call, and is cleared
   * immediately. Not a cross-request memo: `verify()` always overwrites
   * it before `fetchUser()` runs.
   */
  private verifiedSubject: string | undefined;
  private verifiedClaims: OidcRawUser | undefined;

  private assertIssuer(payload: JWTPayload): void {
    if (typeof payload.iss !== "string" || !issuerMatches(payload.iss, this.oidc.issuer)) {
      throw new IdTokenInvalidError(
        this.context.name,
        "issuer",
        `got "${String(payload.iss)}", expected "${this.oidc.issuer}"`,
      );
    }
  }

  /**
   * `aud` must contain the client id; a multi-valued `aud` additionally
   * requires `azp` to be the client id (OIDC Core §3.1.3.7 steps 3-4).
   *
   * `jose` checks membership, but not the `azp` rule — without it, a
   * token minted for several clients is accepted by all of them.
   */
  private assertAudience(payload: JWTPayload): void {
    const audience = payload.aud;

    if (Array.isArray(audience) && audience.length > 1 && payload.azp !== this.context.clientId) {
      throw new IdTokenInvalidError(
        this.context.name,
        "audience",
        "aud has multiple values and azp is not this client",
      );
    }
  }

  private assertNonce(payload: JWTPayload, stashed: SocialiteState | null): void {
    const expected = stashed?.nonce ?? null;

    if (expected === null) {
      throw new IdTokenInvalidError(
        this.context.name,
        "nonce",
        "no nonce was issued for this flow",
      );
    }

    if (typeof payload.nonce !== "string" || payload.nonce !== expected) {
      throw new IdTokenInvalidError(this.context.name, "nonce");
    }
  }

  /** Map a `jose` failure onto a reason. */
  private classify(error: unknown): IdTokenInvalidError {
    const code = (error as { code?: unknown }).code;
    const name = this.context.name;

    switch (code) {
      case "ERR_JWT_EXPIRED":
      case "ERR_JWT_CLAIM_VALIDATION_FAILED":
        return this.classifyClaim(error, name);
      case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      case "ERR_JWKS_NO_MATCHING_KEY":
      case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
        return new IdTokenInvalidError(name, "signature", String(code));
      case "ERR_JWS_INVALID":
      case "ERR_JWT_INVALID":
        return new IdTokenInvalidError(name, "malformed");
      default:
        return new IdTokenInvalidError(name, "signature", String(code ?? error));
    }
  }

  private classifyClaim(error: unknown, name: string): IdTokenInvalidError {
    const claim = (error as { claim?: unknown }).claim;

    if (claim === "iss") {
      return new IdTokenInvalidError(name, "issuer");
    }

    if (claim === "aud" || claim === "azp") {
      return new IdTokenInvalidError(name, "audience");
    }

    if (claim === "nonce") {
      return new IdTokenInvalidError(name, "nonce");
    }

    if (claim === "exp" || claim === "nbf" || claim === "iat") {
      return new IdTokenInvalidError(name, "expired", String(claim));
    }

    return new IdTokenInvalidError(name, "expired", String(claim ?? ""));
  }

  protected async fetchUser(token: string): Promise<OidcRawUser> {
    const subject = this.verifiedSubject;
    const claims = this.verifiedClaims;

    this.verifiedSubject = undefined;
    this.verifiedClaims = undefined;

    // `userFromToken()` skips `verify()`, so there is no verified
    // subject and userinfo is the only identity available. Nothing to
    // cross-check it against, which is the documented cost of that
    // method — see `SocialiteDriver.userFromToken`.
    if (subject === undefined || claims === undefined) {
      return this.fetchUserinfo(token, null);
    }

    if (this.oidc.idTokenOnly) {
      return claims;
    }

    const userinfo = await this.fetchUserinfo(token, subject);

    // Claims from both, with userinfo winning: it is the fresher source,
    // and the `sub` match above has already established they describe
    // the same person.
    return { ...claims, ...userinfo, sub: subject };
  }

  private async fetchUserinfo(token: string, subject: string | null): Promise<OidcRawUser> {
    const document = await this.discovery().get();
    const endpoint = document.userinfo_endpoint;

    if (endpoint === undefined) {
      throw new EndpointUnsupportedError(this.context.name, "userinfo_endpoint");
    }

    // A Bearer header, never `?access_token=`. RFC 6750 §2.3 discourages
    // the query form (tokens leak into logs and Referer headers) and
    // Okta and Entra ID reject it outright — `Kovah`'s package uses it.
    const response = await this.authenticated(token).get(endpoint);

    this.assertUserFetched(response);

    const claims = response.json<OidcRawUser>();

    if (typeof claims.sub !== "string" || claims.sub === "") {
      throw new IdTokenInvalidError(this.context.name, "claims", "userinfo carried no sub");
    }

    // OIDC Core §5.3.2. Without it, one user's token pairs with
    // another's profile — and the profile is what the app keys on.
    if (subject !== null && claims.sub !== subject) {
      throw new SubjectMismatchError(this.context.name, subject, claims.sub);
    }

    return claims;
  }

  /**
   * The issuer's RP-initiated logout URL, or null when it advertises
   * none.
   *
   * Without this, "log out" clears the local session while the IdP's SSO
   * session persists, so the next login silently re-authenticates and
   * users reasonably read that as a bug.
   */
  async logoutUrl(options: { idToken?: string; redirectTo?: string } = {}): Promise<string | null> {
    const document = await this.discovery().get();

    if (document.end_session_endpoint === undefined) {
      return null;
    }

    const url = new URL(document.end_session_endpoint);

    url.searchParams.set("client_id", this.context.clientId);

    if (options.idToken !== undefined) {
      url.searchParams.set("id_token_hint", options.idToken);
    }

    if (options.redirectTo !== undefined) {
      url.searchParams.set("post_logout_redirect_uri", options.redirectTo);
    }

    return url.toString();
  }
}

/** `Headers` as a plain record, for the HTTP client. */
function headersFrom(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};

  headers.forEach((value, key) => {
    record[key] = value;
  });

  return record;
}

/**
 * Per-issuer caches, shared by every fluent copy of a driver.
 *
 * A mutable holder rather than fields on the driver, because a copy
 * minted by `.scopes()` must inherit the warm caches — otherwise a
 * chained call refetches discovery and the JWKS.
 */
export interface OidcCaches {
  discovery?: DiscoveryCache;
  jwks?: ReturnType<typeof createRemoteJWKSet>;
}

/** `OidcProviderConfig` with every default applied. */
export interface ResolvedOidcConfig {
  issuer: string;
  label: string;
  algorithms: string[];
  clockToleranceSeconds: number;
  discoveryTtlMs: number;
  jwksCooldownMs: number;
  idTokenOnly: boolean;
  allowEndpointHosts: readonly string[];
}

/** Apply defaults to an `oidc` provider config. */
export function resolveOidcConfig(issuer: string, config: OidcProviderConfig): ResolvedOidcConfig {
  return {
    issuer,
    label: config.label ?? new URL(issuer).host,
    algorithms: config.algorithms ?? DEFAULT_ALGORITHMS,
    clockToleranceSeconds: config.clockToleranceSeconds ?? 60,
    discoveryTtlMs: (config.discoveryTtlSeconds ?? 3600) * 1000,
    jwksCooldownMs: (config.jwksCooldownSeconds ?? 30) * 1000,
    idTokenOnly: config.idTokenOnly ?? false,
    // Empty by default: pinning the endpoints to the issuer's origin is
    // what makes a hostile discovery document harmless, and an app that
    // needs to widen it should have to say so.
    allowEndpointHosts: config.allowEndpointHosts ?? [],
  };
}
