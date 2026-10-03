import { randomUUID } from "node:crypto";
import { EVENTS_TOKEN, type Application } from "@mahiframework/core";
import { AUTH_TOKEN, type AuthManager, type SessionGuardConfig } from "@mahiframework/auth";
import { DateTime } from "@mahiframework/datetime";
import type { Request } from "@mahiframework/http";
import { ImpersonationLink, type ImpersonationRecord } from "./models/impersonation-link.js";
import type { ImpersonationConfig } from "./impersonation-config.js";
import { ImpersonationDeniedError, ImpersonatorMissingError } from "./errors.js";
import { ImpersonationFinished, ImpersonationStarted } from "./impersonation-events.js";

/**
 * Who may impersonate whom.
 *
 * Both users are non-nullable: a guest has no identity to impersonate
 * *as*, so unlike a `Gate` ability there is no `null` arm for a callback
 * to handle. The manager rejects an unauthenticated attempt before the
 * callback is reached.
 *
 * The rest parameters are absent on purpose. A gate here answers exactly
 * one question about exactly two users; anything else it needs (a
 * request, a tenant) it can close over or read from the ambient context.
 */
export type ImpersonationGate<TUser = unknown> = (
  admin: TUser,
  user: TUser,
) => boolean | Promise<boolean>;

/**
 * A veto, run after the gate has already allowed an impersonation.
 *
 * Deny by THROWING; returning nothing allows. It cannot grant, which is
 * what makes it safe to bolt arbitrary requirements on without reviewing
 * the gate: a hook can only ever narrow.
 *
 * Throwing (rather than returning false) is what lets an existing guard
 * drop straight in with no adapter:
 *
 *   Impersonation.before(() => Mfa.requireVerification("auth"));
 *
 * A `false` return is also honoured, because TypeScript's void-
 * assignability rule accepts a boolean-returning arrow where `void` is
 * declared. `before((a, u) => a.id !== u.id)` therefore compiles, and
 * silently allowing it would be a security bug rather than a surprise.
 */
export type ImpersonationHook<TUser = unknown> = (
  admin: TUser,
  user: TUser,
) => void | boolean | Promise<void | boolean>;

/** Options for a single `start()` call. */
export interface StartImpersonationOptions {
  /** Guard to log in through. Defaults to `impersonation.routes.guard`, then the auth default. */
  guard?: string;
}

/** The subset of `SessionGuard` this package needs. */
interface SessionCapableGuard {
  sessionId(request: Request): string | null;
  sessionLifetimeRemaining(request: Request): Promise<number | null>;
}

interface EventDispatcherLike {
  dispatch(event: object): Promise<void>;
}

/** Per-request cache key for the resolved current impersonation. */
const CURRENT_KEY = "impersonation.current";

/**
 * Impersonation: start acting as another user, then stop.
 *
 * The app decides who may do it, once, in a provider's `boot()`:
 *
 *   Impersonation.authorize<User>((admin, user) =>
 *     admin.isSuperadmin() && !user.isSuperadmin());
 *
 *   Impersonation.before(() => Mfa.requireVerification("auth"));
 *
 * Deliberately NOT a `Manager<T>` subclass despite the name. There are no
 * swappable drivers, and `GateRegistry` already set the precedent of
 * declining the manager shape rather than cargo-culting it. The name is
 * kept because the call sites read better and because a driver axis
 * (session versus token-based impersonation) is plausible later.
 *
 * SESSION GUARDS ONLY. Impersonation works by logging in as someone else,
 * and a `TokenGuard` has no `login()` by design: a bearer token is minted
 * out of band, so there is nothing to swap. `start()` throws
 * `NotStatefulGuardError` against one. `canImpersonate()` is guard-
 * agnostic, which is what lets a token-based app implement its own flow
 * on top of the same gate.
 *
 * STATELESS BY CONTRACT, like `Guard` and `Policy`: one `Application`
 * serves every concurrent request, so nothing per-request is memoized on
 * `this`. The current impersonation is cached on the `Request`, not here.
 */
