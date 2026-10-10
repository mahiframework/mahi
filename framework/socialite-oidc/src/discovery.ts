import { UnsafeUrlError, assertSafeUrl } from "@mahiframework/core";
import { Http } from "@mahiframework/http-client";
import { DiscoveryFailedError, UnsafeEndpointError } from "./errors.js";

/**
 * The subset of an OpenID Provider's metadata this driver reads.
 *
 * `issuer`, `authorization_endpoint`, `token_endpoint` and `jwks_uri` are
 * REQUIRED by OpenID Connect Discovery 1.0 §3; the rest are optional and
 * are typed as such.
 */
export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const REQUIRED = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
] as const satisfies readonly (keyof OidcDiscoveryDocument)[];

/**
 * Every endpoint this driver will subsequently fetch or redirect a
 * browser to, all of them chosen by the remote document.
 *
 * `end_session_endpoint` is included because `logoutUrl()` puts it in a
 * `Location` header, and a redirect to `file:` or `javascript:` is the
 * app's problem even though no server-side fetch is involved.
 */
const ENDPOINTS = [
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
  "userinfo_endpoint",
  "end_session_endpoint",
] as const satisfies readonly (keyof OidcDiscoveryDocument)[];

/** The well-known path, per OpenID Connect Discovery 1.0 §4. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * Fetch and validate an issuer's discovery document.
 *
 * **The document's own `issuer` must equal the configured one.** Without
 * that check a tampered or substituted document redirects every endpoint
 * — authorization, token, JWKS — somewhere else, and an attacker who can
 * influence discovery owns the whole flow. `Kovah/laravel-socialite-oidc`
 * omits this.
 *
 * **And every endpoint it names is validated as an outbound target.**
 * An issuer URL is admin-entered and so is trusted configuration, but
 * `.well-known/openid-configuration` then supplies four more URLs that
 * are NOT — `authorization_endpoint`, `token_endpoint`, `jwks_uri` and
 * `userinfo_endpoint`, each of which this server afterwards fetches. A
 * hostile or compromised issuer otherwise gets a fetch primitive aimed
 * at the deployment's own network, including its instance metadata. See
 * `assertEndpoints()`.
 *
 * Caching is the caller's job (see `DiscoveryCache`); this function always
 * performs the request.
 */
export async function fetchDiscovery(
  issuer: string,
  options: DiscoveryOptions = {},
): Promise<OidcDiscoveryDocument> {
  const url = discoveryUrl(issuer);
  let response;

  try {
    response = await Http.acceptJson().withUserAgent("Mahi Socialite").timeout(10_000).get(url);
  } catch (error) {
    throw new DiscoveryFailedError(issuer, url, String(error));
  }

  if (response.failed()) {
    throw new DiscoveryFailedError(issuer, url, `HTTP ${response.status}`);
  }

  let document: unknown;

  try {
    document = response.json<unknown>();
  } catch {
    throw new DiscoveryFailedError(issuer, url, "the response was not JSON");
  }

  if (typeof document !== "object" || document === null) {
    throw new DiscoveryFailedError(issuer, url, "the response was not a JSON object");
  }

  const candidate = document as Record<string, unknown>;
  const missing = REQUIRED.filter((key) => typeof candidate[key] !== "string");

  if (missing.length > 0) {
    throw new DiscoveryFailedError(
      issuer,
      url,
      `the document is missing required fields: ${missing.join(", ")}`,
    );
  }

  const declared = candidate.issuer as string;

  if (!issuerMatches(declared, issuer)) {
    throw new DiscoveryFailedError(
      issuer,
      url,
      `the document declares issuer "${declared}", which is not the configured issuer`,
    );
  }

  const metadata = candidate as unknown as OidcDiscoveryDocument;

  await assertEndpoints(issuer, metadata, options);

  return metadata;
}

/** How strictly a discovery document's endpoints are judged. */
export interface DiscoveryOptions {
  /**
   * Hosts, besides the issuer's own, whose endpoints are acceptable.
   *
   * Some IdPs legitimately serve a sibling host — Entra ID's `jwks_uri`
   * is on `login.microsoftonline.com` while the issuer is
   * `sts.windows.net`, and a split deployment may put userinfo behind a
   * different name. Those hosts are named here rather than inferred,
   * because "any host the document feels like" is the SSRF.
   *
   * These are trusted exactly as the issuer is: a host named here is
   * permitted to be internal, since an admin who writes
   * `keys.idp.internal` into config has said what they meant.
   */
  allowHosts?: readonly string[];
}

