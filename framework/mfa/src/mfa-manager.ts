import { randomUUID } from "node:crypto";
import type { Application } from "@mahiframework/core";
import { Manager, AUTH_TOKEN } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import type { Request } from "@mahiframework/http";
import type { MfaConfig, WhenUnenrolled } from "./mfa-config.js";
import type { MfaDriver, ChallengeResult, VerifyResult } from "./mfa-driver.js";
import { MfaIntent, type MfaIntentStatus } from "./models/mfa-intent.js";
import { UnknownMfaDriverError } from "./errors.js";
import { fireMfaEvent } from "./events/fire-mfa-event.js";
import { IntentLocked } from "./events/intent-locked.js";
import { VerificationFailed } from "./events/verification-failed.js";
import { Verified } from "./events/verified.js";

/**
 * How the manager reaches `@mahiframework/auth` without importing the
 * concrete `AuthManager`.
 *
 * Structural, not nominal, for one specific reason: `AuthManager`'s
 * `guard()` returns a `Guard`, and the two methods needed here
 * (`sessionId`, `currentTokenId`) live on the two concrete guards
 * rather than on the interface. Probing by capability is what
 * `AuthManager.credentialRevoker()` already does, and for the same
 * reason: guards are named by the app, so a name lookup finds nothing.
 */
interface AuthLike {
  userProvider(name?: string): {
    retrieveById(id: string): Promise<unknown>;
  };
  guard(name?: string): unknown;
  getDefaultDriver(): string;
}

/** A guard that can name the current session. `SessionGuard`. */
interface SessionIdentifiable {
  sessionId(request: Request): string | null;
}

/** A guard that can name the current token. `TokenGuard`. */
interface TokenIdentifiable {
  currentTokenId(request: Request): string | null;
}

export interface CreateIntentOptions {
  userId: string;
  purpose?: string | null;
  binding?: string | null;
}

/**
 * Resolves MFA drivers and owns the intent lifecycle.
 *
 * `extend()`, per-name caching and invalidation-on-re-register come
 * from `Manager`. Unlike `AuthManager` there is no name-vs-driver
 * split: an MFA driver's config key IS its name, because there is no
 * use case for two differently-configured TOTP drivers in one app, and
 * inventing one would make `mfa_intents.driver` ambiguous.
 */
export class MfaManager extends Manager<MfaDriver> {
  constructor(
    app: Application,
    private readonly config: MfaConfig,
  ) {
    super(app);
  }

  /**
   * `Manager` requires a default, but MFA has no meaningful "default
   * factor": the user picks. The first configured driver is returned so
   * a bare `driver()` is not an error, and every internal call names
   * its driver explicitly.
   */
  getDefaultDriver(): string {
    const first = this.config.drivers[0];

    if (first === undefined) {
      throw new Error("No MFA drivers are configured. Set `drivers` in config/mfa.ts.");
    }

    return first;
  }

  /** The raw config, for drivers and the provider. */
  get settings(): MfaConfig {
    return this.config;
  }

  get intentExpiresInMinutes(): number {
    return this.config.intentExpiresInMinutes ?? 10;
  }

  get verificationExpiresInMinutes(): number {
    return this.config.verificationExpiresInMinutes ?? 15;
  }

  get maxAttempts(): number {
    return this.config.maxAttempts ?? 5;
  }

  get whenUnenrolled(): WhenUnenrolled {
    return this.config.whenUnenrolled ?? "deny";
  }

  get bindToSession(): boolean {
    return this.config.bindToSession ?? true;
  }

  /** Driver names the app has made available, in preference order. */
  configuredDrivers(): string[] {
    return [...this.config.drivers];
  }

  /**
   * Resolve a driver, rejecting one the app has not listed.
   *
   * Registration and availability are separate on purpose: the provider
   * registers all three built-ins unconditionally so they are cheap to
   * turn on, and `config.drivers` is what actually exposes one to
   * users. Without this check, enabling `email` would be a no-op config
   * change that still let a client name `totp` directly.
   */
  use(name: string): MfaDriver {
    if (!this.config.drivers.includes(name)) {
      throw new UnknownMfaDriverError(name);
    }

    return this.driver(name);
  }

  /**
   * Which configured drivers this user can verify with right now.
   *
   * Preserves `config.drivers` order, so the app's preference is also
   * the display order. A driver whose `enrolled()` throws is treated as
   * unavailable rather than failing the whole lookup: one broken
   * factor must not make the others unreachable, which is precisely the
   * situation a user needs their other factors in.
   */
  async available(userId: string): Promise<string[]> {
    const names: string[] = [];

    for (const name of this.config.drivers) {
      try {
        if (await this.driver(name).enrolled(userId)) {
          names.push(name);
        }
      } catch (error) {
        this.app.logger.error(`mfa: driver "${name}" failed its enrollment check.`, { error });
      }
    }

    return names;
  }

  /**
   * The user record behind an id, via the configured auth user
   * provider.
   *
   * Going through the provider rather than taking a model class means
   * the app's column naming and soft-delete scopes are honoured, and
   * this package never needs to know what the users table is called.
   */
  async resolveUser(userId: string): Promise<unknown> {
    return this.auth().userProvider(this.config.provider).retrieveById(userId);
  }

