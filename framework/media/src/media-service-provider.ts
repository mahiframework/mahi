import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass, RegisteredMigration } from "@mahiframework/database";
import { MediaManager } from "./media-manager.js";
import { resolveConfig, type MediaConfig } from "./media-config.js";
import { MediaFile } from "./models/media-file.model.js";
import createMediaTable from "./migrations/0001_create_media_table.js";
import { MEDIA_TOKEN } from "./tokens.js";

export { MEDIA_TOKEN };

/**
 * Registers the `MediaManager` singleton, the `media` table's migration,
 * and the `MediaFile` model.
 *
 * ORDERING: list this provider AFTER `DatabaseServiceProvider` (it owns
 * a table and a model), AFTER `StorageServiceProvider` (every write goes
 * through a disk), and AFTER `SnowflakeServiceProvider`.
 *
 * That last one is a HARD RUNTIME REQUIREMENT, not merely a
 * compile-time one. `MediaFile` declares `keyType: snowflake()`, which
 * resolves `SNOWFLAKE_TOKEN` at key-generation time, so an app that
 * omits the provider gets `BindingNotFoundError` on its first upload
 * rather than at boot — late, and far from the cause. `permissions` hit
 * exactly this and now registers the real provider in its test harness
 * rather than stubbing ids; this package does the same, so the
 * requirement stays visible.
 *
 * You cannot enforce any of that; the app's `config/app.ts` decides, and
 * this docstring is the whole mechanism.
 *
 * Registers NO routes and NO middleware, deliberately. Private media is
 * served by the application, either through `media.temporaryUrl()` or
 * through its own route over `serveStoredFile()` — which already does
 * ranges, ETags, conditional GET and abort handling. A download route
 * shipped from here would have to either skip authorization (which is
 * what laravel-media does, making its signed URL the only check) or
 * invent a policy hook for a decision the app is better placed to make.
 */
export class MediaServiceProvider extends ServiceProvider {
  register(): void {
    // No `config.merge()` of defaults. Every default is applied in
    // `resolveConfig()` with `??`, which is both the single place to read
    // them and immune to merge-order surprises: `ConfigRepository.merge()`
    // deep-merges the INCOMING values last, so contributing defaults that
    // way would silently overwrite the app's own config rather than
    // layering under it.
    this.app.singleton(MEDIA_TOKEN, (app) => {
      // `get`, not `require`: an app that installs the package and
      // configures nothing gets working defaults (the storage default
      // disk, four-level paths, sha256 checksums) rather than a boot
      // failure.
      const config = app.config.get<MediaConfig>("media") ?? {};

      return new MediaManager(app, resolveConfig(config));
    });
  }

  /**
   * Static rather than a `migrations()` directory path, so it resolves
   * inside a bundled binary. A directory path cannot, and the runner
   * treats an unreadable directory as "no migrations" rather than an
   * error — so a bundled app would silently migrate zero tables. See
   * `QueueServiceProvider.migrationSources()`.
   */
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_media_table", migration: createMediaTable }];
  }

  /**
   * Registered so a queued job can carry a `MediaFile`.
   *
   * The concrete class, not `mediaModels.media`. This hook is read once
   * during boot to populate the morph map, and an app swapping the model
   * calls `useMediaModels()` from its own `register()` — which may run
   * after this one. Registering the base class means the alias resolves
   * either way, and a subclass shares its parent's `morphName`.
   */
  models(): AnyModelClass[] {
    return [MediaFile as unknown as AnyModelClass];
  }
}