export class ImpersonationManager {
  private gate: ImpersonationGate | null = null;
  private hooks: ImpersonationHook[] = [];

  constructor(
    private readonly app: Application,
    private readonly config: ImpersonationConfig = {},
  ) {}

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  /**
   * Define who may impersonate whom. Until this is called, NOBODY can:
   * the default is deny-all, so installing the package grants nothing.
   *
   * REPLACES any previously registered gate; last call wins. There is one
   * answer to "who may impersonate", and an appending registry would make
   * that answer depend on provider order, which is not a thing anyone
   * should have to reason about to know who can log in as whom. Register
   * it once, in one provider. Use `before()` to add further conditions.
   */
  authorize<TUser = unknown>(gate: ImpersonationGate<TUser>): this {
    this.gate = gate as ImpersonationGate;

    return this;
  }

  /**
   * Add a veto, run after the gate allows and before any session is
   * touched. All hooks run, in registration order, and any one of them
   * may throw to deny.
   *
   * The canonical use is bolting on a requirement the gate shouldn't know
   * about, step-up MFA being the obvious one:
   *
   *   Impersonation.before(() => Mfa.requireVerification("auth"));
   *
   * Hooks are side-effecting by design (that MFA call *prompts*), which
   * is exactly why `canImpersonate()` does not run them.
   */
  before<TUser = unknown>(hook: ImpersonationHook<TUser>): this {
    this.hooks.push(hook as ImpersonationHook);

    return this;
  }

  /** Whether an `authorize()` gate has been registered. */
  hasGate(): boolean {
    return this.gate !== null;
  }

  // ---------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------

  /**
   * Whether `admin` may impersonate `user`, per the self-check and the
   * app's gate.
   *
   * Safe to call for rendering: it runs NO `before()` hooks, so it never
   * prompts for MFA or writes an audit row. That makes it the right call
   * behind an "Impersonate" button's disabled state, and the wrong call
   * to guard the action itself.
   *
   * Consequently a `true` here is NOT a guarantee that `start()` will
   * succeed: a hook may still veto, and the chain-depth rules are only
   * checked by `assertCanImpersonate()`, which needs the request.
   */
  async canImpersonate<TUser extends object = Record<string, unknown>>(
    admin: TUser,
    user: TUser,
  ): Promise<boolean> {
    if (this.gate === null) {
      return false;
    }

    if (this.sameUser(admin, user)) {
      return false;
    }

    return this.gate(admin, user);
  }

