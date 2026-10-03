import { randomUUID } from "node:crypto";
import type { Encrypter } from "@mahiframework/encryption";
import { DateTime } from "@mahiframework/datetime";
import type { TotpDriverConfig } from "../mfa-config.js";
import type {
  ChallengeResult,
  MfaChallengeContext,
  MfaDriver,
  MfaVerifyContext,
  VerifyResult,
} from "../mfa-driver.js";
import { MfaMethod } from "../models/mfa-method.js";
import { generateSecret, verifyCode } from "../totp/totp.js";
import { otpauthUri } from "../totp/otpauth-uri.js";

export interface TotpEnrollment {
  /** The method row id, which the confirm step needs. */
  methodId: string;
  /** Base32 secret, for manual entry. */
  secret: string;
  /** `otpauth://` URI to render as a QR code. */
  uri: string;
}

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * ENROLLMENT IS TWO STEPS. `enroll()` mints a secret and writes an
 * UNCONFIRMED row; `confirm()` requires a working code before the
 * method counts for anything. Skipping the second step would let a user
 * whose authenticator scanned a stale QR, or who mistyped the secret,
 * end up with a method that can never produce a valid code, and if
 * `whenUnenrolled` is `deny` that locks them out of an account the
 * broken enrollment appears to protect.
 *
 * The secret is encrypted rather than hashed, because verification has
 * to recompute the code and therefore needs the plaintext back. The
 * user id is bound in as AAD, so a ciphertext moved between rows fails
 * to decrypt rather than quietly working.
 *
 * `challenge()` is a no-op returning `ready`: the user already holds
 * the factor, there is nothing to send, and writing a challenge row
 * would imply otherwise.
 */
export class TotpDriver implements MfaDriver {
  readonly name = "totp";

  constructor(
    private readonly encrypter: Encrypter,
    private readonly config: TotpDriverConfig = {},
  ) {}

  private get digits(): number {
    return this.config.digits ?? 6;
  }

  private get period(): number {
    return this.config.period ?? 30;
  }

  private get window(): number {
    return this.config.window ?? 1;
  }

  private get algorithm() {
    return this.config.algorithm ?? "SHA1";
  }

  async enrolled(userId: string): Promise<boolean> {
    return (await this.confirmedMethods(userId)).length > 0;
  }

  /**
   * Mint a secret and return it with its enrollment URI.
   *
   * The row is written unconfirmed, so this call alone changes nothing
   * about whether the user is considered enrolled. The plaintext secret
   * is returned here and nowhere else.
   */
  async enroll(userId: string, label?: string): Promise<TotpEnrollment> {
    const secret = generateSecret();
    const methodId = randomUUID();

    await MfaMethod.create({
      id: methodId,
      user_id: userId,
      driver: this.name,
      secret: this.encrypt(secret, userId),
      label: label ?? null,
      confirmed_at: null,
      last_used_timestep: null,
      created_at: DateTime.now(),
    });

    return {
      methodId,
      secret,
      uri: otpauthUri({
        secret,
        account: label ?? userId,
        ...(this.config.issuer === undefined ? {} : { issuer: this.config.issuer }),
        digits: this.digits,
        period: this.period,
        algorithm: this.algorithm,
      }),
    };
  }

  /**
   * Prove a code against a pending enrollment and activate it.
   *
   * Also sets the replay floor from the accepted step, so the very code
   * used to confirm cannot then be replayed to satisfy a verification.
   */
  async confirm(userId: string, methodId: string, code: string): Promise<boolean> {
    const method = await MfaMethod.find(methodId);

    if (
      method === undefined ||
      method.user_id !== userId ||
      method.driver !== this.name ||
      method.confirmed_at !== null ||
      method.secret === null
    ) {
      return false;
    }

    const result = verifyCode(this.decrypt(method.secret, userId), code, {
      digits: this.digits,
      period: this.period,
      window: this.window,
      algorithm: this.algorithm,
    });

    if (!result.valid) {
      return false;
    }

    await MfaMethod.update(methodId, {
      confirmed_at: DateTime.now(),
      last_used_timestep: result.step,
    });

    return true;
  }

  /** Nothing to deliver; the user's authenticator already has the secret. */
  async challenge(context: MfaChallengeContext): Promise<ChallengeResult> {
    if (!(await this.enrolled(context.intent.user_id))) {
      return { status: "unavailable", reason: "No confirmed authenticator app." };
    }

    return { status: "ready" };
  }

  /**
   * Verify against every confirmed method the user has.
   *
   * Multiple authenticators are allowed (a phone and a tablet), so this
   * tries each. Every method is tried even after one matches, so the
   * time taken does not reveal WHICH device was used.
   */
  async verify(context: MfaVerifyContext): Promise<VerifyResult> {
    const methods = await this.confirmedMethods(context.intent.user_id);

    if (methods.length === 0) {
      return { status: "unavailable", reason: "No confirmed authenticator app." };
    }

    let matched: { id: string; step: number } | null = null;

    for (const method of methods) {
      if (method.secret === null) {
        continue;
      }

      const result = verifyCode(this.decrypt(method.secret, context.intent.user_id), context.code, {
        digits: this.digits,
        period: this.period,
        window: this.window,
        algorithm: this.algorithm,
        after: method.last_used_timestep,
      });

      if (result.valid && result.step !== null) {
        matched ??= { id: method.id, step: result.step };
      }
    }

    if (matched === null) {
      return { status: "invalid-code" };
    }

    // THE REPLAY FLOOR. Without this write the same code verifies for
    // its whole window, which at the default is up to 90 seconds of a
    // reusable second factor. `verifyCode` refuses any step at or below
    // what is stored here.
    await MfaMethod.update(matched.id, { last_used_timestep: matched.step });

    return { status: "verified" };
  }

  /** Every confirmed TOTP method for a user. */
  private async confirmedMethods(userId: string): Promise<MfaMethod[]> {
    const methods = await MfaMethod.query()
      .where("user_id", "=", userId)
      .where("driver", "=", this.name)
      .whereNotNull("confirmed_at")
      .get();

    return methods.all();
  }

  /**
   * AAD binds the ciphertext to its owner AND its column, so a secret
   * copied into another user's row fails to decrypt instead of silently
   * authenticating the wrong person.
   */
  private aad(userId: string): string {
    return `mfa_methods.secret:${userId}`;
  }

  private encrypt(secret: string, userId: string): string {
    return this.encrypter.encrypt(secret, this.aad(userId));
  }

  private decrypt(payload: string, userId: string): string {
    return this.encrypter.decrypt(payload, this.aad(userId));
  }
}
