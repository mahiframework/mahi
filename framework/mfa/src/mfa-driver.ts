import type { DateTime } from "@mahiframework/datetime";
import type { MfaIntent } from "./models/mfa-intent.js";

/**
 * A second factor.
 *
 * STATELESS BY CONTRACT, the same rule `@mahiframework/auth`'s `Guard`
 * states: a driver is a long-lived singleton resolved once by
 * `MfaManager` and shared across every concurrent request, so it must
 * never memoize per-attempt state on itself. Everything it needs
 * arrives in the context argument.
 *
 * Three methods, deliberately. "Which methods can this user use?" is a
 * derivation over `enrolled()` and lives on the manager, not here, so a
 * driver cannot disagree with the manager about its own availability.
 */
export interface MfaDriver {
  /** The name this driver is registered under, and stored in `mfa_intents.driver`. */
  readonly name: string;

  /**
   * Whether this user has a usable enrollment.
   *
   * "Usable" excludes an unconfirmed one: a TOTP secret the user never
   * proved a code against may be mistyped, and treating it as enrolled
   * would lock them out of an account it only appears to protect.
   */
  enrolled(userId: string): Promise<boolean>;

  /**
   * Begin verification.
   *
   * May mint a credential, in which case it is RETURNED rather than
   * delivered: the framework owns the mechanism, the app owns the
   * delivery. This is what keeps the package free of a mail dependency,
   * and it is the same split `PasswordBroker.sendResetLink()` uses.
   */
  challenge(context: MfaChallengeContext): Promise<ChallengeResult>;

  /**
   * Verify a submitted code.
   *
   * Returns an outcome; never throws for a wrong code. A thrown error
   * here means something is broken (no enrollment row, a decryption
   * failure), not that the user typed badly.
   */
  verify(context: MfaVerifyContext): Promise<VerifyResult>;
}

export interface MfaChallengeContext {
  /** The intent being challenged. Already persisted. */
  intent: MfaIntent;
  /** The user the intent belongs to, as the configured user provider returns it. */
  user: unknown;
}

export interface MfaVerifyContext {
  intent: MfaIntent;
  user: unknown;
  /** Exactly what the user submitted, untrimmed. */
  code: string;
}

/**
 * The outcome of starting a challenge.
 *
 * `issued` carries the plaintext credential for the caller to deliver;
 * it is the only place that value ever exists outside the user's
 * possession, and it is never persisted in the clear.
 */
export type ChallengeResult =
  | {
      /** Nothing to deliver: the user already holds the factor (TOTP, recovery). */
      status: "ready";
    }
  | {
      /** A credential was minted. Deliver it, then stop holding it. */
      status: "issued";
      code: string;
      expiresAt: DateTime;
      /** An optional click-through URL, when the driver is configured to offer one. */
      url?: string;
    }
  | {
      /** Too soon since the last issue for this user. */
      status: "throttled";
      retryAfterSeconds: number;
    }
  | {
      /** This driver cannot be used right now (no enrollment, no address). */
      status: "unavailable";
      reason: string;
    };

export type VerifyResult =
  | { status: "verified" }
  | { status: "invalid-code" }
  | { status: "expired" }
  /** No live challenge for this intent, for a driver that needs one. */
  | { status: "no-challenge" }
  | { status: "unavailable"; reason: string };
