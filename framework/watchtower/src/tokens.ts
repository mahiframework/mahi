/**
 * The `WatchtowerManager` singleton.
 *
 * NOT in `@mahiframework/core`'s `well-known-tokens.ts`. That file is
 * explicitly for tokens referenced ACROSS package boundaries by packages
 * that deliberately avoid a compile-time dependency; nothing outside this
 * package resolves this one by string. A local literal is correct until
 * that changes.
 *
 * A separate module from the provider so the facade, the commands and
 * the middleware can import the token without importing the provider,
 * which would be a cycle.
 */
export const WATCHTOWER_TOKEN = "watchtower";

/** The queue connection name this package registers via `QueueManager.extend()`. */
export const WATCHTOWER_CONNECTION = "watchtower";
