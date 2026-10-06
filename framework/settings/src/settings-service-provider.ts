import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass, RegisteredMigration } from "@mahiframework/database";
import { ModelCreated, ModelDeleted, ModelUpdated } from "@mahiframework/database";
import type { ListenerRegistration } from "@mahiframework/events";
import { SettingsCacheResetCommand } from "./commands/settings-cache-reset.js";
import { SettingsForgetCommand } from "./commands/settings-forget.js";
import { SettingsGetCommand } from "./commands/settings-get.js";
import { SettingsListCommand } from "./commands/settings-list.js";
import { SettingsSetCommand } from "./commands/settings-set.js";
import { InvalidateSettingsCacheListener } from "./listeners/invalidate-settings-cache.listener.js";
import createSettingsTable from "./migrations/0001_create_settings_table.js";
import { SettingRecord } from "./models/setting-record.model.js";
import { resolveConfig, type SettingsConfig } from "./settings-config.js";
import { SettingsRegistry } from "./settings-registry.js";
import { SETTINGS_TOKEN } from "./tokens.js";

export { SETTINGS_TOKEN };

/**
 * Registers the `SettingsRegistry` singleton, collects every provider's
 * `settings()` definitions, and keeps the cache honest.
 *
 * ORDERING: list this provider AFTER `DatabaseServiceProvider` (it owns
 * a table and a model), AFTER `CacheServiceProvider` (the map lives in a
 * cache store), and AFTER `EventsServiceProvider` if an app listens for
 * `SettingUpdated`. Its position relative to the providers that
 * *declare* settings does not matter: `boot()` walks every registered
 * provider, so a provider listed later still has its definitions
 * collected.
 *
 * You cannot enforce any of that; the app's `config/app.ts` decides, and
 * this docstring is the whole mechanism.
 */
export class SettingsServiceProvider extends ServiceProvider {
  register(): void {
    // No `config.merge()` of defaults. Every default is applied in
    // `resolveConfig()` with `??`, which is both the single place to read
    // them and immune to merge-order surprises: `ConfigRepository.merge()`
    // deep-merges the INCOMING values last, so contributing defaults that
    // way would silently overwrite the app's own config rather than
    // layering under it.
    this.app.singleton(SETTINGS_TOKEN, (app) => {
      // `get`, not `require`: an app that installs the package and
      // configures nothing gets working defaults (the default store, one
      // key, a day-long TTL) rather than a boot failure.
      const config = app.config.get<SettingsConfig>("settings") ?? {};

      return new SettingsRegistry(app, resolveConfig(config));
    });
  }

  /**
   * Collect every provider's declared settings.
   *
   * In `boot()`, walking `getProviders()`, rather than in `register()`:
   * a provider listed after this one in `config/app.ts` has not been
   * constructed yet during registration, and silently dropping its
   * settings would be a bug an app could only find by reading this file.
   * The same guarantee `models()` and `checks()` give.
   */
  boot(): void {
    const registry = this.app.make<SettingsRegistry>(SETTINGS_TOKEN);

    for (const provider of this.app.getProviders()) {
      const definitions = provider.settings?.();

      if (!definitions) {
        continue;
      }

      registry.define(definitions);
    }
  }

  listeners(): ReadonlyArray<ListenerRegistration> {
    return [
      [ModelCreated, InvalidateSettingsCacheListener],
      [ModelUpdated, InvalidateSettingsCacheListener],
      [ModelDeleted, InvalidateSettingsCacheListener],
    ] as const;
  }

  /**
   * Static rather than a `migrations()` directory path, so it resolves
   * inside a bundled binary.
   */
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_settings_table", migration: createSettingsTable }];
  }

  /** Registered so a queued job can carry a `SettingRecord`. */
  models(): AnyModelClass[] {
    return [SettingRecord as unknown as AnyModelClass];
  }

  commands() {
    return [
      SettingsListCommand,
      SettingsGetCommand,
      SettingsSetCommand,
      SettingsForgetCommand,
      SettingsCacheResetCommand,
    ];
  }
}
