import { DriverNotRegisteredError, Manager, type Application } from "@mahiframework/core";
import type { Hasher } from "@mahiframework/encryption";
import type { Request } from "@mahiframework/http";
import { isStatefulGuard, type Guard, type StatefulGuard } from "./guard.js";
import type { Credentials, UserProvider } from "./user-provider.js";
import {
  PasswordBroker,
  type PasswordBrokerConfig,
  type RevocationReason,
} from "./passwords/password-broker.js";
import {
  EmailVerificationBroker,
  type EmailVerificationConfig,
} from "./verification/email-verification-broker.js";
import {
  actingAs as contextActingAs,
  check as contextCheck,
  currentGuard,
  requireAuthState,
  runWithAuth,
  setActingAs,
  user as contextUser,
  userOrNull as contextUserOrNull,
} from "./auth-context.js";
import { userKey } from "./user-key.js";
import { Attempted } from "./events/attempted.js";
import { Authenticated } from "./events/authenticated.js";
import { Failed } from "./events/failed.js";
import { fireAuthEvent, safeCredentials } from "./events/fire-auth-event.js";

export interface AuthConfig {
  default: string;
  guards: Record<string, unknown>;
  providers: Record<string, unknown>;
  /** Optional password-reset settings. See `PasswordBrokerConfig`. */
  passwords?: PasswordBrokerConfig & { provider?: string };
  /**
   * Optional email-verification settings. See `EmailVerificationConfig`.
   * `model` is the app's User model, which the broker needs in order to
   * stamp the verified-at column (a `UserProvider` can read users but not
   * update arbitrary columns).
   */
  verification?: EmailVerificationConfig & { provider?: string; model?: unknown };
  /**
   * Switches for the auth emails the scaffolded app sends.
   *
   * **The framework does not read these.** `@mahiframework/auth` sends no mail and
   * has no `@mahiframework/mail` dependency, the mailables and the controllers
   * that send them are scaffolded into your app, where you can edit them
   * freely. These flags are declared here so the decision has one obvious
   * home and is typed, and the generated controllers check them:
   *
   *   if (authConfig.notifications?.resetPassword !== false) {
   *     await Mail.send(new ResetPasswordMail(email, url));
   *   }
   *
   * Turn one off to take delivery over yourself, send from a listener,
   * over SMS, through a third-party ESP's API, without deleting the
   * scaffolded controller. Both default to on when unset.
   */
  notifications?: {
    /** Send the password-reset email from the forgot-password endpoint. */
    resetPassword?: boolean;
    /** Send the verification email on registration and from the resend endpoint. */
    verifyEmail?: boolean;
  };
}

export type UserProviderFactory = (app: Application, config: unknown) => UserProvider;

export class UserProviderNotRegisteredError extends Error {
  constructor(name: string) {
    super(`User provider driver "${name}" is not registered on AuthManager.`);
    this.name = "UserProviderNotRegisteredError";
  }
}

/**
 * Extends `DriverNotRegisteredError` rather than `Error` so anything
 * already catching the base class, the framework's own tests, and any
 * app code, keeps working even though `guard()` does not go through
 * `Manager.driver()`. It only adds the guard NAME to the message, which
 * the base can't know: with named guards, "driver `session` isn't
 * registered" and "guard `web` wanted driver `session`" are different
 * diagnoses.
 */
export class GuardNotRegisteredError extends DriverNotRegisteredError {
  constructor(driver: string, name: string) {
    super("AuthManager", driver);
    this.message =
      `Guard driver "${driver}" (required by guard "${name}") is not registered on AuthManager. ` +
      `Built-in drivers are "session" and "token"; register others with Auth's extend().`;
    this.name = "GuardNotRegisteredError";
  }
}

export class UnknownUserProviderError extends Error {
  constructor(name: string) {
    super(`No user provider named "${name}" is configured in config/auth.ts's providers.`);
    this.name = "UnknownUserProviderError";
  }
}

export class NotStatefulGuardError extends Error {
  constructor(name: string) {
    super(
      `Guard "${name}" cannot log a user in: it has no login()/logout(). ` +
        `Only stateful guards (the built-in "session" guard) can. ` +
        `Bearer tokens are issued with TokenGuard.createToken() instead.`,
    );
    this.name = "NotStatefulGuardError";
  }
}