  /**
   * The current request's session or token id, for binding.
   *
   * Capability-probed rather than looked up by guard name, because
   * guards are named by the app (`web`, `api`), so a name lookup finds
   * nothing in a Laravel-conventional app. Returns null when the active
   * guard exposes neither, in which case binding degrades to user-only
   * matching rather than failing.
   */
  bindingFor(request: Request): string | null {
    if (!this.bindToSession) {
      return null;
    }

    let guard: unknown;
    try {
      guard = this.auth().guard(this.config.guard);
    } catch {
      return null;
    }

    const session = guard as Partial<SessionIdentifiable>;

    if (typeof session.sessionId === "function") {
      return session.sessionId(request);
    }

    const token = guard as Partial<TokenIdentifiable>;

    if (typeof token.currentTokenId === "function") {
      return token.currentTokenId(request);
    }

    return null;
  }

  /**
   * Start a step-up attempt.
   *
   * Reuses a live pending intent for the same user/purpose/binding
   * rather than minting a second: a user who reloads the verification
   * page should land back on the attempt they started, keeping their
   * accumulated `attempts` count with it. Without reuse, the attempt
   * counter resets on every reload and `maxAttempts` enforces nothing.
   */
  async createIntent(options: CreateIntentOptions): Promise<MfaIntent> {
    const purpose = options.purpose ?? null;
    const binding = options.binding ?? null;
    const now = DateTime.now();

    const existing = await this.livePendingIntent(options.userId, purpose, binding);

    if (existing !== undefined) {
      return existing;
    }

    return MfaIntent.create({
      id: randomUUID(),
      user_id: options.userId,
      binding,
      purpose,
      status: "pending",
      driver: null,
      attempts: 0,
      verified_at: null,
      verification_expires_at: null,
      intent_expires_at: now.addMinutes(this.intentExpiresInMinutes),
      created_at: now,
    });
  }

  /** An unexpired, unlocked, unverified intent matching exactly. */
  private async livePendingIntent(
    userId: string,
    purpose: string | null,
    binding: string | null,
  ): Promise<MfaIntent | undefined> {
    const query = MfaIntent.query()
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .where("intent_expires_at", ">", DateTime.now())
      .orderBy("created_at", "desc");

    // `=== null` has to become `is null`, not `= null`, which matches
    // nothing in SQL and would silently mint a new intent every time.
    if (purpose === null) {
      query.whereNull("purpose");
    } else {
      query.where("purpose", "=", purpose);
    }

    if (binding === null) {
      query.whereNull("binding");
    } else {
      query.where("binding", "=", binding);
    }

    return query.first();
  }

  /** Load an intent by id. */
  async findIntent(intentId: string): Promise<MfaIntent | undefined> {
    return MfaIntent.find(intentId);
  }

  /**
   * Ask a driver to begin verification, recording which driver the
   * intent is now using.
   *
   * The driver is recorded BEFORE the challenge is issued, so a crash
   * between the two leaves an intent that knows what it was doing
   * rather than one that silently accepts a code from any factor.
   */
  async challenge(intent: MfaIntent, driverName: string): Promise<ChallengeResult> {
    const driver = this.use(driverName);
    const user = await this.resolveUser(intent.user_id);

    if (user === null || user === undefined) {
      return { status: "unavailable", reason: "The user no longer exists." };
    }

    if (intent.driver !== driverName) {
      await MfaIntent.update(intent.id, { driver: driverName });
      intent.driver = driverName;
    }

    return driver.challenge({ intent, user });
  }

  /**
   * Verify a submitted code against an intent.
   *
   * Counts the failure and locks the intent at `maxAttempts`. Returns
   * the driver's own result so the caller can distinguish "wrong code"
   * from "expired" from "no challenge", all of which are 4xx but mean
   * different next steps.
   *
   * Dispatches `Verified` on success, and `VerificationFailed` (plus
   * `IntentLocked` on the failure that crosses the limit) for a wrong
   * code. The other outcomes dispatch nothing, matching which of them
   * count against `maxAttempts`: an expired or missing challenge is not a
   * guess, so an event there would make the stream disagree with
   * `attempts`.
   */
  async verify(intent: MfaIntent, code: string): Promise<VerifyResult> {
    if (intent.status === "locked") {
      return { status: "unavailable", reason: "This verification is locked." };
    }

    if (intent.status === "verified") {
      // Idempotent: re-submitting the code that already worked is a
      // double-click, not an error. No event: `Verified` already fired for
      // this intent, and firing again would count clicks rather than
      // step-ups.
      return { status: "verified" };
    }

    if (intent.intent_expires_at.isPast()) {
      return { status: "expired" };
    }

    const driverName = intent.driver;

    if (driverName === null) {
      return { status: "no-challenge" };
    }

    const driver = this.use(driverName);
    const user = await this.resolveUser(intent.user_id);

    if (user === null || user === undefined) {
      return { status: "unavailable", reason: "The user no longer exists." };
    }

    const result = await driver.verify({ intent, user, code });

    if (result.status === "verified") {
      await this.markVerified(intent);
      await fireMfaEvent(
        new Verified(intent.user_id, driverName, intent.id, intent.purpose),
        this.app,
      );

      return result;
    }

    // Only a genuinely wrong code counts against the limit. An expired
    // challenge or a missing one is not a guess, and counting it would
    // let a slow user lock themselves out.
    if (result.status === "invalid-code") {
      await this.countFailure(intent);
      await this.fireFailure(intent, driverName);
    }

    return result;
  }

