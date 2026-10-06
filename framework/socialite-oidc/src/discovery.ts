import { Http } from "@mahiframework/http-client";
import { DiscoveryFailedError } from "./errors.js";

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
 * Caching is the caller's job (see `DiscoveryCache`); this function always
 * performs the request.
 */
export async function fetchDiscovery(issuer: string): Promise<OidcDiscoveryDocument> {
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

  return candidate as unknown as OidcDiscoveryDocument;
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
    const document = await fetchDiscovery(this.issuer);

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
