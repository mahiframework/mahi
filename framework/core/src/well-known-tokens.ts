/**
 * The single source of truth for the container-binding tokens of services
 * that are referenced ACROSS package boundaries.
 *
 * WHY THIS EXISTS: several packages deliberately avoid a compile-time
 * dependency on the package that owns a service, resolving it by string
 * token at runtime instead. `@mahiframework/authorization` reads the
 * current user via `"auth"` without depending on `@mahiframework/auth`,
 * `@mahiframework/schedule` dispatches jobs via `"queue"` without depending
 * on `@mahiframework/queue`, `@mahiframework/http` fans broadcasts out via
 * `"broadcast"` without depending on `@mahiframework/broadcasting`, and
 * `@mahiframework/auth`'s optional "cache" session store reaches
 * `@mahiframework/cache` via `"cache"`. Sharing the constants here means the token
 * is declared in exactly one place; a private `const X_TOKEN = "..."`
 * literal per package would let a typo in either copy become a silent
 * `BindingNotFoundError` at runtime with no compile-time protection.
 *
 * Every package already depends on `@mahiframework/core` (it's where
 * `Application`/`ServiceProvider` live), so hoisting these token strings
 * here gives both the owning package AND every soft-dependent a single
 * literal to import. A typo is now a compile error, not a runtime one,
 * and the value can never drift between the two sides.
 *
 * Each owning package still re-exports its token under the historical
 * name (`AUTH_TOKEN` from `@mahiframework/auth`, `QUEUE_TOKEN` from
 * `@mahiframework/queue`, …) so existing imports keep working. Those
 * re-exports now just point back here.
 *
 * Only genuinely cross-package tokens belong here. Package-private tokens
 * (e.g. `RATE_LIMITER_TOKEN`, `MODEL_REGISTRY_TOKEN`, `HTTP_KERNEL_TOKEN`)
 * that are only ever resolved from within their own package stay local to
 * that package.
 */

/** `DatabaseManager`, owned by `@mahiframework/database`. */
export const DATABASE_TOKEN = "db";

/** `AuthManager`, owned by `@mahiframework/auth`. */
export const AUTH_TOKEN = "auth";

/** `GateRegistry`, owned by `@mahiframework/authorization`. */
export const GATE_TOKEN = "gate";

/** `QueueManager`, owned by `@mahiframework/queue`. */
export const QUEUE_TOKEN = "queue";

/** `CacheManager`, owned by `@mahiframework/cache`. */
export const CACHE_TOKEN = "cache";

/** `EventDispatcher`, owned by `@mahiframework/events`. */
export const EVENTS_TOKEN = "events";

/** `BroadcastManager`, owned by `@mahiframework/broadcasting`. */
export const BROADCAST_TOKEN = "broadcast";

/** `StorageManager`, owned by `@mahiframework/storage`. */
export const STORAGE_TOKEN = "storage";

/**
 * `Signer`, owned by `@mahiframework/encryption`.
 *
 * Resolved by string from `@mahiframework/http` (signed route links),
 * `@mahiframework/storage` (temporary disk URLs) and
 * `@mahiframework/broadcasting` (channel-auth grants). Those last two
 * deliberately avoid a compile-time dependency on `encryption`, whose
 * `argon2` dependency is a native build nothing else needs — they type
 * the resolved value structurally as `SignerLike` instead.
 */
export const SIGNER_TOKEN = "signer";
