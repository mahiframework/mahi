/**
 * The optional `"settings"` config namespace.
 *
 * Every field has a default, so an app that never writes
 * `config/settings.ts` gets a working package: the default cache store,
 * one key, and a day-long TTL.
 *
 * NOTHING HERE IMPORTS A MODEL. A `config/*.ts` is loaded before
 * `app.bootstrap()`, so importing a model would pull the ORM into
 * config-load time.
 */
export interface SettingsConfig {
  cache?: SettingsCacheConfig;

  /**
   * Fire a `SettingUpdated` event on every change. Defaults to `true`.
   *
   * Listeners are awaited inside the write, so a slow listener slows the
   * write. Turn this off in an app that has none rather than paying the
   * dispatch.
   */
  events?: boolean;
}

export interface SettingsCacheConfig {
  /**
   * The single key holding every stored setting.
   *
   * One key, not one per setting, because `@mahiframework/cache` has no
   * tags: there is no way to flush by pattern, so every key this package
   * writes is a key it must be able to name later. One is nameable, and
   * the whole table is a handful of rows — reading all of it is cheaper
   * than the round trips to read a few.
   */
  key?: string;

  /** A named cache store, else the default one. */
  store?: string;

  /**
   * How long the map survives, in seconds. Defaults to 24 hours.
   *
   * A TTL rather than no-expiry specifically BECAUSE there are no cache
   * tags. Invalidation here is an explicit `forget()` on write plus the
   * model-event listener, and if some path ever escapes both, a `null`
   * TTL would make the stale map permanent. A day is short enough that a
   * missed invalidation is an incident with an end, and long enough that
   * the map is effectively always warm.
   */
  ttlSeconds?: number;
}

/** The config with every default applied, built once at provider boot. */
export interface ResolvedSettingsConfig {
  cacheKey: string;
  cacheStore: string | undefined;
  cacheTtlSeconds: number;
  events: boolean;
}

const DEFAULT_CACHE_KEY = "mahi.settings";
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Normalise a config block once, at provider boot.
 *
 * Every default is applied here with `??`, which is both the single
 * place to read them and immune to merge-order surprises: contributing
 * them via `ConfigRepository.merge()` would deep-merge the INCOMING
 * values last and silently overwrite the app's own config rather than
 * layering under it.
 */
export function resolveConfig(config: SettingsConfig = {}): ResolvedSettingsConfig {
  const cache = config.cache ?? {};

  return {
    cacheKey: cache.key ?? DEFAULT_CACHE_KEY,
    cacheStore: cache.store,
    cacheTtlSeconds: cache.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    events: config.events ?? true,
  };
}
