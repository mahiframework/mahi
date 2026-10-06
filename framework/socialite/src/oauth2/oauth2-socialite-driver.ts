import type { Signer } from "@mahiframework/encryption";
import type { Request } from "@mahiframework/http";
import { Http, type ClientResponse } from "@mahiframework/http-client";
import {
  MissingAuthorizationCodeError,
  TokenExchangeFailedError,
  UserFetchFailedError,
} from "../errors.js";
import { buildQuery, type QueryEncoding } from "../query.js";
import type { SocialiteCookieConfig } from "../socialite-config.js";
import type { SocialiteDriver, SocialiteDriverMeta } from "../socialite-driver.js";
import type { MappedSocialiteUser, SocialiteToken, SocialiteUser } from "../socialite-user.js";
import {
  assertStateMatches,
  codeChallenge,
  pullState,
  queueState,
  randomToken,
  type SocialiteState,
} from "../state.js";

/** Everything a driver needs that comes from config rather than a caller. */
export interface Oauth2DriverContext {
  /** The provider's config name, which is also the state cookie's scope. */
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Resolved lazily, so a root-relative config value can use the URL generator. */
  readonly resolveRedirectUrl: () => string;
  readonly signer: Signer;
  readonly cookie: SocialiteCookieConfig;
}

/** Per-call options a fluent method may override. Immutable. */
export interface Oauth2DriverOptions {
  readonly scopes: readonly string[];
  readonly parameters: Readonly<Record<string, string>>;
  readonly redirectUrl: string | undefined;
  readonly stateless: boolean;
  readonly pkce: boolean;
}

/** The decoded token-endpoint response. */
export interface TokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * How long to wait on any single call to a provider.
 *
 * Socialite sets no timeout at all, which means a provider hanging hangs
 * a request handler indefinitely.
 */
const TIMEOUT_MS = 10_000;

/**
 * A User-Agent, because GitHub rejects requests without one.
 *
 * Guzzle sends one by default so Socialite never had to think about it;
 * `undici` sends `undici`, which GitHub tolerates but which is not
 * something to depend on.
 */
const USER_AGENT = "Mahi Socialite";

/**
 * The generic OAuth 2.0 authorization-code flow.
 *
 * A port of Laravel Socialite's `Two\AbstractProvider`, with the
 * divergences the `SocialiteDriver` contract requires: no `Request` held
 * on the instance, no memoised user, and copy-on-write fluent methods.
 *
 * A concrete driver supplies four things — `authUrl()`, `tokenUrl()`,
 * `fetchUser()` and `mapUser()` — and may override `scopeSeparator`,
 * `defaultScopes`, `encoding`, `requestOptions()` or `refreshToken()`.
 */
export abstract class Oauth2SocialiteDriver<
  TRaw = Record<string, unknown>,
