/**
 * Shape of `config/socialite.ts`.
 *
 * NOTHING HERE IMPORTS A DRIVER OR A MODEL: `config/*.ts` is loaded
 * before `app.bootstrap()`, so a config module that reaches into the
 * framework's runtime fails at import time.
 */
export interface SocialiteProviderConfig {
  /**
   * The driver to use. Defaults to the provider's config name, so
   * `{ github: { ... } }` resolves the `github` driver with no `driver`
   * key.
   *
   * Name it to run two of the same driver: an app with a staging and a
   * production GitHub App needs two `github` drivers under two names.
   * This is the guards-versus-drivers split `AuthManager` already makes.
   */
  driver?: string;

  clientId?: string;
  clientSecret?: string;

  /**
   * Where the provider sends the user back.
   *
   * May be root-relative (`"/auth/github/callback"`), in which case it
   * is resolved to an absolute URL through the URL generator at the time
   * the driver is first used.
   */
  redirect?: string;

  /**
   * Scopes to request. **Replaces** the driver's defaults rather than
   * merging with them.
   *
   * This is a deliberate divergence from Laravel Socialite, whose
   * `buildProvider()` calls `->scopes($config['scopes'] ?? [])` — a
   * merge — so configuring `["repo"]` on GitHub silently yields
   * `["user:email", "repo"]`. That surprises people constantly. The
   * fluent methods keep Socialite's semantics: `.scopes()` merges,
   * `.setScopes()` replaces.
   */
  scopes?: string[];

  /** Add PKCE (S256) to the flow. Off by default for OAuth 2.0. */
  pkce?: boolean;

  /** Extra parameters appended to the authorization URL. */
  parameters?: Record<string, string>;

  /**
   * Any driver-specific keys. A driver shipped by another package reads
   * its own settings from here and claims the provider with a type guard,
   * the way `@mahiframework/storage-s3` claims a disk.
   */
  [key: string]: unknown;
}

/** Cookie attributes for the short-lived OAuth state cookie. */
export interface SocialiteCookieConfig {
  /**
   * Send the cookie only over HTTPS. Defaults to `true`, so plain-HTTP
   * local development must opt out — the same default
   * `SessionGuardConfig.secure` takes.
   */
  secure?: boolean;
  path?: string;
  domain?: string;
  /**
   * `"host"` yields a `__Host-` cookie, which a sibling subdomain cannot
   * set or overwrite. Requires `secure: true`, `path: "/"` and no
   * `domain`, so it is opt-in.
   */
  prefix?: "secure" | "host";
  /** How long an in-flight flow may take. Defaults to 600 (ten minutes). */
  ttlSeconds?: number;
}

export interface SocialiteConfig {
  /**
   * Providers, keyed by config name.
   *
   * There is deliberately no `default`: there is no default OAuth
   * provider, and a `default` key nobody may use would be a trap.
   */
  providers?: Record<string, SocialiteProviderConfig>;
  cookie?: SocialiteCookieConfig;
}

export interface ResolvedSocialiteConfig {
  providers: Record<string, SocialiteProviderConfig>;
  cookie: Required<Pick<SocialiteCookieConfig, "secure" | "path" | "ttlSeconds">> &
    Pick<SocialiteCookieConfig, "domain" | "prefix">;
}

/**
 * Apply defaults.
 *
 * Done here rather than by contributing a defaults object through
 * `ConfigRepository.merge()`, because `merge()` deep-merges the incoming
 * values **last** — so defaults supplied that way overwrite the app's
 * config. `@mahiframework/permissions` records the same constraint.
 */
export function resolveConfig(config: SocialiteConfig = {}): ResolvedSocialiteConfig {
  const cookie = config.cookie ?? {};

  return {
    providers: config.providers ?? {},
    cookie: {
      secure: cookie.secure ?? true,
      path: cookie.path ?? "/",
      ttlSeconds: cookie.ttlSeconds ?? 600,
      ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
      ...(cookie.prefix === undefined ? {} : { prefix: cookie.prefix }),
    },
  };
}

/**
 * The driver a configured provider uses.
 *
 * Falling back to the config name is what keeps the `{ github: {...} }`
 * shorthand working, exactly as `AuthManager.guardDriver()` and
 * `DatabaseManager` do.
 */
export function driverNameFor(name: string, config: SocialiteProviderConfig): string {
  return typeof config.driver === "string" ? config.driver : name;
}

/** The config keys every OAuth 2.0 provider needs. */
const REQUIRED_KEYS = ["clientId", "clientSecret", "redirect"] as const;

/**
 * A provider config known to carry every required key.
 *
 * A distinct type rather than a cast at the use site: `validateProvider`
 * is the one place that proves these are present, and widening the
 * return type is how that proof travels.
 */
export type ValidatedProviderConfig = SocialiteProviderConfig &
  Required<Pick<SocialiteProviderConfig, "clientId" | "clientSecret" | "redirect">>;

/** Which of the required keys `config` is missing or left empty. */
export function missingRequiredKeys(config: SocialiteProviderConfig): string[] {
  return REQUIRED_KEYS.filter((key) => {
    const value = config[key];

    return typeof value !== "string" || value === "";
  });
}

/**
 * Narrow a provider config, or report everything it is missing.
 *
 * Returns the missing keys rather than throwing, so the caller owns the
 * error type and the message can name the provider.
 */
export function validateProvider(
  config: SocialiteProviderConfig,
): { ok: true; config: ValidatedProviderConfig } | { ok: false; missing: string[] } {
  const missing = missingRequiredKeys(config);

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  // Safe by construction: `missingRequiredKeys` returned nothing, so all
  // three keys hold non-empty strings.
  return { ok: true, config: config as ValidatedProviderConfig };
}
