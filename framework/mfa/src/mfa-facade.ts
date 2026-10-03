import { Facade } from "@mahiframework/facades";
import type { Request } from "@mahiframework/http";
import type { ChallengeResult, MfaDriver, VerifyResult } from "./mfa-driver.js";
import type { CreateIntentOptions, MfaManager } from "./mfa-manager.js";
import type { MfaIntent } from "./models/mfa-intent.js";
import { MFA_TOKEN } from "./tokens.js";
import { mfaVerified, requireMfa, type RequireMfaOptions } from "./require-mfa.js";

/**
 * Static access to the `MfaManager`.
 *
 * Hand-written statics, no dynamic forwarding, per the `Facade` mixin's
 * contract: renaming a method on `MfaManager` is a compile error here
 * rather than a runtime surprise.
 *
 * `requireVerification()`/`verified()` are aliases of the `requireMfa()`
 * and `mfaVerified()` free functions. Both surfaces exist because the
 * repo has both precedents — `Gate`/`authorize()` — and the free
 * functions read better inline while the facade groups the whole API in
 * one discoverable place. They are the same code; neither is the "real"
 * one.
 */
export class Mfa extends Facade<MfaManager>(() => MFA_TOKEN) {
  /**
   * Require a live verified intent, or throw.
   *
   * ⚠️ MUST BE AWAITED. A floating call continues past the check
   * silently; see `requireMfa()`.
   */
  static requireVerification(purpose?: string | null, options?: RequireMfaOptions): Promise<void> {
    return requireMfa(purpose, options);
  }

  /** Whether a live verified intent satisfies `purpose`. */
  static verified(purpose?: string | null, options?: RequireMfaOptions): Promise<boolean> {
    return mfaVerified(purpose, options);
  }

  /** Driver names this user can verify with right now, in config order. */
  static available(userId: string): Promise<string[]> {
    return this.instance().available(userId);
  }

  /** Driver names the app has made available at all. */
  static drivers(): string[] {
    return this.instance().configuredDrivers();
  }

  /** Resolve a configured driver by name. */
  static use(name: string): MfaDriver {
    return this.instance().use(name);
  }

  /** Start (or reuse) a step-up attempt. */
  static createIntent(options: CreateIntentOptions): Promise<MfaIntent> {
    return this.instance().createIntent(options);
  }

  static findIntent(intentId: string): Promise<MfaIntent | undefined> {
    return this.instance().findIntent(intentId);
  }

  /** Ask a driver to begin verification. Returns the credential, if it minted one. */
  static challenge(intent: MfaIntent, driver: string): Promise<ChallengeResult> {
    return this.instance().challenge(intent, driver);
  }

  /** Verify a submitted code against an intent. */
  static verify(intent: MfaIntent, code: string): Promise<VerifyResult> {
    return this.instance().verify(intent, code);
  }

  /** The session or token id a verification would bind to. */
  static binding(request: Request): string | null {
    return this.instance().bindingFor(request);
  }
}
