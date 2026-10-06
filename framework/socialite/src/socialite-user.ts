/**
 * Credentials a provider issued alongside a user.
 *
 * One object rather than Laravel Socialite's four flat fields on the
 * user. Socialite duplicates `token`/`refreshToken`/`expiresIn`/
 * `approvedScopes` across `Two\User` and `Two\Token` and keeps them in
 * sync by hand in two places; nesting removes the duplication, makes
 * `refreshToken()`'s return type the same type the user already carries,
 * and means an app persisting credentials copies one field.
 */
export interface SocialiteToken {
  readonly token: string;
  /** Null when the provider issued none, which is the common case. */
  readonly refreshToken: string | null;
  /** Seconds until `token` expires, or null when the provider said nothing. */
  readonly expiresIn: number | null;
  /**
   * Scopes the provider actually granted, which may be narrower than
   * those requested.
   *
   * `[]` when the provider omitted `scope`, not `[""]`. PHP's
   * `explode(",", "")` yields `[""]` and so does JS's `"".split(",")`,
   * so Socialite reports one empty scope where there are none;
   * reproducing that wart as a public API is not fidelity worth having.
   */
  readonly approvedScopes: readonly string[];
}

/**
 * The normalised user a driver returns.
 *
 * `TRaw` is the provider's own payload shape, so a driver can hand back
 * a typed `raw` and `user.raw.node_id` checks at compile time. This is
 * the thing the PHP original cannot do: Socialite's `AbstractUser` has
 * three overlapping access paths on one object — declared properties set
 * by `map()`, undeclared keys served from `$attributes` via `__get`, and
 * the verbatim payload via `ArrayAccess`. A `Proxy` would reproduce
 * `__get` exactly and defeat inference, which is most of the reason to
 * be in TypeScript. Declared fields plus a typed `raw` is the port.
 */
export interface SocialiteUser<TRaw = Record<string, unknown>> {
  /**
   * The provider's stable identifier for this user, always a string.
   *
   * GitHub returns a number and Google a string; normalising at the
   * boundary beats every call site guessing. Treat it as opaque and
   * scope it by provider — a provider's `id` is unique within that
   * provider and nowhere else.
   */
  readonly id: string;
  readonly nickname: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly avatar: string | null;

  /** The provider's verbatim payload. */
  readonly raw: TRaw;

  /** The credentials this user was resolved with. */
  readonly token: SocialiteToken;
}

/**
 * The identity half of a user, which is all a driver's `mapUser()` has
 * to produce: `raw` and `token` are attached by the base driver.
 */
export type MappedSocialiteUser = Omit<SocialiteUser, "raw" | "token">;
