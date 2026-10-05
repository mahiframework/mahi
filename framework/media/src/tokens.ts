/**
 * The `MediaManager` singleton.
 *
 * NOT in `@mahiframework/core`'s `well-known-tokens.ts`. That file is
 * explicitly for tokens referenced ACROSS package boundaries by packages
 * that deliberately avoid a compile-time dependency; nothing outside this
 * package resolves this one by string. A local literal is correct until
 * that changes.
 *
 * A separate module from the provider so the facade and the relation
 * builders can import the token without importing the provider, which
 * would be a cycle.
 */
export const MEDIA_TOKEN = "media";
