/**
 * The optional `"impersonation"` config namespace. Every field has a
 * default, so an app that never writes `config/impersonation.ts` gets a
 * working package with no routes.
 */
export interface ImpersonationConfig {
  /**
   * Set (even to `{}`) to register the built-in start/stop routes. Omit
   * the key entirely and NO routes are registered: the app owns its own
   * HTTP surface and drives `ImpersonationManager` directly, behind its
   * own middleware, with its own logging and response shapes.
   *
   * Key presence is the switch rather than `routes: { enabled: false }`,
   * matching `http.liveness` and `http.healthCheck`. In this framework an
   * opt-in feature gates on its key existing; only on-by-default
   * behaviour (`http.securityHeaders`) uses an `enabled` flag.
   */
  routes?: ImpersonationRoutesConfig;

  /**
   * How many impersonation links may be nested. Default 1.
   *
   * 1 means Bob may impersonate Alice, and Alice-as-Bob may not then
   * impersonate Jane. 2 allows that second hop, which has a real use
   * case: a platform admin impersonating a tenant admin who needs to see
   * what one of *their* users sees.
   *
   * Values `<= 0` are normalised to 1 rather than honoured; see
   * `ImpersonationManager.maxDepth()` for why.
   */
  maxDepth?: number;
}

export interface ImpersonationRoutesConfig {
  /** Path the start/stop routes are mounted under. Defaults to `/impersonate`. */
  prefix?: string;

  /**
   * Which auth guard to log in and out through, and to authenticate the
   * routes with. Defaults to the auth config's own `default`.
   *
   * Must name a stateful (session) guard. A token guard has no
   * `login()`/`logout()` to swap, by design, so `start()` throws
   * `NotStatefulGuardError` against one.
   */
  guard?: string;

  /**
   * Name of the route parameter carrying the user to impersonate.
   * Defaults to `user`, i.e. `POST /impersonate/{user}`.
   */
  parameter?: string;
}
