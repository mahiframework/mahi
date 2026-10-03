/**
 * Container binding key for the `ImpersonationManager`.
 *
 * Declared in its own module so the facade, the controllers and the gc
 * command can import it without pulling in the service provider, and the
 * import cycle that would create (provider → manager → facade →
 * provider). The same reason `@mahiframework/auth` and
 * `@mahiframework/authorization` each give their token a module.
 *
 * Local rather than hoisted into `@mahiframework/core`'s
 * `well-known-tokens`: nothing outside this package resolves it, which is
 * the bar that file sets. `HEALTH_TOKEN` is the precedent.
 */
export const IMPERSONATION_TOKEN = "impersonation";