  /**
   * Dispatch the failure pair, after `countFailure()` has written.
   *
   * Two events out of one write. `countFailure()` fuses the attempt
   * increment and the possible lock into a single `UPDATE`, so the lock has
   * to be recovered by reading the status it left behind rather than by
   * being told. Splitting them is worth it: a listener alerting on lockouts
   * would otherwise have to subscribe to every failure and learn
   * `maxAttempts` to interpret the counter.
   *
   * `remaining` is derived here rather than on the event so a listener can
   * warn on the last attempt without reading config, and is floored at 0
   * because `maxAttempts` can be lowered while an intent is live.
   */
  private async fireFailure(intent: MfaIntent, driverName: string): Promise<void> {
    const remaining = Math.max(0, this.maxAttempts - intent.attempts);

    await fireMfaEvent(
      new VerificationFailed(intent.user_id, driverName, intent.id, intent.attempts, remaining),
      this.app,
    );

    if (intent.status === "locked") {
      await fireMfaEvent(
        new IntentLocked(intent.user_id, driverName, intent.id, intent.attempts),
        this.app,
      );
    }
  }

  /** Stamp the verification and open the sudo window. */
  private async markVerified(intent: MfaIntent): Promise<void> {
    const now = DateTime.now();
    const status: MfaIntentStatus = "verified";

    // The sudo window starts NOW, not at intent creation: a user who
    // took nine minutes to find their phone should still get the full
    // window, and one who verified instantly should not get extra.
    await MfaIntent.update(intent.id, {
      status,
      verified_at: now,
      verification_expires_at: now.addMinutes(this.verificationExpiresInMinutes),
    });

    intent.status = status;
    intent.verified_at = now;
    intent.verification_expires_at = now.addMinutes(this.verificationExpiresInMinutes);
  }

  /** Record a wrong guess, locking the intent once the limit is reached. */
  private async countFailure(intent: MfaIntent): Promise<void> {
    const attempts = intent.attempts + 1;
    const status: MfaIntentStatus = attempts >= this.maxAttempts ? "locked" : intent.status;

    await MfaIntent.update(intent.id, { attempts, status });

    intent.attempts = attempts;
    intent.status = status;
  }

  /**
   * Whether this user holds a live verified intent satisfying
   * `purpose`.
   *
   * THE MATCHING RULE, and the one piece of behaviour most worth
   * reading twice:
   *
   * - A generic requirement (`purpose === null`) is satisfied by ANY
   *   live verified intent, whatever purpose it carries.
   * - A named requirement is satisfied ONLY by an intent carrying that
   *   exact purpose.
   *
   * The asymmetry is deliberate. Specific rolling up to generic is
   * safe: the user proved a factor more recently and more deliberately
   * than a bare check asks for, so re-prompting is friction with no
   * security gain. Generic rolling down to specific is not safe: that
   * is exactly the case `requireMfa("billing.payout")` exists to
   * prevent, where a routine step-up at login silently authorizes a
   * payout an hour later.
   */
  async hasVerified(
    userId: string,
    purpose: string | null,
    binding: string | null,
  ): Promise<boolean> {
    const query = MfaIntent.query()
      .where("user_id", "=", userId)
      .where("status", "=", "verified")
      .where("verification_expires_at", ">", DateTime.now());

    if (purpose !== null) {
      query.where("purpose", "=", purpose);
    }

    // Binding is only enforced when this request HAS one. A request
    // whose guard exposes no identifier must not be blocked by intents
    // that recorded one, or enabling binding would break every
    // non-session guard.
    if (this.bindToSession && binding !== null) {
      query.where("binding", "=", binding);
    }

    return (await query.first()) !== undefined;
  }

  /**
   * Delete spent intents and challenges. Driven by `mfa:gc`.
   *
   * Expiry is enforced on read everywhere, so a stale row is never
   * honoured; this only stops the tables growing without bound.
   */
  async gc(): Promise<number> {
    const now = DateTime.now();

    // Intents that can never be used again: past their verification
    // window if they have one, past their intent deadline if they do
    // not. A verified intent is NOT deleted merely for being past
    // `intent_expires_at`, since that deadline only governs the
    // challenge.
    const intents = await MfaIntent.query()
      .where("intent_expires_at", "<=", now)
      .whereNull("verified_at")
      .delete();

    const verified = await MfaIntent.query().where("verification_expires_at", "<=", now).delete();

    return intents + verified;
  }

  private auth(): AuthLike {
    return this.app.make<AuthLike>(AUTH_TOKEN);
  }
}
