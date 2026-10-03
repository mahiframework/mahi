import { Facade } from "@mahiframework/facades";
import type { Request } from "@mahiframework/http";
import type {
  ImpersonationGate,
  ImpersonationHook,
  ImpersonationManager,
  StartImpersonationOptions,
} from "./impersonation-manager.js";
import type { ImpersonationRecord } from "./models/impersonation-link.js";
import { IMPERSONATION_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `ImpersonationManager` singleton bound at
 * `IMPERSONATION_TOKEN`.
 *
 * The class is `ImpersonationManager` and the facade is `Impersonation`,
 * the name written at call sites, mirroring `Gate`/`GateRegistry` and
 * `Auth`/`AuthManager`.
 *
 *   // in a provider's boot()
 *   Impersonation.authorize<User>((admin, user) =>
 *     admin.isSuperadmin() && !user.isSuperadmin());
 *
 *   // in a route
 *   await Impersonation.start(request, user);
 *   await Impersonation.stop(request);
 */
export class Impersonation extends Facade<ImpersonationManager>(() => IMPERSONATION_TOKEN) {
  /**
   * Define who may impersonate whom. Replaces any previous gate; the
   * default is deny-all. Call once, from a provider's `boot()`.
   */
  static authorize<TUser = unknown>(gate: ImpersonationGate<TUser>): ImpersonationManager {
    return this.instance().authorize(gate);
  }

  /** Add a veto run after the gate allows. Throw to deny. */
  static before<TUser = unknown>(hook: ImpersonationHook<TUser>): ImpersonationManager {
    return this.instance().before(hook);
  }

  /**
   * Whether `admin` may impersonate `user`. Runs no `before()` hooks, so
   * it is safe for rendering a disabled button, and is not a guarantee
   * that `start()` will succeed.
   */
  static canImpersonate<TUser extends object = Record<string, unknown>>(
    admin: TUser,
    user: TUser,
  ): Promise<boolean> {
    return this.instance().canImpersonate(admin, user);
  }

  /** The full check, including `before()` hooks. Throws on refusal. */
  static assertCanImpersonate<TUser extends object = Record<string, unknown>>(
    admin: TUser,
    user: TUser,
    request?: Request,
  ): Promise<void> {
    return this.instance().assertCanImpersonate(admin, user, request);
  }

  static start<TUser extends object = Record<string, unknown>>(
    request: Request,
    user: TUser,
    options?: StartImpersonationOptions,
  ): Promise<ImpersonationRecord> {
    return this.instance().start(request, user, options);
  }

  static stop(request: Request): Promise<ImpersonationRecord | null> {
    return this.instance().stop(request);
  }

  static current(request: Request): Promise<ImpersonationRecord | null> {
    return this.instance().current(request);
  }

  static isImpersonating(request: Request): Promise<boolean> {
    return this.instance().isImpersonating(request);
  }

  static impersonator<TUser = unknown>(request: Request): Promise<TUser | null> {
    return this.instance().impersonator<TUser>(request);
  }

  static rootImpersonator<TUser = unknown>(request: Request): Promise<TUser | null> {
    return this.instance().rootImpersonator<TUser>(request);
  }

  static chain(request: Request): Promise<ImpersonationRecord[]> {
    return this.instance().chain(request);
  }
}
