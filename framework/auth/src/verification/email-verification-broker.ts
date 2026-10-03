import { createHash, timingSafeEqual } from "node:crypto";
import type { AnyModelClass } from "@mahiframework/database";
import { signedUrl, type SignedUrlOptions } from "@mahiframework/http";
import type { UserProvider } from "../user-provider.js";
import { hasVerifiedEmail, markEmailAsVerified } from "./email-verification.js";
import { fireAuthEvent } from "../events/fire-auth-event.js";
import { EmailVerificationSent } from "../events/email-verification-sent.js";
import { EmailVerified } from "../events/email-verified.js";

export interface EmailVerificationConfig {
  /** Minutes a verification link stays valid. Defaults to 60, as Laravel's does. */
  expiresInMinutes?: number;
  /** Column holding the verification timestamp. Defaults to `email_verified_at`. */
  column?: string;
  /** Column holding the address being verified. Defaults to `email`. */
  identifierColumn?: string;
  /**
   * Path the signed link points at. The user id and email hash are appended
   * as query params, so the route needs no path parameters. It reads
   * `?id=` and `?hash=`. Defaults to `/auth/verify-email`.
   */
  path?: string;
}

export type VerificationResult =
  | { status: "verified" }
  | { status: "already-verified" }
  | { status: "invalid-user" }
  | { status: "invalid-hash" };

export type SendVerificationResult =
  { status: "sent"; url: string } | { status: "already-verified" } | { status: "invalid-user" };

/**
 * Email verification, as the counterpart to `PasswordBroker`.
 *
 * Verification already had its state mechanics (`hasVerifiedEmail`,
 * `markEmailAsVerified`) and its gate (`ensureEmailVerified()`), but the
 * security-sensitive middle, minting a tamper-proof link, deciding
 * whether it still refers to the address it was issued for, and applying
 * the transition idempotently, was left entirely to the app, while the
 * structurally identical password-reset flow got a fully-tested broker.
 * That asymmetry was the real gap; this closes it.
 *
 * ## Signed URLs, not a token table
 *
 * Unlike `PasswordBroker`, this stores nothing. The link is an HMAC-signed
 * URL (`@mahiframework/http`'s `signedUrl()`), so there is no table, no migration
 * and no GC sweep. That is the right trade here and NOT for password
 * reset, because the two differ in one decisive way: a reset token is a
 * credential that grants the ability to *change* a password, so it must be
 * revocable, single-use, and hashed at rest. A verification link only ever
 * asserts "whoever received mail at this address asked for this", grants
 * no capability beyond flipping one boolean, and is naturally idempotent,
 * replaying it a second time is a no-op.
 *
 * The cost is honest: a verification link cannot be revoked before it
 * expires, and re-sending produces a second link without invalidating the
 * first. Both are acceptable for a capability this narrow. If an app needs
 * revocation, it wants a token table and should model it like the reset
 * flow.
 *
 * ## The email hash
 *
 * The signed payload carries a hash of the address being verified, and
 * `verify()` recomputes it against the user's CURRENT address. Without
 * this, the flow has a real hole: request a link for `a@example.com`,
 * change the account's address to `victim@example.com` before clicking,
 * then click, and the account is now "verified" at an address that never
 * received anything. The signature alone does not catch it, because the
 * URL was legitimately signed. Laravel guards this the same way.
 *
 * ## Throttling
 *
 * Deliberately none here, unlike `PasswordBroker.throttleSeconds`. The two
 * endpoints have different exposure: "forgot password" is UNAUTHENTICATED,
 * so anyone can point it at a stranger's mailbox and the per-mailbox
 * throttle is the only thing that stops an inbox flood. A "resend
 * verification" endpoint is authenticated and can only ever mail the
 * caller's own address, so the ordinary `throttle()` HTTP middleware,
 * which the app puts on the route anyway, is the correct and sufficient
 * control.
 */
export class EmailVerificationBroker<TUser extends object = Record<string, unknown>> {
  constructor(
    private readonly users: UserProvider<TUser>,
    private readonly model: AnyModelClass,
    private readonly config: EmailVerificationConfig = {},
  ) {}

  private get column(): string {
    return this.config.column ?? "email_verified_at";
  }

  private get identifierColumn(): string {
    return this.config.identifierColumn ?? "email";
  }

  private get expiresInMinutes(): number {
    return this.config.expiresInMinutes ?? 60;
  }