/**
 * Resolves guards (how a request is authenticated) and user providers
 * (where users come from), and exposes the derived helpers every guard
 * would otherwise reimplement.
 *
 * TWO DRIVER AXES: `Manager<T>` models one, and auth genuinely has two
 * orthogonal ones, guards × user providers (Laravel has the same pair).
 * Guards go through the inherited `extend()`/`driver()`; user providers
 * get a small parallel registry below. That's deliberate: widening
 * `Manager<T>` to support two axes would complicate every other manager
 * in the framework for one caller's benefit.
 *
 * The `user()`/`check()`/`id()` helpers read the AsyncLocalStorage scope
 * (`auth-context.ts`) rather than asking a guard, so they're defined once
 * here instead of per-guard, and so they cost nothing after the first
 * resolution in a request.
 */
export class AuthManager extends Manager<Guard> {
  private providerCreators = new Map<string, UserProviderFactory>();
  private resolvedProviders = new Map<string, UserProvider>();
  private resolvedBroker: PasswordBroker | null = null;
  private resolvedVerificationBroker: EmailVerificationBroker | null = null;

  /** Guard factories, keyed by DRIVER (`"session"`, `"token"`). */
  private guardCreators = new Map<string, (app: Application) => Guard>();
  /** Resolved guards, keyed by CONFIG NAME (`"web"`, `"api"`). See `guard()`. */
  private resolvedGuards = new Map<string, Guard>();
  /**
   * The config name currently being resolved, so `guardConfig()` called
   * with no argument from inside a factory reads that guard's config
   * rather than the default guard's. Without it, resolving `guard("api")`
   * would hand the api guard the web guard's cookie settings.
   */
  private resolvingGuard: string | undefined;

