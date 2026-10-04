import {
  app,
  buildSignedUrl,
  verifySignedPayload,
  EXPIRES_PARAM,
  SIGNATURE_PARAM,
  SIGNER_TOKEN,
} from "@mahiframework/core";
import type { Signer } from "@mahiframework/encryption";
import type { Request } from "./request.js";
import { HttpError } from "./http-error.js";
import type { HttpPipe } from "./middleware/pipeline-middleware.js";

/**
 * HTTP-layer wrapper over `@mahiframework/encryption`'s `Signer`, the
 * equivalent of Laravel's `UrlGenerator::signedRoute()` + the
 * `ValidateSignature` middleware. This is the path-based form, where the
 * caller passes the raw path it already has; for a NAMED route, use
 * `URL.signedRoute(name, params)` (`url-generator.ts`), which resolves
 * the pattern and then signs through this same machinery.
 *
 * A signed URL is just `path?...params...&expires=<unix>&signature=<hmac>`,
 * where the HMAC covers the path plus every query param except
 * `signature` itself, in a canonical (sorted) order so build and verify
 * agree regardless of param ordering. Because the payload doesn't need to
 * stay secret, only tamper-evident, this uses `Signer` (HMAC), not
 * `Encrypter`; key rotation is handled by `Signer.verify()`.
 *
 * The canonicalisation itself lives in `@mahiframework/core`
 * (`signed-payload.ts`), because `@mahiframework/storage` signs temporary
 * disk URLs with the same scheme and the two sides must hash an identical
 * string. What stays here is the HTTP-shaped surface: resolving the
 * container's signer, and the `Request`-typed middleware.
 *
 * Directly needed by email-verification / password-reset / one-click
 * unsubscribe / invite links.
 */

export { SIGNATURE_PARAM, EXPIRES_PARAM };

export interface SignedUrlOptions {
  /** Seconds from now until the link expires. Omit for a non-expiring signature. */
  expiresInSeconds?: number;
  /** Override the resolved `Signer` (tests). Defaults to the `SIGNER_TOKEN` singleton. */
  signer?: Signer;
  /** Absolute unix-seconds override for "now" (tests). */
  now?: number;
}

/**
 * Resolves the signer and narrows it to the `"url"` purpose, so signed
 * URLs use a key derived exclusively for them. This is what stops a URL
 * signature being replayed as a session cookie (or vice versa), the two
 * consumers never share a key. Applied to explicitly-passed signers
 * too, so tests exercise the same derivation as production.
 */
export function resolveSigner(explicit?: Signer): Signer {
  return (explicit ?? app().make<Signer>(SIGNER_TOKEN)).for("url");
}

/**
 * Build a signed URL string. The returned value is `path` with the
 * combined query (`params` + optional `expires`) plus a trailing
 * `signature`. Pass it straight into an email/link; verify it later with
 * `validateSignature()` (middleware) or `hasValidSignature()`.
 *
 *   const url = signedUrl("/verify-email", { id: user.id }, { expiresInSeconds: 3600 });
 */
export function signedUrl(
  path: string,
  params: Record<string, string> = {},
  options: SignedUrlOptions = {},
): string {
  return buildSignedUrl(path, params, resolveSigner(options.signer), {
    expiresInSeconds: options.expiresInSeconds,
    now: options.now,
  });
}

export interface VerifySignatureOptions {
  signer?: Signer;
  now?: number;
}

/**
 * Verify a request's signature (and expiry) without throwing, returns
 * `true`/`false`. `validateSignature()` builds on this.
 */
export function hasValidSignature(request: Request, options: VerifySignatureOptions = {}): boolean {
  return verifySignedPayload(request, resolveSigner(options.signer), { now: options.now });
}

/**
 * Middleware (same factory-function shape as `throttle()`) that 403s a
 * request whose signature is missing, tampered, or expired. Attach to any
 * route reached via a `signedUrl()` link:
 *
 *   router.get("/verify-email", verifyEmail).middleware(validateSignature());
 */
export function validateSignature(options: VerifySignatureOptions = {}): HttpPipe {
  return async (request, next) => {
    if (!hasValidSignature(request, options)) {
      throw HttpError.forbidden("Invalid signature.");
    }

    return next(request);
  };
}
