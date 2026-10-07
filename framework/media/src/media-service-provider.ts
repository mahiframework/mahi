import { ServiceProvider } from "@mahiframework/core";
import type { AnyModelClass, RegisteredMigration } from "@mahiframework/database";
import { MediaManager } from "./media-manager.js";
import { resolveConfig, type MediaConfig } from "./media-config.js";
import { MediaFile } from "./models/media-file.model.js";
import createMediaTable from "./migrations/0001_create_media_table.js";
import { MediaCheckCommand } from "./commands/media-check.js";
import { MediaPruneCommand } from "./commands/media-prune.js";
import { ImageManager } from "./image/image-manager.js";
import { isSupportedAlgorithm } from "./support/checksum.js";
import { IMAGE_TOKEN, MEDIA_TOKEN } from "./tokens.js";

export { IMAGE_TOKEN, MEDIA_TOKEN };

/**
 * Registers the `MediaManager` singleton, the `media` table's migration,
 * and the `MediaFile` model.
 *
 * ORDERING: list this provider AFTER `DatabaseServiceProvider` (it owns
 * a table and a model) and AFTER `StorageServiceProvider` (every write
 * goes through a disk).
 *
 * You cannot enforce either; the app's `config/app.ts` decides, and this
 * docstring is the whole mechanism.
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
      const resolved = resolveConfig(config);

      // Checked here rather than at first upload. `createHash()` throws
      // on an unknown digest name, and a typo in `config/media.ts`
      // should fail where it is fixable instead of on a user's first
      // avatar — by which point the message is a `node:crypto` error
      // with no mention of config.
      if (!isSupportedAlgorithm(resolved.hashAlgorithm)) {
        throw new Error(
          `media.hashing.algorithm is "${resolved.hashAlgorithm}", which node:crypto does not ` +
            `support. Use a digest name from crypto.getHashes(), e.g. "sha256".`,
        );
      }

      return new MediaManager(app, resolved);
    });

    // Bound even when no driver is configured, because this is the
    // object a driver package's provider calls `extend()` on — and that
    // provider may be registered before or after this one. Resolving a
    // DRIVER from it is what fails when none exists; having the manager
    // is not an error.
    this.app.singleton(IMAGE_TOKEN, (app) => {
      const config = app.config.get<MediaConfig>("media") ?? {};

      return new ImageManager(app, config.image?.default ?? null);
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

  commands() {
    return [MediaPruneCommand, MediaCheckCommand];
  }
}
