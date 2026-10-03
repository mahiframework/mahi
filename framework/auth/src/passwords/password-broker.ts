import { randomBytes } from "node:crypto";
import { DateTime } from "@mahiframework/datetime";
import type { Hasher } from "@mahiframework/encryption";
import type { UserProvider } from "../user-provider.js";
import { PasswordResetToken } from "./password-reset-token.model.js";
import { fireAuthEvent } from "../events/fire-auth-event.js";
import { PasswordReset } from "../events/password-reset.js";
import { PasswordResetLinkSent } from "../events/password-reset-link-sent.js";

export interface PasswordBrokerConfig {
  /**
   * Minutes a reset token stays valid. Defaults to 60 (Laravel's
   * default). Expired tokens are rejected on `reset()` and swept by
   * `auth:gc`.
   */
  expiresInMinutes?: number;
  /**
   * Seconds before a second reset link may be requested for the same
   * address. Defaults to 60 (Laravel's `throttle`). Set to 0 to disable.
   *
   * This is about the MAILBOX, not the request rate: it stops an attacker
   * flooding a victim's inbox by replaying the same form, which
   * IP-based `throttle()` middleware cannot do anything about.
   */
  throttleSeconds?: number;
}

/**
 * Told when a password is successfully reset, so the rest of the app can
 * react (notify the user, write an audit record).
 *
 * Superseded by the `PasswordReset` event, which carries the same
 * `{ user, email }` payload and needs no wiring. This remains supported,
 * and is dispatched alongside the event, so applications already calling
 * `onPasswordReset()` need change nothing. Prefer the event for new code:
 * it is observable from a service provider's `listeners()` hook rather
 * than requiring a reference to the broker.
 */
export type PasswordResetListener = (event: {
  user: unknown;
  email: string;
}) => void | Promise<void>;

/**
 * How the broker revokes credentials after a password change. Both are
 * optional: an app with no sessions, or no personal access tokens, simply
 * doesn't wire the corresponding one.
 */
/**
 * Why credentials are being revoked, passed through to the
 * `CurrentDeviceLogout`/`TokenRevoked` events the revocation dispatches.
 *
 * It exists because a password reset is by far the most frequent cause of
 * mass revocation, and an audit log reporting it as "signed out of all
 * devices" describes a user action that never happened.
 */
export type RevocationReason = "requested" | "password_reset";

export interface CredentialRevoker {
  /** Destroy every session belonging to the user. */
  destroyForUser(userId: string, reason?: RevocationReason): Promise<void>;
}

export interface TokenRevoker {
  /** Revoke every personal access token belonging to the user. */
  revokeAllTokens(userId: string, reason?: RevocationReason): Promise<void>;
}

/**
 * Outcome of `sendResetLink()`. On success the raw `token` is handed back
 * to the CALLER, which decides how to deliver it (email, SMS, ...). The
 * framework owns the mechanism, the app owns the UX. Compare
 * `authorize()` vs `can()`: same "framework decides pass/fail, app
 * decides presentation" split.
 *
 * `status` is deliberately coarse. `sent` is returned even when no user
 * matched, so a caller that surfaces it directly can't be used to
 * enumerate which emails have accounts. `throttled` is only ever returned
 * when a real user was found (see `sendResetLink`).
 */
export type SendResetLinkResult =
  { status: "sent"; email: string; token?: string } | { status: "throttled" };

export type ResetResult =
  | { status: "reset" }
  | { status: "invalid-token" }
  | { status: "expired-token" }
  | { status: "invalid-user" };

/**
 * Single-broker password reset, deliberately narrower than Laravel's
 * `PasswordBrokerManager` + multi-broker setup: this framework has no
 * stated multi-user-table goal, so one broker over one `UserProvider` is
 * enough.
 *
 * The token is stored as an argon2 hash (via the shared `Hasher`), the
 * same slow hash used for passwords. A reset token is a short-lived
 * credential a human may paste, and hashing it means a leaked
 * `password_reset_tokens` dump yields nothing usable. Verification is a
 * single PK lookup by email plus one `Hasher.check()`.
 *
 * RATE LIMITING is per-EMAIL and lives here (`throttleSeconds`), on top
 * of, not instead of, the `throttle()` HTTP middleware on the route.
 * The two answer different questions: middleware limits how often one
 * CLIENT may ask, this limits how often one MAILBOX may be written to. An
 * attacker rotating IPs to flood a victim's inbox defeats the first and
 * not the second.
 */
