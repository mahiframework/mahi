import { randomBytes, timingSafeEqual } from "node:crypto";
import { app } from "@mahiframework/core";
import { SIGNER_TOKEN, type Signer } from "@mahiframework/encryption";
import { HttpError, type CookieOptions, type HttpPipe } from "@mahiframework/http";
import { CsrfTokenMismatch } from "../events/csrf-token-mismatch.js";
import { fireAuthEvent } from "../events/fire-auth-event.js";

export interface CsrfOptions {
  /** Cookie holding the token. Readable by JS by design. See below. */
  cookie?: string;
  /** Header the client must echo it back in. */
  header?: string;
  /**
   * Form field checked when the header is absent, for non-JS clients
   * posting a plain HTML form. Defaults to `"_token"` (Laravel's name).
   * Set to `null` to accept the header only.
   */
  field?: string | null;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  domain?: string;
  /**
   * `__Host-`/`__Secure-` cookie prefix. `"host"` is the strongest
   * option. A `__Host-` cookie cannot be written by a sibling subdomain,
   * which closes the one hole double-submit CSRF otherwise leaves open
   * (see below).
   *
   * Defaults to `"host"` for a secure cookie that isn't scoped to an
   * explicit `domain` or a non-root `path` (the only shapes `__Host-`
   * permits), and to `"secure"` for a secure cookie that is. Set
   * explicitly to override, or to `undefined` via `secure: false` for
   * plain-HTTP local development.
   */
  prefix?: "secure" | "host";
  /**
   * Sign the cookie with the app's `Signer` so a token the server never
   * issued is rejected. Defaults to `true` when a `Signer` is bound.
   */
  sign?: boolean;
  /** Methods that skip the check. Defaults to GET/HEAD/OPTIONS. */
  safeMethods?: string[];
}

const DEFAULT_SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/**
 * Double-submit-cookie CSRF protection.
 *
 * A random token is set in a cookie that JS CAN read (deliberately not
 * `httpOnly`), and unsafe requests must send it back in a header or form
 * field. An attacker's cross-origin page can make the browser *send* the
 * cookie but cannot *read* it, so it cannot produce the matching header.
 * That asymmetry is the entire mechanism.
 *
 * SIGNED, not bare. The cookie value is `<token>.<hmac>` via the app's
 * `Signer`, and a cookie whose signature doesn't verify is discarded and
 * re-issued rather than trusted. Without that, plain double-submit
 * accepts *any* value that appears in both places, so an attacker able
 * to write a cookie (an XSS on a sibling subdomain, a MITM on plain HTTP,
 * which can set cookies for the HTTPS origin) can pick both halves and
 * forge freely. Signing means only tokens this server minted count.
 *
 * NOT the same as Sanctum/Laravel's synchronizer token: Laravel binds
 * the token to the *session*, so a
 * token is useless in anyone else's session. This is per-cookie, which is
 * strictly weaker against an attacker who can write cookies to the
 * victim's browser. Combine `prefix: "host"` with HTTPS to close that
 * gap, and prefer `SameSite=Lax` (the default here) as the primary
 * defense.
 *
 * The cookie is queued on the `Request`, so it is written by the HTTP
 * boundary regardless of what the handler returns. See `@mahiframework/http`'s
 * `cookies.ts`.
 */
export function csrf(options: CsrfOptions = {}): HttpPipe {
  const cookieName = options.cookie ?? "XSRF-TOKEN";
  const headerName = options.header ?? "X-XSRF-TOKEN";
  const fieldName = options.field === undefined ? "_token" : options.field;
  const safeMethods = new Set(
    (options.safeMethods ?? DEFAULT_SAFE_METHODS).map((method) => method.toUpperCase()),
  );

  const prefix = resolvePrefix(options);

  return async (request, next) => {
    const signer = resolveSigner(options.sign);

    const presentedCookie = request.cookie(cookieName, prefix);
    // A cookie that doesn't verify is treated as absent: it was tampered
    // with, forged, or signed with a retired key. Reissuing beats
    // rejecting, so a user with a stale cookie gets a working form back
    // rather than a wall of 403s.
    const existing = readToken(presentedCookie, signer);

    const token = existing ?? randomBytes(32).toString("base64url");

    if (!safeMethods.has(request.method())) {
      // Compared against the verified token, never the raw cookie, so an
      // unsigned or tampered cookie can't be echoed back to itself.
      if (
        existing === null ||
        !tokensMatch(presentedToken(request, headerName, fieldName), existing)
      ) {
        // Awaited before the throw, so a listener sees the rejection in
        // order. A listener that throws replaces the 403 with its own
        // error: the documented cost of in-band dispatch, and it matters
        // more here than elsewhere because this is already an error path.
        await fireAuthEvent(new CsrfTokenMismatch(request.method(), request.path()));

        throw HttpError.forbidden("CSRF token mismatch.");
      }
    }

    if (existing === null) {
      request.queueCookie(
        cookieName,
        signer ? signer.sign(token) : token,
        cookieOptions(options, prefix),
      );
    }

    return next(request);
  };
}

