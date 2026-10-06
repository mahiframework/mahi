import type { DriverFactory } from "@mahiframework/core";
import { Facade } from "@mahiframework/facades";
import type { AvailableProvider, SocialiteDriver } from "./socialite-driver.js";
import type { SocialiteManager } from "./socialite-manager.js";
import { SOCIALITE_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `SocialiteManager` singleton bound at
 * `SOCIALITE_TOKEN`.
 *
 *   const url = await Socialite.driver("github").redirect(request);
 *   return HttpResponse.redirect(url);
 *
 *   const user = await Socialite.driver("github").user(request);
 *
 * Deliberately **does not** forward driver methods to a default driver.
 * `Storage.put()` and `Cache.get()` do that because those managers have
 * a default; Socialite has none, so a `Socialite.redirect()` could only
 * throw. Laravel's facade advertises `scopes()` and `redirectUrl()` in
 * its docblock that nobody can call for exactly this reason.
 */
export class Socialite extends Facade<SocialiteManager>(() => SOCIALITE_TOKEN) {
  /**
   * The driver configured under `name`.
   *
   * `name` is required, not optional: mirroring Laravel's
   * `driver(?string)` would move a compile-time error to runtime.
   */
  static driver(name: string): SocialiteDriver {
    return this.instance().driver(name);
  }

  /**
   * Register a driver, or replace one.
   *
   * The seam a third-party driver package registers through, and the one
   * an app uses to point a provider at its own subclass.
   */
  static extend(name: string, factory: DriverFactory<SocialiteDriver>): SocialiteManager {
    return this.instance().extend(name, factory);
  }

  /**
   * Configured, registered providers with their labels — what a
   * "sign in with…" list needs. Resolves no drivers.
   */
  static available(): readonly AvailableProvider[] {
    return this.instance().available();
  }

  /** Whether a driver is registered under `name`. */
  static registered(name: string): boolean {
    return this.instance().registered(name);
  }

  /** Every configured provider name, registered or not. */
  static configured(): string[] {
    return this.instance().configured();
  }
}
