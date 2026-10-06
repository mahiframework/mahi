/**
 * Container binding key for the `SocialiteManager`.
 *
 * Declared in its own module so the facade can import it without pulling
 * in the service provider, and the import cycle that would create
 * (provider → manager → facade → provider). The same reason
 * `@mahiframework/auth` and `@mahiframework/impersonation` each give
 * their token a module.
 *
 * Local rather than hoisted into `@mahiframework/core`'s
 * `well-known-tokens`: nothing outside this package resolves it, which is
 * the bar that file sets.
 */
export const SOCIALITE_TOKEN = "socialite";
