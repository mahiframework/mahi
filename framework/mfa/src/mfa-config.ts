import type { TotpAlgorithm } from "./totp/totp.js";

/**
 * What to do when a guarded action is reached by a user who has nothing
 * enrolled.
 *
 * Three values rather than a boolean, because the useful answer to
 * "they have not set up MFA" is usually neither "let them through" nor
 * "block them forever":
 *
 * - `deny`: 403. The default. Correct when enrollment is mandatory and
 *   enforced elsewhere (at registration, by an admin).
 * - `challenge`: 403 with `mfa_enrollment_required`, so the client can
 *   route the user to enrollment and bring them back. Correct for
 *   progressive rollout.
 * - `allow`: pass. Correct only while MFA is genuinely optional, and
 *   the reason this is named `allow` rather than something softer like
 *   `grace` is that the name should say what it does.
 *
 * SECURITY NOTE. `allow` is partly attacker-reachable: a user who can
 * delete their own enrollment WITHOUT passing MFA downgrades themselves
 * to unenrolled and bypasses every check set to `allow`. Enrollment
 * mutation must itself be guarded, resolved against the enrollment
 * state as it was BEFORE the mutation.
 */
export type WhenUnenrolled = "deny" | "allow" | "challenge";

export interface TotpDriverConfig {
  /** Code length. 6 is universal. */
  digits?: number;
  /** Seconds per step. 30 is the only value apps assume. */
  period?: number;
  /** Steps of clock skew accepted either side of now. */
  window?: number;
  /** See `totp.ts` on why this defaults to SHA1 and should usually stay there. */
  algorithm?: TotpAlgorithm;
  /** Shown as the credential issuer in the user's authenticator app. */
  issuer?: string;
}

export interface EmailDriverConfig {
  /** Column on the user model holding the address. Defaults to `email`. */
  column?: string;
  /** Digits in the emailed code. */
  digits?: number;
  /** How long an issued code stays valid. */
  expiresInMinutes?: number;
  /**
   * Seconds before the same user may be sent another code.
   *
   * Per-MAILBOX, and complementary to the per-IP `throttle()` middleware
   * on the route rather than a replacement for it: an attacker rotating
   * IPs to flood one inbox defeats the middleware and not this.
   */
  throttleSeconds?: number;
  /**
   * Offer a click-through link as well as the code.
   *
   * OFF BY DEFAULT, and that is a security decision rather than a
   * convenience one. A code has to be typed back into the session that
   * requested it, so it proves possession of the mailbox AND the
   * session. A link is clickable from anywhere, so a phished click
   * yields a verified intent, and the session binding cannot hold on
   * that path. Turn it on knowing that.
   */
  link?: boolean;
}

export interface RecoveryDriverConfig {
  /** How many codes a `generate()` produces. */
  count?: number;
  /** Bytes of entropy per code, before base32 encoding. */
  bytes?: number;
}

export interface MfaConfig {
  /**
   * Drivers a user may choose between, in preference order. Listing a
   * driver here is what makes it available; registering one only makes
   * it resolvable.
   *
   * `email` is deliberately not on by default. It is a weaker factor
   * than TOTP (mailbox compromise is the common account-takeover
   * vector), so treating it as equivalent should be explicit.
   */
  drivers: string[];

  /** Minutes a user has to complete a challenge once an intent is created. */
  intentExpiresInMinutes?: number;

  /** Minutes a successful verification authorizes actions for. The sudo window. */
  verificationExpiresInMinutes?: number;

  /** Failed verifications before an intent is locked. */
  maxAttempts?: number;

  /** Default policy for a user with nothing enrolled. Overridable per call. */
  whenUnenrolled?: WhenUnenrolled;

  /**
   * Bind an intent to the session or token that created it.
   *
   * On by default. Turning it off means a second concurrent session for
   * the same user can consume a verification it never performed, which
   * is occasionally what an app wants (a desktop client completing a
   * step-up started on mobile) and is usually not.
   */
  bindToSession?: boolean;

  /** Which auth guard to read the session/token binding from. Defaults to the auth default. */
  guard?: string;

  /** Which auth user provider to resolve users through. Defaults to the auth default. */
  provider?: string;

  totp?: TotpDriverConfig;
  email?: EmailDriverConfig;
  recovery?: RecoveryDriverConfig;
}
