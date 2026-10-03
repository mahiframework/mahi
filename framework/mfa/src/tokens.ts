/**
 * The container token for `MfaManager`.
 *
 * Its own module, like `@mahiframework/auth`'s `tokens.ts`, so
 * `require-mfa.ts` and the middleware can import it without pulling in
 * the service provider (which imports them back). A cycle-free import
 * target, nothing more.
 *
 * NOT in `@mahiframework/core`'s `well-known-tokens.ts`. That file is
 * explicitly for tokens referenced ACROSS package boundaries by
 * packages that deliberately avoid a compile-time dependency. Nothing in
 * the framework resolves MFA that way: this package depends on `auth`
 * directly, and no first-party package depends on this one. A local
 * literal is correct until that changes.
 */
export const MFA_TOKEN = "mfa";