  constructor(
    app: Application,
    private readonly config: AuthConfig,
    private readonly hasher: Hasher,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /**
   * Resolve a guard by its CONFIG NAME (`"web"`, `"api"`), not by its
   * driver.
   *
   * This is the one place `AuthManager` cannot use `Manager.driver()`
   * unchanged, and the divergence is deliberate. Every other manager's
   * config names and driver names coincide; auth's do not. Laravel's
   * canonical config is
   *
   *   guards: { web: { driver: "session" }, api: { driver: "token" } }
   *
   * two *names* over two *drivers*, and nothing stops both names using
   * the same driver with different cookies or lifetimes. Keying the
   * resolved-guard cache by driver (as the base class does) made that
   * shape fail outright: `guard("web")` looked for a driver called
   * `"web"` and threw, while two session guards were impossible to
   * express at all.
   *
   * So: the factory is looked up by driver, the instance is cached by
   * name, and `guardConfig(name)` reaches the factory through
   * `resolvingGuard` so it configures the guard it was actually asked
   * for.
   */
  guard<TUser = unknown>(name?: string): Guard<TUser> {
    const key = name ?? this.getDefaultDriver();

    const cached = this.resolvedGuards.get(key);

    if (cached !== undefined) {
      return cached as Guard<TUser>;
    }

    const driver = this.guardDriver(key);
    const create = this.guardCreators.get(driver);

    if (create === undefined) {
      throw new GuardNotRegisteredError(driver, key);
    }

    const previous = this.resolvingGuard;
    this.resolvingGuard = key;
    try {
      const guard = create(this.app);
      this.resolvedGuards.set(key, guard);

      return guard as Guard<TUser>;
    } finally {
      this.resolvingGuard = previous;
    }
  }

  /**
   * Register a guard driver. Overrides `Manager.extend()` so guard
   * factories land in the by-driver registry `guard()` reads, rather than
   * the by-name one the base class keeps.
   */
  override extend(driver: string, factory: (app: Application) => Guard): this {
    this.guardCreators.set(driver, factory);

    return this;
  }

  /**
   * Guards resolve by config name. See `guard()`. `driver()` is kept
   * pointing at the same resolution so any caller reaching for the
   * generic `Manager` API gets the same instance rather than a second,
   * differently-configured one.
   */
  override driver(name?: string): Guard {
    return this.guard(name);
  }

  /**
   * A configured guard's settings block. Defaults to the guard currently
   * being resolved (see `resolvingGuard`), then to the default guard,
   * so a factory can call `guardConfig()` bare and get the right one.
   */
  guardConfig(name?: string): Record<string, unknown> {
    const key = name ?? this.resolvingGuard ?? this.getDefaultDriver();

    return (this.config.guards[key] ?? {}) as Record<string, unknown>;
  }

  /**
   * The config name of the guard currently being constructed, for a
   * factory that needs to tell its guard what it is called (so
   * `Auth.currentGuard()` can report it). Only meaningful inside a guard
   * factory; the default guard's name outside one.
   */
  resolvingGuardName(): string {
    return this.resolvingGuard ?? this.getDefaultDriver();
  }

  /**
   * The DRIVER a configured guard uses, e.g. `{ web: { driver: "session" } }`
   * → `"session"`.
   *
   * Guards are configured by NAME and resolved by driver, and the two are
   * only incidentally the same string. Falling back to the name is what
   * keeps the framework's own `{ session: { ... } }` shorthand working,
   * where the name *is* the driver.
   */
  guardDriver(name?: string): string {
    const key = name ?? this.getDefaultDriver();
    const driver = this.guardConfig(key)["driver"];

    return typeof driver === "string" ? driver : key;
  }

  /**
   * Resolve a guard that can establish sessions, throwing a useful error
   * rather than a `TypeError` deep inside a handler if the configured
   * guard can't.
   *
   * This is the supported replacement for
   * `Auth.guard("session") as unknown as SessionGuard`, a cast that
   * compiles happily even when the guard has no `login()` at all.
   */
  statefulGuard<TUser = unknown>(name?: string): StatefulGuard<TUser> {
    const resolved = this.guard<TUser>(name);

    if (!isStatefulGuard(resolved)) {
      throw new NotStatefulGuardError(name ?? this.getDefaultDriver());
    }

    return resolved;
  }

  /**
   * Log a user in through a stateful guard, returning the session id.
   * Queues the session cookie on `request`; the HTTP boundary writes it.
   */
  async login(
    request: Request,
    userId: string,
    options: { remember?: boolean; guard?: string } = {},
  ): Promise<string> {
    return this.statefulGuard(options.guard).login(request, userId, {
      remember: options.remember ?? false,
    });
  }

  /**
   * Verify credentials AND establish a session in one step, Laravel's
   * `Auth::attempt()` semantics, as opposed to this framework's
   * `attempt()`, which deliberately only verifies.
   *
   * Returns the user on success and null on failure, having logged
   * nobody in on failure.
   */
  async attemptLogin<TUser = unknown>(
    request: Request,
    credentials: Credentials,
    options: { remember?: boolean; guard?: string } = {},
  ): Promise<TUser | null> {
    const guardName = options.guard ?? this.getDefaultDriver();
    const provider = this.guardConfig(guardName)["provider"] as string | undefined;

    const user = await this.attempt<Record<string, unknown>>(credentials, provider);

    if (user === null) {
      return null;
    }

    await this.login(request, String(user["id"]), options);

    return user as TUser;
  }

  /** End the current session through a stateful guard. */
  async logout(request: Request, guardName?: string): Promise<void> {
    await this.statefulGuard(guardName).logout(request);
  }

  extendUserProvider(driver: string, factory: UserProviderFactory): this {
    this.providerCreators.set(driver, factory);

    return this;
  }

  /**
   * Resolve a configured user provider by its config key (e.g. `"users"`),
   * NOT by its driver name, matching how `config/auth.ts` names them.
   */
  userProvider(name?: string): UserProvider {
    const key = name ?? (this.guardConfig().provider as string | undefined) ?? "users";

    const cached = this.resolvedProviders.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const providerConfig = this.config.providers[key] as { driver?: string } | undefined;

    if (providerConfig === undefined) {
      throw new UnknownUserProviderError(key);
    }

    const driver = providerConfig.driver ?? "database";
    const create = this.providerCreators.get(driver);

    if (create === undefined) {
      throw new UserProviderNotRegisteredError(driver);
    }

    const provider = create(this.app, providerConfig);
    this.resolvedProviders.set(key, provider);

    return provider;
  }

  /**
   * The single `PasswordBroker`, cached after first resolution.
   *
   * One broker over one `UserProvider`, deliberately narrower than
   * Laravel's multi-broker `PasswordBrokerManager`, since this framework
   * has no multi-user-table goal. The provider defaults to the same one
   * the default guard uses unless `auth.passwords.provider` overrides it.
   */
  passwordBroker(): PasswordBroker {
    if (this.resolvedBroker !== null) {
      return this.resolvedBroker;
    }

    const settings = this.config.passwords ?? {};
    const provider = this.userProvider(settings.provider) as UserProvider<Record<string, unknown>>;
    const broker = new PasswordBroker(provider, this.hasher, settings);

    // Wire the stores a successful reset must revoke in. Resolved lazily
    // through the guards, and only where they exist: an app configuring
    // no session guard simply has no sessions to revoke.
    //
    // Without this, resetting a password left every existing session and
    // API token alive, so account recovery did not actually recover the
    // account from whoever was already in it.
    broker.revokesWith({
      sessions: this.credentialRevoker("logoutEverywhere", "destroyForUser"),
      tokens: this.credentialRevoker("revokeAllTokens", "revokeAllTokens"),
    });

    this.resolvedBroker = broker;

    return broker;
  }

  /**
   * The single `EmailVerificationBroker`, cached after first resolution.
   *
   * Requires `auth.verification.model`, the app's User model. Unlike the
   * password broker, which only ever reads users and delegates the write
   * to `UserProvider.updatePassword()`, this one has to stamp an arbitrary
   * column, and `UserProvider` has no method for that. Adding one would
   * widen the interface for a single caller, so the model is configured
   * instead, mirroring how `DatabaseUserProvider` already takes one.
   */
  verificationBroker(): EmailVerificationBroker {
    if (this.resolvedVerificationBroker !== null) {
      return this.resolvedVerificationBroker;
    }

    const settings = this.config.verification ?? {};
    const model = settings.model;

    if (model === undefined) {
      throw new Error(
        "Email verification requires `verification.model` (your User model) in config/auth.ts.",
      );
    }

    const provider = this.userProvider(settings.provider) as UserProvider<Record<string, unknown>>;
    const broker = new EmailVerificationBroker(
      provider,
      model as ConstructorParameters<typeof EmailVerificationBroker>[1],
      settings,
    );

    this.resolvedVerificationBroker = broker;

    return broker;
  }

  /**
   * Every configured guard that can garbage-collect its own expired
   * records, as `[name, guard]` pairs. Drives `auth:gc`.
   *
   * Discovered by CAPABILITY rather than by name: an app following
   * Laravel's convention names its guards `web`/`api`, so the old
   * hardcoded `guard("session")` lookup found nothing and swept nothing,
   * silently, while the tables grew.
   */
  collectableGuards(): Array<[string, { gc(): Promise<number> }]> {
    const collectable: Array<[string, { gc(): Promise<number> }]> = [];

    for (const name of Object.keys(this.config.guards)) {
      let guard: Guard;
      try {
        guard = this.guard(name);
      } catch {
        continue; // a guard whose driver isn't registered isn't usable
      }

      const candidate = guard as unknown as { gc?: unknown };

      if (typeof candidate.gc === "function") {
        collectable.push([name, guard as unknown as { gc(): Promise<number> }]);
      }
    }

    return collectable;
  }

  /**
   * Find a configured guard exposing `method`, adapted to the name the
   * broker expects.
   *
   * Searches every configured guard rather than assuming names, because
   * guards are named by the app (`web`, `api`) and the broker only cares
   * that *something* can revoke. Returns undefined when nothing can, in
   * which case that half of the revocation is a no-op.
   *
   * The adapter forwards the broker's `reason` through to the guard, so
   * the `CurrentDeviceLogout`/`TokenRevoked` events a password reset
   * triggers are distinguishable from a user-requested mass logout. A
   * guard method that takes only a user id ignores the extra argument,
   * which is why this stays a positional pass-through rather than a
   * capability probe.
   */
  private credentialRevoker<T extends string>(
    method: string,
    as: T,
  ): Record<T, (userId: string, reason?: RevocationReason) => Promise<void>> | undefined {
    for (const name of Object.keys(this.config.guards)) {
      let guard: Guard;
      try {
        guard = this.guard(name);
      } catch {
        continue; // a guard whose driver isn't registered isn't usable
      }

      const candidate = (guard as unknown as Record<string, unknown>)[method];

      if (typeof candidate === "function") {
        return {
          [as]: (userId: string, reason?: RevocationReason) =>
            (candidate as (id: string, reason?: RevocationReason) => Promise<void>).call(
              guard,
              userId,
              reason,
            ),
        } as Record<T, (userId: string, reason?: RevocationReason) => Promise<void>>;
      }
    }

    return undefined;
  }

  /**
   * Authenticate the request with the named guard and write the result
   * into the ambient auth scope. Called by the `authenticate()`
   * middleware; returns the user (or null) so the middleware can decide
   * whether to 401.
   *
   * Mutates the state opened by `AuthServiceProvider`'s global pipe
   * rather than nesting a new scope, so one request has exactly one
   * identity for its whole lifetime.
   *
   * An acting-as override (see `actingAs()`) short-circuits the guard: the
   * request authenticates as the overridden user without touching the
   * network/session, which is what `TestClient.actingAs()` relies on.
   *
   * Dispatches `Authenticated` when a user was resolved, which is once per
   * authenticated REQUEST rather than once per login. An anonymous
   * request dispatches nothing: see that event's docstring, and note it is
   * a hot path.
   */
  async resolve(request: Request, guardName?: string): Promise<unknown | null> {
    const override = contextActingAs();

    if (override !== null) {
      const state = requireAuthState();
      const name = override.guard ?? guardName ?? this.getDefaultDriver();
      state.user = override.user;
      state.guard = name;

      await this.fireAuthenticated(override.user, name, true);

      return override.user;
    }

    const name = guardName ?? this.getDefaultDriver();
    const user = await this.guard(name).user(request);

    const state = requireAuthState();
    state.user = user;
    state.guard = user === null ? null : name;

    if (user !== null) {
      await this.fireAuthenticated(user, name, false);
    }

    return user;
  }

  /**
   * Dispatch `Authenticated` for a resolved user.
   *
   * The id is read off the user object rather than taken as a parameter
   * because neither `resolve()` path has one in hand: a guard returns the
   * user, not its key, and an acting-as override carries only the object.
   * `String(user.id)` is the same assumption `id()` already makes, and a
   * user object without a readable `id` yields `null`, which a listener
   * must tolerate rather than the resolution failing over telemetry.
   */
  private async fireAuthenticated(
    user: unknown,
    guard: string,
    viaActingAs: boolean,
  ): Promise<void> {
    const id = userKey(user);

    if (id === null) {
      return;
    }

    await fireAuthEvent(new Authenticated(id, user, guard, viaActingAs), this.app);
  }

  user<TUser = unknown>(): TUser {
    return contextUser<TUser>();
  }

  userOrNull<TUser = unknown>(): TUser | null {
    return contextUserOrNull<TUser>();
  }

  check(): boolean {
    return contextCheck();
  }

  currentGuard(): string | null {
    return currentGuard();
  }

  /**
   * The authenticated user's primary key. Assumes an `id` property, which
   * is the convention every `Model` in this framework already follows
   * (`Model.primaryKeyColumn` defaults to `"id"`).
   */
  id(): string {
    const user = contextUser<Record<string, unknown>>();

    return String(user["id"]);
  }

  /**
   * Run `fn` with an explicit user, for queue jobs, CLI commands, and
   * tests, which have no HTTP request and therefore no ambient scope.
   */
  async runAs<T>(user: unknown, fn: () => T | Promise<T>): Promise<T> {
    return runWithAuth({ user, guard: null }, async () => fn());
  }

  /**
   * Force a user to be "the authenticated user" for every subsequent
   * request resolved through the given guard (default guard if omitted),
   * Laravel's `actingAs()`.
   *
   * Unlike `runAs()` (which wraps a single synchronous scope), this swaps
   * the resolved guard so `authenticate()` → `resolve()` returns `user`
   * for real requests driven through the HTTP kernel, the mechanism
   * `@mahiframework/testing`'s `TestClient.actingAs()` uses. Pass `null` to clear.
   */
  actingAs(user: unknown, guardName?: string): void {
    setActingAs(user, user === null ? null : (guardName ?? this.getDefaultDriver()));
  }

  /**
   * Verify credentials without touching the request. Returns the user on
   * success, null on failure. It does NOT log anyone in; the caller
   * decides what to issue (a token, a session).
   *
   * Dispatches `Attempted` for both outcomes and, additionally, `Failed`
   * for a failure. Both are dispatched AFTER the constant-work hash on
   * the miss path, so the timing-equalisation this method exists to
   * provide is unaffected by whether a listener is registered.
   *
   * Note that the events cannot distinguish "no such account" from "wrong
   * password", because this method deliberately does not either. See
   * `Attempted`.
   */
  async attempt<TUser = unknown>(
    credentials: Credentials,
    providerName?: string,
  ): Promise<TUser | null> {
    const users = this.userProvider(providerName);
    const user = await users.retrieveByCredentials(credentials);

    if (user === null) {
      await this.hasher.make(credentials["password"] ?? "");
      await this.fireAttempt(credentials, false);

      return null;
    }

    const valid = await users.validateCredentials(user, credentials);

    await this.fireAttempt(credentials, valid, valid ? user : null);

    return valid ? (user as TUser) : null;
  }

  /**
   * Dispatch the attempt pair: `Attempted` always, `Failed` additionally
   * on failure.
   *
   * Two events for one outcome is redundant by design. `Attempted` is for
   * a listener that wants every attempt (a rate limiter, an audit log);
   * `Failed` is for one that wants only failures (alerting, lockout) and
   * would otherwise have to register on `Attempted` and branch. Laravel
   * ships the same pair for the same reason.
   */
  private async fireAttempt(
    credentials: Credentials,
    succeeded: boolean,
    user: unknown | null = null,
  ): Promise<void> {
    const safe = safeCredentials(credentials);
    const guard = this.getDefaultDriver();

    await fireAuthEvent(new Attempted(safe, succeeded, user, guard), this.app);

    if (!succeeded) {
      await fireAuthEvent(new Failed(safe, guard), this.app);
    }
  }
}
