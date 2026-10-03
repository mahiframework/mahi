import { randomInt, randomUUID } from "node:crypto";
import type { Hasher, Signer } from "@mahiframework/encryption";
import { DateTime } from "@mahiframework/datetime";
import type { EmailDriverConfig } from "../mfa-config.js";
import type {
  ChallengeResult,
  MfaChallengeContext,
  MfaDriver,
  MfaVerifyContext,
  VerifyResult,
} from "../mfa-driver.js";
import { MfaChallenge } from "../models/mfa-challenge.js";
import { ChallengeIssued } from "../events/challenge-issued.js";
import { ChallengeThrottled } from "../events/challenge-throttled.js";
import { fireMfaEvent } from "../events/fire-mfa-event.js";

/**
 * A one-time code sent to the user's email address.
 *
 * ENROLLMENT IS IMPLICIT: a user with a non-empty address is enrolled,
 * because there is nothing to set up. That is also why this driver must
 * be listed in `config.drivers` deliberately rather than defaulting on,
 * since it is a WEAKER factor than TOTP (mailbox compromise is the
 * common account-takeover path) and an app treating it as equivalent
 * should do so knowingly.
 *
 * The code is MINTED AND RETURNED, never sent. This package has no mail
 * dependency; the caller delivers. Same split as
 * `PasswordBroker.sendResetLink()`, and the reason the scaffolded
 * controller — not the framework — decides whether an email goes out.
 *
 * Hashed with argon2, unlike recovery codes which use SHA-256. Not an
 * inconsistency: a 6-digit code has ~20 bits of entropy and is exactly
 * what a slow hash is for, while a 20-byte random recovery code gains
 * nothing from one.
 */
export class EmailDriver implements MfaDriver {
  readonly name = "email";

  constructor(
    private readonly hasher: Hasher,
    private readonly signer: Signer,
    private readonly config: EmailDriverConfig = {},
  ) {}

  private get column(): string {
    return this.config.column ?? "email";
  }

  private get digits(): number {
    return this.config.digits ?? 6;
  }

  private get expiresInMinutes(): number {
    return this.config.expiresInMinutes ?? 10;
  }

  private get throttleSeconds(): number {
    return this.config.throttleSeconds ?? 60;
  }

  /**
   * Enrollment cannot be checked without the user, and the contract
   * only passes an id, so this resolves nothing and answers true.
   *
   * The real check happens in `challenge()`, which has the user and
   * returns `unavailable` when the address is missing. Answering false
   * here would hide the driver from the method picker for every user,
   * since this method cannot see the address to know better.
   */
  async enrolled(_userId: string): Promise<boolean> {
    return true;
  }

  async challenge(context: MfaChallengeContext): Promise<ChallengeResult> {
    const address = this.addressOf(context.user);

    if (address === null) {
      return { status: "unavailable", reason: "This account has no email address." };
    }

    const recent = await this.recentChallenge(context.intent.id);

    if (recent !== undefined) {
      // `diffInSeconds` is positive when its ARGUMENT is later, so this
      // reads now → retry-eligible, not the reverse. Floored at 1 so a
      // sub-second remainder never reports `Retry-After: 0`.
      const retryAfter = Math.max(
        1,
        Math.ceil(DateTime.now().diffInSeconds(recent.created_at.addSeconds(this.throttleSeconds))),
      );

      await fireMfaEvent(
        new ChallengeThrottled(context.intent.user_id, this.name, context.intent.id, retryAfter),
      );

      return { status: "throttled", retryAfterSeconds: retryAfter };
    }

    // `randomInt` rather than `Math.random`: this is a credential, and
    // the max is exclusive, so 10**digits gives the full range
    // including leading-zero codes once padded.
    const code = String(randomInt(0, 10 ** this.digits)).padStart(this.digits, "0");
    const now = DateTime.now();
    const expiresAt = now.addMinutes(this.expiresInMinutes);

    const challengeId = randomUUID();

    await MfaChallenge.create({
      id: challengeId,
      intent_id: context.intent.id,
      driver: this.name,
      code: await this.hasher.make(code),
      attempts: 0,
      sent_at: now,
      expires_at: expiresAt,
      consumed_at: null,
      created_at: now,
    });

    // Neither the code nor the magic link is on the event: both are the
    // credential, and they are returned below for the caller to deliver.
    await fireMfaEvent(
      new ChallengeIssued(
        context.intent.user_id,
        this.name,
        context.intent.id,
        challengeId,
        expiresAt,
      ),
    );

    return {
      status: "issued",
      code,
      expiresAt,
      ...(this.config.link === true ? { url: this.linkFor(context.intent.id, code) } : {}),
    };
  }

  async verify(context: MfaVerifyContext): Promise<VerifyResult> {
    const challenge = await this.liveChallenge(context.intent.id);

    if (challenge === undefined) {
      // Burn a hash so "no challenge" costs what "wrong code" costs.
      // Without it, an unthrottled prober can distinguish the two by
      // timing and learn whether a code is outstanding. Same reasoning
      // as `PasswordBroker.reset()`'s miss path.
      await this.hasher.make(context.code);

      return { status: "no-challenge" };
    }

    if (challenge.expires_at.isPast()) {
      await this.hasher.make(context.code);

      return { status: "expired" };
    }

    if (!(await this.hasher.check(context.code.trim(), challenge.code))) {
      await MfaChallenge.update(challenge.id, { attempts: challenge.attempts + 1 });

      return { status: "invalid-code" };
    }

    // Consumed rather than deleted, so a verify racing a resend can
    // tell "already used" from "never existed". `mfa:gc` sweeps it.
    await MfaChallenge.update(challenge.id, { consumed_at: DateTime.now() });

    return { status: "verified" };
  }

  /**
   * A signed click-through URL carrying the intent and code.
   *
   * Only built when `link` is enabled. Signed with a purpose-narrowed
   * key so a signature minted for anything else in the app cannot be
   * replayed here. Note that the session binding cannot hold on this
   * path, which is why the option defaults off; see `EmailDriverConfig`.
   */
  private linkFor(intentId: string, code: string): string {
    return this.signer.for("mfa.email-link").sign(`${intentId}:${code}`);
  }

  /** The newest unconsumed, unexpired challenge for an intent. */
  private async liveChallenge(intentId: string): Promise<MfaChallenge | undefined> {
    return MfaChallenge.query()
      .where("intent_id", "=", intentId)
      .where("driver", "=", this.name)
      .whereNull("consumed_at")
      .orderBy("created_at", "desc")
      .first();
  }

  /** A challenge issued too recently for another to be sent. */
  private async recentChallenge(intentId: string): Promise<MfaChallenge | undefined> {
    if (this.throttleSeconds <= 0) {
      return undefined;
    }

    return MfaChallenge.query()
      .where("intent_id", "=", intentId)
      .where("driver", "=", this.name)
      .where("created_at", ">", DateTime.now().subSeconds(this.throttleSeconds))
      .orderBy("created_at", "desc")
      .first();
  }

  /**
   * Read the address off whatever the user provider returned.
   *
   * Indexed access rather than a typed property, because the column is
   * configurable and the user type belongs to the app. Empty strings
   * are treated as absent: a blank column is not a deliverable address,
   * and sending to `""` would throw deep inside a transport.
   */
  private addressOf(user: unknown): string | null {
    if (typeof user !== "object" || user === null) {
      return null;
    }

    const value = (user as Record<string, unknown>)[this.column];

    return typeof value === "string" && value.trim() !== "" ? value : null;
  }
}
