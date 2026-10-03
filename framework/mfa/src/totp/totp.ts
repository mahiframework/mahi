import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeBase32, encodeBase32 } from "./base32.js";

/**
 * RFC 6238 TOTP, over RFC 4226 HOTP.
 *
 * Hand-rolled on `node:crypto` rather than taken from `otplib` or
 * `speakeasy`. The algorithm is an HMAC, a dynamic truncation and a
 * modulo; the precedent is `@mahiframework/encryption`, which hand-rolls
 * AES-GCM framing, HKDF derivation and HMAC signing rather than taking a
 * crypto dependency. An MFA package whose core feature needed an extra
 * `npm install` to work would be the wrong seam.
 *
 * SHA1 IS THE DEFAULT, and that is correct rather than legacy. RFC 6238
 * §1.2 permits SHA-256 and SHA-512, but the `otpauth://` `algorithm`
 * parameter is widely ignored: Google Authenticator and several others
 * assume SHA1 whatever the URI says, so enrolling with SHA-256 produces
 * an authenticator that generates codes the server will never accept,
 * with no diagnostic. HMAC-SHA1 is not weakened by any known attack in
 * this construction (it needs no collision resistance), so the
 * interoperability argument wins outright. The other two are supported
 * for apps that control both ends.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpOptions {
  /** Code length. 6 is universal; 8 is permitted by RFC 6238 and rarely supported. */
  digits?: number;
  /** Seconds per time step. 30 is the only value authenticator apps assume. */
  period?: number;
  /** HMAC hash. See the note above on why this defaults to SHA1. */
  algorithm?: TotpAlgorithm;
}

export interface TotpVerifyOptions extends TotpOptions {
  /**
   * How many steps either side of now to accept, for clock skew between
   * the server and the user's phone. 1 means ±30s at the default period.
   *
   * Every extra step widens the window a captured code stays usable in,
   * so this trades usability for replay exposure directly. The driver
   * closes that by recording the accepted step and refusing to reuse it;
   * see `TotpDriver`.
   */
  window?: number;
  /**
   * Reject any step at or below this one. The replay defense: a step
   * already used by a successful verification cannot be used again.
   */
  after?: number | null;
  /** Unix seconds to verify at. Defaults to now. Tests pass this. */
  at?: number;
}

const DEFAULTS = {
  digits: 6,
  period: 30,
  algorithm: "SHA1" as TotpAlgorithm,
};

/** Node's digest names for the three RFC 6238 algorithms. */
const DIGESTS: Record<TotpAlgorithm, string> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
};

/**
 * A new random secret, base32-encoded.
 *
 * 20 bytes (160 bits) by default: the HMAC-SHA1 block-aligned size, what
 * RFC 4226 §4 R6 recommends as a minimum, and what every authenticator
 * app handles without complaint. Larger secrets are permitted and buy
 * nothing here, since HMAC-SHA1 keys longer than its 64-byte block are
 * hashed down anyway.
 */
export function generateSecret(bytes = 20): string {
  return encodeBase32(randomBytes(bytes));
}

/** The RFC 6238 time step containing `unixSeconds`. */
export function timestepAt(unixSeconds: number, period = DEFAULTS.period): number {
  return Math.floor(unixSeconds / period);
}

/**
 * The code for one specific time step.
 *
 * This is RFC 4226 HOTP: HMAC the 8-byte big-endian counter, take the
 * low nibble of the last byte as an offset, read four bytes from there,
 * clear the sign bit, and take the last `digits` decimal places.
 */
export function generateCodeForStep(
  secret: string,
  step: number,
  options: TotpOptions = {},
): string {
  const digits = options.digits ?? DEFAULTS.digits;
  const algorithm = options.algorithm ?? DEFAULTS.algorithm;

  const key = decodeBase32(secret);

  // The counter is 8 bytes big-endian. `BigInt` rather than two 32-bit
  // halves because a step past 2^31 (year 3038 at a 30s period) would
  // overflow a bitwise write, and getting that wrong is a bug nobody
  // would see for a thousand years.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac(DIGESTS[algorithm], key).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.3. The offset comes from the low
  // four bits of the final byte, so which four bytes are used varies
  // per code.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for the step containing `at` (default now). */
export function generateCode(secret: string, options: TotpOptions & { at?: number } = {}): string {
  const period = options.period ?? DEFAULTS.period;
  const at = options.at ?? Math.floor(Date.now() / 1000);

  return generateCodeForStep(secret, timestepAt(at, period), options);
}

export interface TotpVerifyResult {
  /** Whether a step in the accepted window produced this code. */
  valid: boolean;
  /**
   * The step that matched, for the caller to persist as the replay
   * floor. Null when nothing matched.
   */
  step: number | null;
}

/**
 * Verify a submitted code against the accepted window.
 *
 * Returns the matching step rather than a bare boolean, because the
 * caller MUST persist it: a TOTP code stays valid for its whole period,
 * so without recording which step was consumed the same code verifies
 * repeatedly, and with `window: 1` a captured code is replayable for up
 * to three periods. That makes the second factor a 90-second bearer
 * token. `after` is the other half of the same mechanism.
 *
 * Comparison is `timingSafeEqual`, not `===`. The same class of bug
 * `Signer.verify()` and `verifyTokenHash()` both guard against, and just
 * as easy to "simplify" back into a vulnerability during review.
 *
 * The whole window is always walked, even after a match, so the time
 * taken does not reveal WHICH step matched. A short-circuit would make a
 * code one step in the past measurably faster than one step in the
 * future.
 */
export function verifyCode(
  secret: string,
  code: string,
  options: TotpVerifyOptions = {},
): TotpVerifyResult {
  const digits = options.digits ?? DEFAULTS.digits;
  const period = options.period ?? DEFAULTS.period;
  const window = options.window ?? 1;
  const after = options.after ?? null;
  const at = options.at ?? Math.floor(Date.now() / 1000);

  const submitted = code.trim().replace(/\s/g, "");

  // Length is checked before any HMAC work: a code of the wrong length
  // cannot match any step, and `timingSafeEqual` throws on a length
  // mismatch rather than returning false.
  if (submitted.length !== digits) {
    return { valid: false, step: null };
  }

  const current = timestepAt(at, period);
  const expected = Buffer.from(submitted, "utf-8");
  let matched: number | null = null;

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;

    // A replayed step is skipped rather than compared. It cannot be
    // allowed to match, and comparing anyway would mean a replay and a
    // wrong code are distinguishable by the work done.
    if (after !== null && step <= after) {
      continue;
    }

    if (step < 0) {
      continue;
    }

    const candidate = Buffer.from(generateCodeForStep(secret, step, options), "utf-8");

    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      // No `break`: see the note above on walking the whole window.
      matched ??= step;
    }
  }

  return matched === null ? { valid: false, step: null } : { valid: true, step: matched };
}