> implements SocialiteDriver<TRaw> {
  /**
   * How scopes are joined in the authorization URL, and split in a
   * token response.
   *
   * `","` matches Socialite's default. Most OAuth 2.0 providers and
   * every OIDC one want `" "`, so most subclasses override this; GitHub
   * genuinely accepts commas, so it does not.
   */
  protected readonly scopeSeparator: string = ",";

  /** Scopes requested when neither config nor a caller names any. */
  protected readonly defaultScopes: readonly string[] = [];

  /** Query encoding for the authorization URL. See `buildQuery`. */
  protected readonly encoding: QueryEncoding = "rfc1738";

  /**
   * Whether this provider requires PKCE regardless of config.
   *
   * X/Twitter rejects an authorization request without a
   * `code_challenge`, so for those drivers PKCE is not an opt-in the app
   * may forget — it is part of the protocol. Everywhere else it stays
   * off unless asked for.
   */
  protected readonly requiresPkce: boolean = false;

  /**
   * Send the client credentials as HTTP Basic on the token request
   * instead of as form fields.
   *
   * X/Twitter requires `Authorization: Basic base64(id:secret)` here.
   * Socialite passes Guzzle's `RequestOptions::AUTH` and *also* leaves
   * `client_secret` in the form body; this sends one or the other,
   * because sending a secret twice is not better than sending it once.
   */
  protected readonly tokenAuth: "body" | "basic" = "body";

  constructor(
    protected readonly context: Oauth2DriverContext,
    protected readonly options: Oauth2DriverOptions,
  ) {}

  // ------------------------------------------------------------ the subclass

  /**
   * The provider's authorization endpoint.
   *
   * May return a promise: an OIDC driver resolves its endpoints from the
   * issuer's discovery document rather than hardcoding them.
   */
  protected abstract authUrl(): string | Promise<string>;

  /** The provider's token endpoint. See `authUrl()`. */
  protected abstract tokenUrl(): string | Promise<string>;

  /** Fetch the provider's user payload with an access token. */
  protected abstract fetchUser(token: string): Promise<TRaw>;

  /** Map the provider's payload onto the normalised shape. */
  protected abstract mapUser(raw: TRaw): MappedSocialiteUser;

  /** Static metadata, which the instance getters delegate to. */
  protected abstract meta(): SocialiteDriverMeta;

  /**
   * Build a copy of this driver with different options.
   *
   * Abstract because a subclass knows its own constructor; every fluent
   * method routes through it, so a subclass cannot forget to be
   * immutable.
   */
  protected abstract withOptions(options: Oauth2DriverOptions): SocialiteDriver<TRaw>;

  // ------------------------------------------------------------- the surface

  getName(): string {
    return this.meta().name;
  }

  getWebsite(): string {
    return this.meta().website;
  }

  getScopes(): readonly string[] {
    return this.options.scopes.length > 0 ? this.options.scopes : this.defaultScopes;
  }

  scopes(scopes: string | string[]): SocialiteDriver<TRaw> {
    const merged = new Set([...this.getScopes(), ...toArray(scopes)]);

    return this.withOptions({ ...this.options, scopes: [...merged] });
  }

  setScopes(scopes: string | string[]): SocialiteDriver<TRaw> {
    return this.withOptions({ ...this.options, scopes: [...new Set(toArray(scopes))] });
  }

  with(parameters: Record<string, string>): SocialiteDriver<TRaw> {
    return this.withOptions({ ...this.options, parameters: { ...parameters } });
  }

  redirectUrl(url: string): SocialiteDriver<TRaw> {
    return this.withOptions({ ...this.options, redirectUrl: url });
  }

  stateless(): SocialiteDriver<TRaw> {
    return this.withOptions({ ...this.options, stateless: true });
  }

  withPkce(): SocialiteDriver<TRaw> {
    return this.withOptions({ ...this.options, pkce: true });
  }

  async redirect(request: Request): Promise<string> {
    const state = this.options.stateless ? null : randomToken();
    const verifier = this.usesPkce() ? randomToken() : null;
    const nonce = this.usesNonce() ? randomToken() : null;

    if (state !== null || verifier !== null || nonce !== null) {
      queueState(
        request,
        this.context.signer,
        { provider: this.context.name, state, verifier, nonce },
        this.context.cookie,
      );
    }

    const fields = await this.codeFields(state, verifier);

    return `${await this.authUrl()}?${buildQuery(
      nonce === null ? fields : { ...fields, nonce, ...this.options.parameters },
      this.encoding,
    )}`;
  }

  async user(request: Request): Promise<SocialiteUser<TRaw>> {
    // Pulled unconditionally, even when stateless, because the pull is
    // also what clears the cookie — a stateless call after a stateful
    // one would otherwise leave a live cookie behind, and single-use is
    // what makes a replayed callback fail.
    const pulled = pullState(request, this.context.signer, this.context.name, this.context.cookie);

    let stashed: SocialiteState | null = null;

    if (this.options.stateless) {
      stashed = pulled.ok ? pulled.state : null;
    } else {
      stashed = assertStateMatches(this.context.name, pulled, request.query("state"));
    }

    const code = request.query("code");

    if (code === undefined || code === "") {
      throw new MissingAuthorizationCodeError(
        this.context.name,
        request.query("error"),
        request.query("error_description"),
      );
    }

    const { token, response } = await this.exchangeCode(code, stashed?.verifier ?? null);

    return this.resolveUser(token, stashed, response);
  }

  async userFromToken(token: string): Promise<SocialiteUser<TRaw>> {
    // `verify()` is skipped: there is no authorization round trip here,
    // so there is no `id_token` to validate and no nonce to match. A
    // driver that needs a verified token must say so by refusing the
    // method, not by validating something that was never issued.
    const raw = await this.fetchUser(token);

    return {
      ...this.mapUser(raw),
      raw,
      token: { token, refreshToken: null, expiresIn: null, approvedScopes: [] },
    };
  }

  /**
   * Exchange a refresh token for fresh credentials.
   *
   * Overridable, and some providers must override it: Google omits
   * `refresh_token` on a refresh, so a driver that needs the original
   * carried forward does that here.
   */
  async refreshToken(refreshToken: string): Promise<SocialiteToken> {
    const response = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.context.clientId,
      ...(this.tokenAuth === "basic" ? {} : { client_secret: this.context.clientSecret }),
    });

    return this.parseToken(response);
  }

  // ------------------------------------------------------------- the innards

  /**
   * The authorization URL's query fields.
   *
   * `parameters` is spread **last**, deliberately, so `with()` can
   * override `scope` or `redirect_uri`. Socialite does the same.
   */
  protected async codeFields(
    state: string | null,
    verifier: string | null,
  ): Promise<Record<string, string | undefined>> {
    return {
      client_id: this.context.clientId,
      redirect_uri: this.redirectUri(),
      scope: this.getScopes().join(this.scopeSeparator),
      response_type: "code",
      ...(state === null ? {} : { state }),
      ...(verifier === null
        ? {}
        : { code_challenge: codeChallenge(verifier), code_challenge_method: "S256" }),
      ...this.options.parameters,
    };
  }

  /** The token request's form fields. */
  protected tokenFields(code: string, verifier: string | null): Record<string, string> {
    return {
      grant_type: "authorization_code",
      client_id: this.context.clientId,
      // Omitted under basic auth, where it travels in the header instead.
      ...(this.tokenAuth === "basic" ? {} : { client_secret: this.context.clientSecret }),
      code,
      redirect_uri: this.redirectUri(),
      ...(verifier === null ? {} : { code_verifier: verifier }),
    };
  }

  protected redirectUri(): string {
    return this.options.redirectUrl ?? this.context.resolveRedirectUrl();
  }

  /** Whether this flow uses PKCE: asked for, or required by the provider. */
  protected usesPkce(): boolean {
    return this.options.pkce || this.requiresPkce;
  }

  /**
   * Whether to mint an OIDC `nonce` on the authorization request.
   *
   * False here: a plain OAuth 2.0 provider has no `id_token` to bind one
   * to, and sending an unused `nonce` is noise. An OIDC driver overrides
   * this and checks the claim in `verify()`.
   */
  protected usesNonce(): boolean {
    return false;
  }

  /**
   * Hook run after the token exchange, before the user is fetched.
   *
   * Where an OIDC driver validates the `id_token` — signature, `iss`,
   * `aud`, `exp` and the `nonce` it stashed on the redirect. `stashed` is
   * null only for a stateless flow with no cookie.
   *
   * A no-op here, because a plain OAuth 2.0 flow has nothing to verify:
   * the code came back over TLS from a hardcoded endpoint and the token
   * was exchanged directly with it.
   */
  protected async verify(
    _token: SocialiteToken,
    _stashed: SocialiteState | null,
    _response: TokenResponse,
  ): Promise<void> {
    // Intentionally empty. See the docstring.
  }

  /** Headers for the token request. */
  protected tokenHeaders(): Record<string, string> {
    return { Accept: "application/json" };
  }

  /**
   * The authenticated request used to fetch the user.
   *
   * Overridable because providers disagree on the scheme: GitHub wants
   * `Authorization: token <t>`, most want `Bearer`.
   */
  protected authenticated(token: string): ReturnType<typeof Http.withToken> {
    return Http.withToken(token).acceptJson().withUserAgent(USER_AGENT).timeout(TIMEOUT_MS);
  }

  private async exchangeCode(
    code: string,
    verifier: string | null,
  ): Promise<{ token: SocialiteToken; response: TokenResponse }> {
    const response = await this.postToken(this.tokenFields(code, verifier));

    return { token: this.parseToken(response), response: decodeJson(response) };
  }

  private async postToken(fields: Record<string, string>): Promise<ClientResponse> {
    const pending =
      this.tokenAuth === "basic"
        ? Http.withBasicAuth(this.context.clientId, this.context.clientSecret).asForm()
        : Http.asForm();

    const response = await pending
      .withHeaders(this.tokenHeaders())
      .withUserAgent(USER_AGENT)
      .timeout(TIMEOUT_MS)
      .post(await this.tokenUrl(), fields);

    const body = decodeJson(response);

    // Checked before the status, because OAuth providers routinely
    // answer a refused exchange with a 200 and an `error` body — GitHub
    // reports a wrong client_secret that way.
    if (typeof body.error === "string") {
      throw new TokenExchangeFailedError(
        this.context.name,
        response.status,
        body.error,
        typeof body.error_description === "string" ? body.error_description : undefined,
      );
    }

    if (response.failed()) {
      throw new TokenExchangeFailedError(this.context.name, response.status, undefined, undefined);
    }

    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new TokenExchangeFailedError(
        this.context.name,
        response.status,
        undefined,
        "the response carried no access_token",
      );
    }

    return response;
  }

  private parseToken(response: ClientResponse): SocialiteToken {
    const body = decodeJson(response);

    return {
      token: String(body.access_token),
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
      approvedScopes: this.splitScopes(body.scope),
    };
  }

  /**
   * Split a token response's `scope`.
   *
   * `[]` rather than `[""]` for an absent or empty value. See
   * `SocialiteToken.approvedScopes`.
   */
  protected splitScopes(scope: unknown): readonly string[] {
    // Twitch answers with a JSON array rather than a delimited string,
    // and Socialite special-cases it in the provider; handling both here
    // means no driver has to.
    if (Array.isArray(scope)) {
      return scope.filter((entry): entry is string => typeof entry === "string");
    }

    if (typeof scope !== "string" || scope === "") {
      return [];
    }

    return scope.split(this.scopeSeparator).filter((entry) => entry !== "");
  }

  private async resolveUser(
    token: SocialiteToken,
    stashed: SocialiteState | null = null,
    response: TokenResponse = {},
  ): Promise<SocialiteUser<TRaw>> {
    await this.verify(token, stashed, response);

    const raw = await this.fetchUser(token.token);

    // Note the absence of a `this.user` memo. Socialite caches the
    // resolved user on the provider; on a driver cached for the process
    // lifetime that would serve one user's profile to the next request.
    return { ...this.mapUser(raw), raw, token };
  }

  /** Throw `UserFetchFailedError` unless `response` succeeded. */
  protected assertUserFetched(response: ClientResponse): void {
    if (response.failed()) {
      throw new UserFetchFailedError(this.context.name, response.status);
    }
  }
}

function toArray(scopes: string | string[]): string[] {
  return typeof scopes === "string" ? [scopes] : scopes;
}

function decodeJson(response: ClientResponse): TokenResponse {
  try {
    const body = response.json<unknown>();

    return typeof body === "object" && body !== null ? (body as TokenResponse) : {};
  } catch {
    return {};
  }
}

/** The options a freshly configured driver starts from. */
export function defaultDriverOptions(
  overrides: Partial<Oauth2DriverOptions> = {},
): Oauth2DriverOptions {
  return {
    scopes: overrides.scopes ?? [],
    parameters: overrides.parameters ?? {},
    redirectUrl: overrides.redirectUrl,
    stateless: overrides.stateless ?? false,
    pkce: overrides.pkce ?? false,
  };
}