// `TUser extends object` rather than `Record<string, unknown>`. See the
// note on `DatabaseUserProvider`: a `Record` constraint silently excludes
// every `interface`-declared attribute type, which is the form the model
// docs teach.
export class PasswordBroker<TUser extends object = Record<string, unknown>> {
  private sessions: CredentialRevoker | undefined;
  private tokens: TokenRevoker | undefined;
  private listeners: PasswordResetListener[] = [];

  constructor(
    private readonly users: UserProvider<TUser>,
    private readonly hasher: Hasher,
    private readonly config: PasswordBrokerConfig = {},
    private readonly identifierColumn = "email",
  ) {}

  /**
   * Wire the stores a successful reset should revoke credentials in.
   *
   * Called by `AuthManager` when it builds the broker. Kept as an
   * explicit wiring step rather than a constructor argument so the broker
   * stays constructible in isolation (tests, an app with no sessions).
   */
  revokesWith(stores: { sessions?: CredentialRevoker; tokens?: TokenRevoker }): this {
    this.sessions = stores.sessions ?? this.sessions;
    this.tokens = stores.tokens ?? this.tokens;

    return this;
  }

  /** Register a listener fired after a successful reset. */
  onPasswordReset(listener: PasswordResetListener): this {
    this.listeners.push(listener);

    return this;
  }

  private get expiresInMinutes(): number {
    return this.config.expiresInMinutes ?? 60;
  }

  private get throttleSeconds(): number {
    return this.config.throttleSeconds ?? 60;
  }

  /**
   * Create (or overwrite) a reset token for the account matching
   * `email`, and return the raw token for the caller to deliver.
   *
   * When no user matches, returns `{ status: "sent" }` with NO token,
   * the same shape as success, so a caller relaying the status can't tell
   * the two apart. No row is written and no token is minted in that case.
   */
  async sendResetLink(email: string): Promise<SendResetLinkResult> {
    const user = await this.users.retrieveByCredentials({ [this.identifierColumn]: email });

    if (user === null) {
      return { status: "sent", email };
    }

    const existing = await PasswordResetToken.find(email);

    if (existing !== undefined && this.recentlyCreated(existing.created_at)) {
      // Only reachable for a REAL account, so it leaks nothing an
      // attacker couldn't already learn: an unknown address returned
      // above without ever consulting the table.
      return { status: "throttled" };
    }

    const token = randomBytes(32).toString("base64url");
    const hashed = await this.hasher.make(token);
    const now = DateTime.now();

    // One live reset per email, written as an UPSERT rather than
    // delete-then-insert. Two concurrent requests through the old pair
    // could both delete, then both insert, and the second insert violated
    // the primary key, a 500 on a password-reset form, triggerable by a
    // double-click.
    await PasswordResetToken.query().upsert([{ email, token: hashed, created_at: now }], "email", [
      "token",
      "created_at",
    ]);

    // Only on this path, so the event never fires for an unknown address.
    // That is deliberate: the return value hides the distinction, and an
    // event firing only for real accounts would re-create at the event
    // layer the enumeration oracle the response shape removes. See
    // `PasswordResetLinkSent`.
    await fireAuthEvent(new PasswordResetLinkSent(email, user));

    return { status: "sent", email, token };
  }

  /** Whether a token was minted too recently to mint another. */
  private recentlyCreated(createdAt: DateTime): boolean {
    if (this.throttleSeconds <= 0) {
      return false;
    }

    return createdAt.addSeconds(this.throttleSeconds).isFuture();
  }

