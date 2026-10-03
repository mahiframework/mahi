import { randomBytes, randomUUID } from "node:crypto";
import { hashToken, verifyTokenHash } from "@mahiframework/auth";
import { DateTime } from "@mahiframework/datetime";
import type { RecoveryDriverConfig } from "../mfa-config.js";
import type {
  ChallengeResult,
  MfaChallengeContext,
  MfaDriver,
  MfaVerifyContext,
  VerifyResult,
} from "../mfa-driver.js";
import { encodeBase32 } from "../totp/base32.js";
import { MfaRecoveryCode } from "../models/mfa-recovery-code.js";

/**
 * Single-use recovery codes: the way back in when the phone is gone.
 *
 * TOTP without these is a lockout generator, which is why this ships as
 * a built-in rather than being left to apps. Modelling it as a DRIVER
 * rather than a special case means "I lost my phone" runs through the
 * same intent/verify machinery as every other factor, and inherits the
 * same attempt limiting.
 *
 * Hashed with SHA-256 via `@mahiframework/auth`'s `hashToken`, NOT
 * argon2. A code is 20 bytes of `randomBytes`, so there is no
 * low-entropy keyspace to brute-force and argon2's slowness would cost
 * a verify per stored code for nothing. The reasoning is written out in
 * that package's `token-hash.ts`, and the functions are reused rather
 * than reimplemented.
 */
export class RecoveryDriver implements MfaDriver {
  readonly name = "recovery";

  constructor(private readonly config: RecoveryDriverConfig = {}) {}

  private get count(): number {
    return this.config.count ?? 8;
  }

  private get bytes(): number {
    return this.config.bytes ?? 20;
  }

  async enrolled(userId: string): Promise<boolean> {
    return (await this.remaining(userId)) > 0;
  }

  /** How many unused codes the user has left. */
  async remaining(userId: string): Promise<number> {
    return MfaRecoveryCode.query().where("user_id", "=", userId).whereNull("used_at").count();
  }

  /**
   * Replace this user's codes and return the new plaintext set.
   *
   * The plaintext exists exactly once, here. Nothing can read it back
   * afterwards, which is what makes "we cannot show you these again"
   * literally true rather than a UI convention.
   *
   * Regenerating deletes the previous set, used or not: a user
   * regenerates because they believe the old list is compromised or
   * lost, so leaving any of it live would defeat the exercise.
   */
  async generate(userId: string): Promise<string[]> {
    await MfaRecoveryCode.query().where("user_id", "=", userId).delete();

    const now = DateTime.now();
    const codes: string[] = [];

    for (let index = 0; index < this.count; index += 1) {
      // Base32 rather than hex or base64url: these get read aloud and
      // typed by hand, and the RFC 4648 base32 alphabet already excludes
      // the characters that get confused doing that (0/O, 1/I/l).
      const code = encodeBase32(randomBytes(this.bytes));
      codes.push(code);

      await MfaRecoveryCode.create({
        id: randomUUID(),
        user_id: userId,
        code: hashToken(code),
        used_at: null,
        created_at: now,
      });
    }

    return codes;
  }

  /** Nothing to deliver; the user is holding the printed list. */
  async challenge(context: MfaChallengeContext): Promise<ChallengeResult> {
    if (!(await this.enrolled(context.intent.user_id))) {
      return { status: "unavailable", reason: "No unused recovery codes remain." };
    }

    return { status: "ready" };
  }

  /**
   * Consume a code.
   *
   * Every unused code is compared, with no short-circuit, so the time
   * taken does not reveal the submitted code's position in the list.
   * `verifyTokenHash` is constant-time per comparison.
   */
  async verify(context: MfaVerifyContext): Promise<VerifyResult> {
    const codes = (
      await MfaRecoveryCode.query()
        .where("user_id", "=", context.intent.user_id)
        .whereNull("used_at")
        .get()
    ).all();

    if (codes.length === 0) {
      return { status: "unavailable", reason: "No unused recovery codes remain." };
    }

    // Normalised the way the codes are displayed, so the spacing and
    // casing a user reproduces from a printout still match.
    const submitted = context.code.trim().replace(/[\s-]/g, "").toUpperCase();
    let matched: string | null = null;

    for (const record of codes) {
      if (verifyTokenHash(submitted, record.code)) {
        matched ??= record.id;
      }
    }

    if (matched === null) {
      return { status: "invalid-code" };
    }

    // SINGLE USE. Marked rather than deleted so the user can still be
    // told how many they have burned, which is the signal to regenerate.
    await MfaRecoveryCode.update(matched, { used_at: DateTime.now() });

    return { status: "verified" };
  }
}