/**
 * The cookie prefix to enforce, defaulting to the strongest one the
 * cookie's shape allows.
 *
 * An unprefixed CSRF cookie can be overwritten by a sibling subdomain (via
 * XSS there, or a MITM on plain HTTP setting a cookie for the HTTPS
 * origin), which is exactly the write primitive double-submit can't defend
 * against on its own. `__Host-` forbids that, but it also forbids a
 * `Domain` attribute and a non-root `Path`, so we can only default to it
 * when the cookie isn't scoped that way; otherwise `__Secure-` is the
 * strongest compatible choice. On plain HTTP (`secure: false`) no prefix
 * is possible.
 */
function resolvePrefix(options: CsrfOptions): "secure" | "host" | undefined {
  if (options.prefix !== undefined) {
    return options.prefix;
  }

  if (options.secure === false) {
    return undefined;
  }

  const scoped =
    options.domain !== undefined || (options.path !== undefined && options.path !== "/");

  return scoped ? "secure" : "host";
}

/**
 * The app's `Signer`, or null when signing is off or encryption isn't
 * bound. Explicit `sign: true` with no `Signer` is a configuration
 * mistake and fails loudly rather than silently downgrading to unsigned.
 */
function resolveSigner(sign: boolean | undefined): Signer | null {
  if (sign === false) {
    return null;
  }

  let container;
  try {
    container = app();
  } catch {
    container = undefined;
  }

  if (container?.has(SIGNER_TOKEN) === true) {
    return container.make<Signer>(SIGNER_TOKEN);
  }

  if (sign === true) {
    throw new Error(
      "csrf({ sign: true }) requires a Signer, but SIGNER_TOKEN is not bound. " +
        "Register EncryptionServiceProvider, or pass sign: false to accept unsigned tokens.",
    );
  }

  return null;
}

/** Unwrap a cookie value into the token it carries, or null if untrustworthy. */
function readToken(cookie: string | undefined, signer: Signer | null): string | null {
  if (!cookie) {
    return null;
  }

  if (signer === null) {
    return cookie;
  }

  return signer.verify(cookie);
}

/**
 * The token the client presented: the header first, then the form field.
 *
 * The field fallback is what makes this usable from a plain HTML form,
 * a client with no JavaScript cannot set a header at all, so a
 * header-only check silently restricts the app to fetch/XHR callers.
 */
function presentedToken(
  request: { header(key: string): string | undefined; input(key: string): unknown },
  headerName: string,
  fieldName: string | null,
): string | undefined {
  const fromHeader = request.header(headerName);

  if (fromHeader !== undefined && fromHeader !== "") {
    return fromHeader;
  }

  if (fieldName === null) {
    return undefined;
  }

  const fromField = request.input(fieldName);

  return typeof fromField === "string" && fromField !== "" ? fromField : undefined;
}

function cookieOptions(options: CsrfOptions, prefix: "secure" | "host" | undefined): CookieOptions {
  return {
    // Deliberately NOT httpOnly: the client has to read this one to echo
    // it back. That is safe precisely because the token is not itself a
    // credential. It proves same-origin, not identity.
    httpOnly: false,
    secure: options.secure ?? true,
    sameSite: options.sameSite ?? "Lax",
    path: options.path ?? "/",
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}

function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) {
    return false;
  }

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  // Constant-time: a naive `===` leaks how much of the token matched,
  // which is enough to recover it byte by byte given enough attempts.
  return a.length === b.length && timingSafeEqual(a, b);
}
