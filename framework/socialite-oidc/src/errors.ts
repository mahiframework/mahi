import { SocialiteError } from "@mahiframework/socialite";

/**
 * The issuer's discovery document could not be fetched or trusted.
 *
 * Extends `SocialiteError` so an app catching the socialite family
 * catches this too — the package boundary is an implementation detail to
 * a controller rendering "sign-in failed".
 */
export class DiscoveryFailedError extends SocialiteError {
  constructor(
    readonly issuer: string,
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Could not load the OIDC configuration for "${issuer}" from ${url}: ${reason}.`);
  }
}

/**
 * A discovery document named an endpoint this driver will not fetch.
 *
 * Separate from `DiscoveryFailedError`, which means the document could
 * not be obtained or did not describe the configured issuer. This one
 * means it was obtained, describes the right issuer, and still points
 * somewhere it has no business pointing — which is the shape of an
 * attack rather than a misconfiguration, and worth distinguishing in a
 * log.
 */
export class UnsafeEndpointError extends SocialiteError {
  constructor(
    readonly issuer: string,
    /** The document key, e.g. `"token_endpoint"`. */
    readonly endpointName: string,
    readonly endpoint: string,
    readonly reason: string,
  ) {
    super(
      `The "${issuer}" discovery document's ${endpointName} ("${endpoint}") will not be used: ` +
        `${reason}. Endpoints must share the issuer's origin unless their host is listed in ` +
        `the provider's \`allowEndpointHosts\`.`,
    );
  }
}

/**
 * Why an `id_token` was rejected.
 *
 * Each value is a distinct failure with a distinct operational meaning,
 * and every one of them is a hard rejection. Enumerated rather than
 * collapsed because `nonce` and `audience` failures mean somebody is
 * replaying or cross-submitting tokens, while `expired` is usually a
 * clock or a slow user.
 */
export type IdTokenInvalidReason =
  /** The token was not present in the token response. */
  | "missing"
  /** The token is not a well-formed JWS. */
  | "malformed"
  /** The signature did not verify against the issuer's JWKS. */
  | "signature"
  /**
   * The `alg` header is not one this driver accepts.
   *
   * The defence against algorithm confusion: `alg: "none"`, and the
   * RS256→HS256 substitution where an attacker HMACs a token using the
   * issuer's *public* key as the shared secret.
   */
  | "algorithm"
  /** `iss` is not the configured issuer. */
  | "issuer"
  /** `aud` does not contain the client id, or multi-valued `aud` lacks a matching `azp`. */
  | "audience"
  /** `exp` is past, or `nbf`/`iat` is in the future, beyond the clock tolerance. */
  | "expired"
  /** `nonce` is absent or is not the one minted on the redirect. */
  | "nonce"
  /** A claim the driver requires is absent. */
  | "claims";

const REASONS: Record<IdTokenInvalidReason, string> = {
  missing: "the token response carried no id_token",
  malformed: "the id_token is not a well-formed JWT",
  signature: "the id_token's signature did not verify",
  algorithm: "the id_token is signed with an unacceptable algorithm",
  issuer: "the id_token's issuer does not match",
  audience: "the id_token's audience does not match the client id",
  expired: "the id_token is expired or not yet valid",
  nonce: "the id_token's nonce does not match the one issued",
  claims: "the id_token is missing a required claim",
};

/** The `id_token` failed validation. OIDC Core §3.1.3.7. */
export class IdTokenInvalidError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly reason: IdTokenInvalidReason,
    readonly detail?: string,
  ) {
    super(
      `The "${provider}" id_token was rejected: ${REASONS[reason]}` +
        `${detail === undefined ? "" : ` (${detail})`}.`,
    );
  }
}

/**
 * The userinfo response describes a different user than the `id_token`.
 *
 * OIDC Core §5.3.2 requires this check. Without it, a token belonging to
 * one user can be paired with another user's profile — and the profile
 * is what an app keys its account on.
 */
export class SubjectMismatchError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly idTokenSubject: string,
    readonly userinfoSubject: string,
  ) {
    super(
      `The "${provider}" userinfo subject ("${userinfoSubject}") does not match the ` +
        `id_token subject ("${idTokenSubject}"). Refusing to authenticate.`,
    );
  }
}

/** The issuer's metadata does not advertise an endpoint this driver needs. */
export class EndpointUnsupportedError extends SocialiteError {
  constructor(
    readonly provider: string,
    readonly endpoint: string,
  ) {
    super(`The "${provider}" issuer's metadata advertises no ${endpoint}.`);
  }
}