  /**
   * The full check: self, gate, chain depth, loop detection, then every
   * `before()` hook. Throws `ImpersonationDeniedError` on refusal, or
   * whatever a hook threw.
   *
   * This is what `start()` runs, and what a hand-rolled route should run.
   * Pass `request` so the chain rules can be evaluated; omit it only when
   * there is no request (a CLI tool), in which case depth is unchecked
   * because there is no chain to be in.
   */
  async assertCanImpersonate<TUser extends object = Record<string, unknown>>(
    admin: TUser,
    user: TUser,
    request?: Request,
  ): Promise<void> {
    if (this.sameUser(admin, user)) {
      throw new ImpersonationDeniedError("self", "A user cannot impersonate themselves.");
    }

    if (this.gate === null) {
      throw new ImpersonationDeniedError(
        "not-authorized",
        "No impersonation gate is registered, so nobody may impersonate. Call " +
          "`Impersonation.authorize(...)` from a service provider's boot().",
      );
    }

    if (!(await this.gate(admin, user))) {
      throw new ImpersonationDeniedError(
        "not-authorized",
        "This user is not permitted to impersonate the requested user.",
      );
    }

    if (request !== undefined) {
      await this.assertChainAllows(request, user);
    }

    // Hooks last: they are side-effecting, so a request that was going to
    // be refused anyway must not have prompted for MFA first.
    for (const hook of this.hooks) {
      const result = await hook(admin, user);

      // `void` accepts a boolean-returning arrow under TypeScript's
      // assignability rules, so an app can write `before((a, u) => cond)`
      // and have it compile. Honour a literal `false` rather than
      // silently allowing it.
      if (result === false) {
        throw new ImpersonationDeniedError(
          "not-authorized",
          "An impersonation `before()` hook denied this impersonation.",
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Begin impersonating `user`, as the currently authenticated admin.
   *
   * Authorizes first, then logs in as `user` through the stateful guard
   * and records the link. The caller is authenticated as `user` for the
   * rest of this request, because `SessionGuard.login()` republishes the
   * ambient auth scope.
   *
   * Note what `login()` does to the admin's session: it is DESTROYED, not
   * suspended, which is its session-fixation defence. So the admin gets a
   * new session id here and another on `stop()`; their remember-me is
   * restored by `stop()` but its clock restarts. The impersonated user's
   * own sessions, on their own devices, are untouched.
   */
  async start<TUser extends object = Record<string, unknown>>(
    request: Request,
    user: TUser,
    options: StartImpersonationOptions = {},
  ): Promise<ImpersonationRecord> {
    const auth = this.auth();
    const admin = auth.user<TUser>();
    const guardName = options.guard ?? this.config.routes?.guard;

    await this.assertCanImpersonate(admin, user, request);

    const parent = await this.current(request);

    // Read the session BEFORE login() destroys it: its expiry is the only
    // evidence of whether it was a remembered one.
    const remembered = await this.wasRemembered(request, guardName);

    const sessionId = await auth.login(request, this.idOf(user), { guard: guardName });

    const now = DateTime.now();
    const record: ImpersonationRecord = {
      id: randomUUID(),
      session_id: sessionId,
      impersonator_id: this.idOf(admin),
      impersonated_id: this.idOf(user),
      parent_id: parent?.id ?? null,
      depth: (parent?.depth ?? 0) + 1,
      remembered,
      created_at: now,
      expires_at: await this.sessionExpiry(request, guardName, now),
    };

    await ImpersonationLink.create(record);
    request.share(CURRENT_KEY, record);

    await this.dispatch(new ImpersonationStarted(record, admin, user));

    return record;
  }

  /**
   * End the current impersonation, returning to whoever started it, and
   * return the record that was ended. `null` when not impersonating.
   *
   * Deliberately runs NO authorization. You are, at this moment, the
   * impersonated user; re-checking permission to leave is how an admin
   * gets trapped inside someone else's account after their own access is
   * revoked mid-session. Possession of the row is the authorization.
   *
   * At depth > 1 this unwinds exactly one link: the parent record takes
   * over the newly created session and stays live.
   */
  async stop(request: Request): Promise<ImpersonationRecord | null> {
    const record = await this.current(request);

    if (record === null) {
      return null;
    }

    const auth = this.auth();
    const guardName = this.config.routes?.guard;

    const impersonator = await this.findUser(record.impersonator_id, guardName);

    if (impersonator === null) {
      throw new ImpersonatorMissingError(record.impersonator_id);
    }

    const impersonated = auth.userOrNull();

    const sessionId = await auth.login(request, record.impersonator_id, {
      guard: guardName,
      // Restore the long-lived session the impersonation replaced. The
      // clock restarts rather than resuming; see the class docblock.
      remember: record.remembered,
    });

    const parent =
      record.parent_id === null ? null : await ImpersonationLink.find(record.parent_id);

    if (parent === undefined || parent === null) {
      request.share(CURRENT_KEY, null);
    } else {
      // The parent link now owns the live session. Rewriting rather than
      // inserting keeps `session_id` unique and the chain intact.
      await ImpersonationLink.update(parent.id, { session_id: sessionId });
      request.share(CURRENT_KEY, { ...parent, session_id: sessionId });
    }

    await ImpersonationLink.delete(record.id);

    await this.dispatch(new ImpersonationFinished(record, impersonator, impersonated));

    return record;
  }

  // ---------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------

  /**
   * The live impersonation for this request's session, or null.
   *
   * Cached on the `Request`, so a route, an event listener and a response
   * serializer asking the same question cost one query between them.
   *
   * There is deliberately no global middleware resolving this eagerly: it
   * would add a query to every request, including unauthenticated ones,
   * to answer a question almost none of them ask. An app that wants it on
   * every request (to stamp a log line, say) can add a one-line pipe.
   */
  async current(request: Request): Promise<ImpersonationRecord | null> {
    const cached = request.shared<ImpersonationRecord | null>(CURRENT_KEY);

    if (cached !== undefined) {
      return cached;
    }

    const sessionId = this.sessionGuard(this.config.routes?.guard).sessionId(request);

    if (sessionId === null) {
      request.share(CURRENT_KEY, null);

      return null;
    }

    const row = await ImpersonationLink.query().where("session_id", sessionId).first();
    const record = row ?? null;

    request.share(CURRENT_KEY, record);

    return record;
  }

  /** Whether this request is running inside an impersonation. */
  async isImpersonating(request: Request): Promise<boolean> {
    return (await this.current(request)) !== null;
  }

  /**
   * The user who started the CURRENT link, or null when not
   * impersonating. At depth 1 this is the original admin; deeper, it is
   * whoever started the innermost link, which may itself be an
   * impersonated identity. See `rootImpersonator()`.
   */
  async impersonator<TUser = unknown>(request: Request): Promise<TUser | null> {
    const record = await this.current(request);

    if (record === null) {
      return null;
    }

    return this.findUser<TUser>(record.impersonator_id, this.config.routes?.guard);
  }

  /**
   * The user at the TOP of the chain: the real human, whatever the depth.
   * Identical to `impersonator()` at depth 1, and the one to log or
   * display when `maxDepth > 1`.
   */
  async rootImpersonator<TUser = unknown>(request: Request): Promise<TUser | null> {
    const chain = await this.chain(request);
    const root = chain[0];

    if (root === undefined) {
      return null;
    }

    return this.findUser<TUser>(root.impersonator_id, this.config.routes?.guard);
  }

  /**
   * The full impersonation chain, ROOT FIRST, or an empty array when not
   * impersonating. For an audit log, or for a `before()` hook that wants
   * to reason about the chain it is about to extend.
   */
  async chain(request: Request): Promise<ImpersonationRecord[]> {
    const record = await this.current(request);

    if (record === null) {
      return [];
    }

    const chain: ImpersonationRecord[] = [record];
    let parentId = record.parent_id;

    // Bounded by `depth`, so a cycle written by a buggy migration can't
    // spin here. The chain is at most `maxDepth` long by construction.
    while (parentId !== null && chain.length < record.depth) {
      const parent = await ImpersonationLink.find(parentId);

      if (parent === undefined) {
        break;
      }

      chain.unshift(parent);
      parentId = parent.parent_id;
    }

    return chain;
  }

  /**
   * Delete impersonation rows whose session has lapsed, returning how
   * many. Driven by `impersonation:gc`.
   *
   * Expiry is enforced on read anyway (a row is only reachable via a live
   * session id, and a lapsed session resolves to no user), so this is
   * cleanup rather than a correctness guarantee, same as `auth:gc`.
   */
  async gc(): Promise<number> {
    return ImpersonationLink.query().where("expires_at", "<=", DateTime.now()).delete();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * How many links may be nested. `<= 0` is normalised to 1 rather than
   * honoured.
   *
   * A configured 0 can only mean "nobody may impersonate", which is
   * already the default gate's job and is better said by not registering
   * the provider. Honouring it would make an app that typo'd a 0 present
   * as impersonation inexplicably never working, with a gate callback
   * that looks correct. Failing toward the documented default of 1 is the
   * kinder wrong answer.
   */
  private maxDepth(): number {
    return Math.max(1, this.config.maxDepth ?? 1);
  }

  /** Depth and loop checks for extending the chain on this request. */
  private async assertChainAllows(request: Request, user: object): Promise<void> {
    const parent = await this.current(request);

    if (parent === null) {
      return;
    }

    if (parent.depth + 1 > this.maxDepth()) {
      throw new ImpersonationDeniedError(
        "max-depth",
        `Impersonation is already ${parent.depth} link(s) deep and the configured ` +
          `maximum is ${this.maxDepth()}. Raise \`impersonation.maxDepth\` to nest further.`,
      );
    }

    const targetId = this.idOf(user);
    const chain = await this.chain(request);

    // Impersonating someone already in the chain would make "stop" walk
    // back into a user who is simultaneously further up it.
    const looping = chain.some(
      (link) => link.impersonator_id === targetId || link.impersonated_id === targetId,
    );

    if (looping) {
      throw new ImpersonationDeniedError(
        "already-in-chain",
        "That user is already part of the current impersonation chain.",
      );
    }
  }

  /**
   * Whether the session about to be replaced was a long-lived
   * ("remember me") one.
   *
   * Inferred from its expiry, because remember-me leaves no other trace:
   * this framework deliberately rejected Laravel's recaller cookie, so
   * `{ remember: true }` only ever meant "use `rememberMinutes` instead
   * of `lifetimeMinutes`". An ordinary session can never be expiring more
   * than `lifetimeMinutes` from now (sliding renews to exactly that),
   * so anything beyond that threshold was remembered.
   *
   * Degrades safely: an app configuring `rememberMinutes <=
   * lifetimeMinutes` makes the two kinds genuinely equivalent, so being
   * unable to distinguish them costs nothing.
   */
  private async wasRemembered(request: Request, guardName?: string): Promise<boolean> {
    const remaining = await this.sessionGuard(guardName).sessionLifetimeRemaining(request);

    if (remaining === null) {
      return false;
    }

    return remaining > this.guardLifetimeMinutes(guardName) * 60_000;
  }

  /**
   * The new session's expiry, mirrored onto the row so `gc()` need not
   * join to `sessions`. Read back from the guard rather than recomputed,
   * so a custom store that clamps lifetimes stays authoritative.
   */
  private async sessionExpiry(
    request: Request,
    guardName: string | undefined,
    fallbackFrom: DateTime,
  ): Promise<DateTime> {
    const remaining = await this.sessionGuard(guardName).sessionLifetimeRemaining(request);

    if (remaining !== null) {
      return DateTime.fromTimestamp(Date.now() + remaining);
    }

    return fallbackFrom.addMinutes(this.guardLifetimeMinutes(guardName));
  }

  private guardLifetimeMinutes(guardName?: string): number {
    const config = this.auth().guardConfig(guardName) as SessionGuardConfig;

    return config.lifetimeMinutes ?? 120;
  }

  /**
   * The guard, narrowed to the two session accessors this package needs.
   *
   * Goes through `statefulGuard()` so a token guard fails with
   * `NotStatefulGuardError` rather than a `TypeError` on a missing
   * method.
   */
  private sessionGuard(guardName?: string): SessionCapableGuard {
    return this.auth().statefulGuard(guardName) as unknown as SessionCapableGuard;
  }

  private auth(): AuthManager {
    return this.app.make<AuthManager>(AUTH_TOKEN);
  }

  private async findUser<TUser = unknown>(id: string, guardName?: string): Promise<TUser | null> {
    const auth = this.auth();
    const provider = auth.guardConfig(guardName)["provider"] as string | undefined;

    return (await auth.userProvider(provider).retrieveById(id)) as TUser | null;
  }

  /**
   * A user's id as a string. Mirrors `AuthManager.id()`: the framework
   * never knows the app's key type (snowflake, bigint, uuid), and every
   * id it stores is text, so stringify at the boundary.
   */
  private idOf(user: object): string {
    return String((user as Record<string, unknown>)["id"]);
  }

  private sameUser(admin: object, user: object): boolean {
    return this.idOf(admin) === this.idOf(user);
  }

  /**
   * Dispatch through `@mahiframework/events` when it is installed.
   *
   * Gated on `has(EVENTS_TOKEN)` rather than assumed, the soft-dependency
   * shape `@mahiframework/database`'s model events already use, so
   * impersonation works in an app with no `EventsServiceProvider`.
   */
  private async dispatch(event: object): Promise<void> {
    if (!this.app.has(EVENTS_TOKEN)) {
      return;
    }

    await this.app.make<EventDispatcherLike>(EVENTS_TOKEN).dispatch(event);
  }
}
