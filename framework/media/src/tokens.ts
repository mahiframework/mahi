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

/**
 * The `ImageManager` singleton.
 *
 * Separate from `MEDIA_TOKEN` because the two have different lifetimes
 * in practice. An app that stores only documents never resolves this
 * one, and resolving it is what surfaces "no image driver is
 * registered" — folding it into the media manager would raise that at
 * boot for everybody rather than at first use by the apps it concerns.
 *
 * It is also the extension point: a driver package's provider resolves
 * this token and calls `extend()` on it, the same way a storage driver
 * extends the `StorageManager`.
 */
export const IMAGE_TOKEN = "media.image";