  private get path(): string {
    return this.config.path ?? "/auth/verify-email";
  }

  /** Whether this user's address is already verified. */
  hasVerified(user: TUser): boolean {
    return hasVerifiedEmail(user, this.column);
  }

  /**
   * Build the signed verification URL for a user.
   *
   * Returns the URL for the CALLER to deliver, exactly as
   * `PasswordBroker.sendResetLink()` returns its token. The framework
   * owns the mechanism, the app owns the message and the channel.
   *
   * `signerOptions` is threaded through for tests, which need to pass an
   * explicit `Signer`/`now` rather than resolve one off the container.
   */
  verificationUrl(userId: string, email: string, signerOptions: SignedUrlOptions = {}): string {
    return signedUrl(
      this.path,
      { id: userId, hash: this.hashEmail(email) },
      { expiresInSeconds: this.expiresInMinutes * 60, ...signerOptions },
    );
  }

  /**
   * Look up a user and mint their verification link.
   *
   * Returns `already-verified` rather than a link when there is nothing to
   * do, so a resend endpoint doesn't email a pointless link to someone who
   * has already clicked one.
   *
   * Note this does NOT hide whether the user exists, unlike
   * `sendResetLink()`. It doesn't need to: the only caller is an
   * authenticated resend endpoint acting on the caller's own account, so
   * there is no enumeration surface to protect.
   */
  async sendVerificationLink(
    userId: string,
    signerOptions: SignedUrlOptions = {},
  ): Promise<SendVerificationResult> {
    const user = await this.users.retrieveById(userId);

    if (user === null) {
      return { status: "invalid-user" };
    }

    if (this.hasVerified(user)) {
      return { status: "already-verified" };
    }

    const email = this.emailOf(user);

    if (email === undefined) {
      return { status: "invalid-user" };
    }

    const url = this.verificationUrl(userId, email, signerOptions);

    // The URL is NOT on the event: it is a capability, and anyone holding
    // it can verify the address. See `EmailVerificationSent`.
    await fireAuthEvent(new EmailVerificationSent(userId, email, user));

    return { status: "sent", url };
  }

  /**
   * Consume a verification link's `id` and `hash` and mark the address
   * verified.
   *
   * The SIGNATURE is not checked here. That is `validateSignature()`
   * middleware's job on the route, the same split as `authorize()` versus
   * the guard. This checks the two things the signature cannot: that the
   * user still exists, and that the hash still matches their current
   * address.
   *
   * Idempotent: a second click returns `already-verified` and rewrites
   * nothing, so the timestamp records when the address was FIRST verified
   * rather than when the link was last clicked.
   */
  async verify(userId: string, hash: string): Promise<VerificationResult> {
    const user = await this.users.retrieveById(userId);

    if (user === null) {
      return { status: "invalid-user" };
    }

    const email = this.emailOf(user);

    if (email === undefined || !this.hashMatches(hash, email)) {
      return { status: "invalid-hash" };
    }

    if (this.hasVerified(user)) {
      return { status: "already-verified" };
    }

    await markEmailAsVerified(this.model, userId, this.column);

    // Only on this path. `already-verified` changed nothing, and firing
    // there would make a one-time "welcome, you're verified" action run on
    // every refresh of the confirmation page.
    await fireAuthEvent(new EmailVerified(userId, email, user));

    return { status: "verified" };
  }

  /** The address being verified, read off the configured identifier column. */
  private emailOf(user: TUser): string | undefined {
    const value = (user as Record<string, unknown>)[this.identifierColumn];

    return typeof value === "string" ? value : undefined;
  }

  /**
   * SHA-256 of the address, truncated to 40 hex chars.
   *
   * A fast hash, not argon2, and deliberately so. This is not a secret
   * and not a credential. It is a tamper-evident binding between the link
   * and the address it was issued for, and the link is already
   * HMAC-signed, so there is nothing here for an attacker to brute-force
   * that they couldn't compute directly from an address they already know.
   * Making it slow would only make every click slow.
   */
  private hashEmail(email: string): string {
    return createHash("sha256").update(email).digest("hex").slice(0, 40);
  }

  /** Constant-time hash comparison, so a mismatch leaks nothing through timing. */
  private hashMatches(candidate: string, email: string): boolean {
    const expected = Buffer.from(this.hashEmail(email));
    const actual = Buffer.from(candidate);

    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  }
}