/**
 * Validate every endpoint the document names as an outbound target.
 *
 * **The host must be one an administrator chose**: the issuer's own, or
 * one named in `allowHosts`. Not "a public address" — *that* host.
 *
 * This is deliberately an origin check rather than an address policy,
 * and it is both stronger and cheaper. Stronger, because a hostile
 * document cannot name anywhere the admin did not already pick: not a
 * LAN address, not the metadata endpoint, not a public host of its own
 * choosing either, which an address policy would happily allow.
 * Cheaper, because it needs no DNS — so it decides the same way in an
 * air-gapped deployment, costs no resolver round trip per login, and is
 * immune to the DNS-rebinding race that makes a by-name address check
 * advisory (see `assertSafeUrl()`). The endpoints of a self-hosted IdP
 * on `192.168.1.10` are reachable with no `allowPrivate` flag, because
 * the issuer is already `https://192.168.1.10/realms/main` and that is
 * the admin's decision, not the document's.
 *
 * Scheme and credentials are still checked, through `assertSafeUrl()`
 * with the host pre-allowed so no resolution happens. Those are
 * properties of the string rather than of the network, and an issuer
 * answering with `javascript:` in `end_session_endpoint` is a redirect
 * the app would otherwise emit.
 */
async function assertEndpoints(
  issuer: string,
  metadata: OidcDiscoveryDocument,
  options: DiscoveryOptions,
): Promise<void> {
  const origin = originOf(issuer);
  const allowed = (options.allowHosts ?? []).map((host) => host.toLowerCase());

  for (const key of ENDPOINTS) {
    const endpoint = metadata[key];

    if (typeof endpoint !== "string" || endpoint === "") {
      continue;
    }

    let parsed: URL;

    try {
      parsed = new URL(endpoint);
    } catch {
      throw new UnsafeEndpointError(issuer, key, endpoint, "it is not a valid URL");
    }

    if (parsed.origin !== origin && !allowed.includes(parsed.hostname.toLowerCase())) {
      throw new UnsafeEndpointError(
        issuer,
        key,
        endpoint,
        `its origin is not the issuer's (${origin ?? "unparseable"}) and ` +
          `"${parsed.hostname}" is not in allowHosts`,
      );
    }

    try {
      // `allowHosts` carries the host so nothing is resolved: the host
      // is already known-good by name. Only the scheme and credential
      // rules can speak here.
      await assertSafeUrl(endpoint, { allowHosts: [parsed.hostname] });
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new UnsafeEndpointError(issuer, key, endpoint, error.message);
      }

      throw error;
    }
  }
}

/** `scheme://host:port`, or null when `url` is not a URL. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Compare two issuer identifiers.
 *
 * Exact string equality per OIDC Core §3.1.3.7 step 2, modulo a trailing
 * slash — a configured `https://idp.test/` and a declared
 * `https://idp.test` are the same issuer, and treating them as different
 * is a configuration papercut with no security value. No case folding,
 * no scheme or port normalisation: those would be real divergences.
 */
export function issuerMatches(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * A discovery document with an expiry.
 *
 * In-memory and per-driver, which is the right scope: a driver is a
 * process-lifetime singleton, so this is a process-lifetime cache, and it
 * needs no `@mahiframework/cache` dependency for one small document.
 *
 * Cached because discovery is otherwise a live HTTP dependency on **every
 * redirect and every callback** — which is what `Kovah`'s package does,
 * making the IdP's availability and latency a hard dependency of every
 * login.
 */
export class DiscoveryCache {
  private document: OidcDiscoveryDocument | undefined;
  private expiresAt = 0;
  private inFlight: Promise<OidcDiscoveryDocument> | undefined;

  constructor(
    private readonly issuer: string,
    private readonly ttlMs: number,
    /**
     * Endpoint rules, applied on every fetch rather than once.
     *
     * A cached document has already passed them, so re-checking a hit
     * would be pointless; a refetch has not, so it is checked again. An
     * issuer that starts answering with a hostile document after a key
     * rotation is caught at the TTL boundary.
     */
    private readonly options: DiscoveryOptions = {},
  ) {}

  /** The document, fetching it if absent or stale. */
  async get(): Promise<OidcDiscoveryDocument> {
    if (this.document !== undefined && Date.now() < this.expiresAt) {
      return this.document;
    }

    // Collapse concurrent misses into one request: a cold process taking
    // ten simultaneous logins should make one discovery call, not ten.
    this.inFlight ??= this.load();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async load(): Promise<OidcDiscoveryDocument> {
    const document = await fetchDiscovery(this.issuer, this.options);

    this.document = document;
    this.expiresAt = Date.now() + this.ttlMs;

    return document;
  }

  /** Drop the cached document, so the next `get()` refetches. */
  forget(): void {
    this.document = undefined;
    this.expiresAt = 0;
  }
}