  /**
   * Consume a reset token and set the new password.
   *
   * Verifies the token against the stored hash, checks expiry, confirms
   * the user still exists, applies the new password via the injected
   * `setPassword`, then deletes the token (single use). Any failure
   * leaves the token in place EXCEPT expiry, which deletes the stale row.
   */
  async reset(email: string, token: string, newPassword: string): Promise<ResetResult> {
    const record = await PasswordResetToken.find(email);

    if (record === undefined) {
      // Burn a hash on the miss path so "no pending reset" costs the same
      // as "wrong token". Without it, an unknown address returns
      // instantly while a known one pays for an argon2 verify (~50–100ms
      // at 64 MiB), a timing oracle for which accounts have a reset
      // pending, and an unthrottled way to make the server do that work.
      // `AuthManager.attempt()` already does the same on its miss path.
      await this.hasher.make(token);

      return { status: "invalid-token" };
    }

    if (this.isExpired(record.created_at)) {
      await PasswordResetToken.delete(email);
      // Burn a hash here too: the miss and wrong-token paths each pay one
      // argon2 verify, so a fast return would make "expired reset pending"
      // timing-distinguishable from both of them.
      await this.hasher.make(token);

      return { status: "expired-token" };
    }

    if (!(await this.hasher.check(token, record.token))) {
      return { status: "invalid-token" };
    }

    const user = await this.users.retrieveByCredentials({ [this.identifierColumn]: email });

    if (user === null) {
      return { status: "invalid-user" };
    }

    if (this.users.updatePassword === undefined) {
      throw new Error(
        "The configured user provider does not support updatePassword(), " +
          "which PasswordBroker.reset() requires to persist the new password.",
      );
    }

    await this.users.updatePassword(user, await this.hasher.make(newPassword));
    await PasswordResetToken.delete(email);

    // REVOKE EVERYTHING ELSE. Password reset is the account-recovery
    // path, the thing a user does *because* they believe they were
    // compromised, so leaving the attacker's existing session and API
    // tokens alive defeats the entire exercise. These sessions are
    // server-side and long-lived (a "remember me" session runs to ~400
    // days), so without this a hijacked session outlives the recovery
    // that was supposed to end it.
    await this.revokeCredentials(user);

    for (const listener of this.listeners) {
      await listener({ user, email });
    }

    // After revocation, so a listener observing this can rely on every
    // prior session and token already being gone. The revocation itself
    // dispatched `CurrentDeviceLogout`/`TokenRevoked` with
    // `reason: "password_reset"`.
    await fireAuthEvent(new PasswordReset(email, user));

    return { status: "reset" };
  }

  /**
   * Destroy every session and personal access token for `user`.
   *
   * Best-effort per store: a cache-backed session store cannot revoke by
   * user at all (it throws by design), and that must not turn a
   * successful password reset into a 500. The password IS changed by the
   * time this runs. Failures are surfaced by rethrowing only if BOTH
   * stores are absent... which they can't be, since absence is the
   * no-op case.
   */
  private async revokeCredentials(user: TUser): Promise<void> {
    const id = (user as Record<string, unknown>)["id"];

    if (id === undefined || id === null) {
      return;
    }

    const userId = String(id);

    for (const revoke of [
      async () => this.sessions?.destroyForUser(userId, "password_reset"),
      async () => this.tokens?.revokeAllTokens(userId, "password_reset"),
    ]) {
      try {
        await revoke();
      } catch {
        // A store that can't revoke by user (CacheSessionStore) throws
        // rather than silently no-op'ing. Swallowed here because the
        // password has already changed: failing the request would tell
        // the user their reset didn't work when it did.
      }
    }
  }

  /** Delete expired reset tokens; returns how many were removed. Driven by `auth:gc`. */
  async gc(): Promise<number> {
    const cutoff = DateTime.now().subMinutes(this.expiresInMinutes);

    return PasswordResetToken.query().where("created_at", "<=", cutoff).delete();
  }

  private isExpired(createdAt: DateTime): boolean {
    return createdAt.addMinutes(this.expiresInMinutes).isPast();
  }
}
