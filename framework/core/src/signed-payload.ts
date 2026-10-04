/**
 * The HMAC canonicalisation shared by everything that signs or verifies a
 * URL, kept here rather than in the package that owns `Signer`.
 *
 * WHY HERE: signing and verifying must hash the *identical* string, and
 * they happen in different packages. `@mahiframework/http` signs
 * email-verification and password-reset links; `@mahiframework/storage`
 * signs temporary disk URLs. Two copies of this function would be two
 * copies that can drift, and a drift between signer and verifier
 * invalidates every live link silently — no type error, no test failure
 * until a user clicks one.
 *
 * `core` is the only package every other package already depends on, and
 * the primitives below are pure string/crypto work with no HTTP and no
 * key management. The `Signer` itself stays in
 * `@mahiframework/encryption`: it owns key derivation and rotation, and
 * pulling that in would drag `argon2`'s native build into anything that
 * merely wants to verify a signature. Consumers resolve it by the
 * `SIGNER_TOKEN` string and type it structurally as `SignerLike`.
 *
 * A signed URL is `path?...params...&expires=<unix>&signature=<hmac>`,
 * where the HMAC covers the path plus every query param except
 * `signature` itself, sorted by key so build and verify agree regardless
 * of the order they were supplied in.
 */

/** The query param carrying the HMAC. Excluded from the signed payload. */
export const SIGNATURE_PARAM = "signature";

/** The query param carrying absolute unix-seconds expiry. Part of the payload. */
export const EXPIRES_PARAM = "expires";

/**
 * The slice of `@mahiframework/encryption`'s `Signer` that signing and
 * verifying a URL actually needs.
 *
 * Structural on purpose: it lets a package resolve the signer by its
 * container token without a compile-time dependency on the package that
 * owns it, which is the same approach `@mahiframework/broadcasting` takes
 * for its channel-auth grants.
 */
export interface SignerLike {
  sign(payload: string): string;
  verify(signedPayload: string): string | null;
  /** A signer whose key is HKDF-derived for one purpose, e.g. `"url"`. */
  for(purpose: string): SignerLike;
}

/**
 * Canonical `path?sortedQuery` string that both sign and verify hash. The
 * `signature` param is always excluded; every other param (including
 * `expires`) participates, sorted by key for a stable ordering.
 */
export function canonicalPayload(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams();

  for (const key of Object.keys(params).sort()) {
    if (key === SIGNATURE_PARAM) {
      continue;
    }

    search.set(key, params[key]!);
  }

  const query = search.toString();

  return query ? `${path}?${query}` : path;
}

/**
 * Compute just the HMAC signature for a canonical payload.
 *
 * `Signer.sign()` returns `${payload}.${hmac}`; this slices off and
 * returns only the hmac, which callers carry as a `signature` query
 * param.
 */
export function computeSignature(payload: string, signer: SignerLike): string {
  const signed = signer.sign(payload);

  return signed.slice(payload.length + 1);
}

export interface BuildSignedUrlOptions {
  /** Seconds from now until the link expires. Omit for a non-expiring signature. */
  expiresInSeconds?: number;
  /** Absolute unix-seconds override for "now" (tests). */
  now?: number;
}

/**
 * Build `path?params&expires&signature` from an already-resolved signer.
 *
 * The signer is a parameter rather than resolved here, so this stays free
 * of container access and each caller can apply its own
 * `signer.for(purpose)` narrowing.
 */
export function buildSignedUrl(
  path: string,
  params: Record<string, string>,
  signer: SignerLike,
  options: BuildSignedUrlOptions = {},
): string {
  const allParams: Record<string, string> = { ...params };

  if (options.expiresInSeconds !== undefined) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    allParams[EXPIRES_PARAM] = String(now + options.expiresInSeconds);
  }

  const payload = canonicalPayload(path, allParams);
  const signature = computeSignature(payload, signer);

  const search = new URLSearchParams(allParams);
  search.set(SIGNATURE_PARAM, signature);

  return `${path}?${search.toString()}`;
}

/**
 * The slice of a request this module needs to verify a signature: the
 * path, and the raw query string.
 *
 * Structural so `@mahiframework/storage` can verify a signed disk URL
 * without depending on `@mahiframework/http`, exactly as
 * `servePublicDisk` already takes a structural `{ path() }`.
 */
export interface SignedRequestLike {
  path(): string;
  queryString(): string;
}

export interface VerifySignedPayloadOptions {
  /** Absolute unix-seconds override for "now" (tests). */
  now?: number;
}

/**
 * Whether a request carries a valid, unexpired signature.
 *
 * The signer must already be narrowed to its purpose by the caller.
 */
export function verifySignedPayload(
  request: SignedRequestLike,
  signer: SignerLike,
  options: VerifySignedPayloadOptions = {},
): boolean {
  // Rebuilt from the RAW query string, not a parsed bag. A parsed bag
  // expands bracket notation (`ids[]=1` becomes an array), so
  // canonicalising it would hash a different string than the one that was
  // signed for any link carrying a bracketed param — a signature that
  // verifies in a unit test and fails in production.
  const query: Record<string, string> = {};

  for (const [key, value] of new URLSearchParams(request.queryString())) {
    query[key] = value;
  }

  const signature = query[SIGNATURE_PARAM];

  if (!signature) {
    return false;
  }

  const expires = query[EXPIRES_PARAM];

  if (expires !== undefined) {
    const expiresAt = Number(expires);
    const now = options.now ?? Math.floor(Date.now() / 1000);

    if (!Number.isFinite(expiresAt) || now > expiresAt) {
      return false;
    }
  }

  const payload = canonicalPayload(request.path(), query);

  return signer.verify(`${payload}.${signature}`) === payload;
}
