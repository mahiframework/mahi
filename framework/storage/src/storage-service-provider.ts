import { ServiceProvider, STORAGE_TOKEN } from "@mahiframework/core";
import { StorageManager, isLocalDiskConfig, type StorageConfig } from "./storage-manager.js";
import { LocalStorageDriver } from "./drivers/local-storage-driver.js";
import { signedDiskUrls } from "./temporary-url.js";

// Canonical definition in `@mahiframework/core`'s `well-known-tokens`;
// re-exported so this package's public API is unchanged.
export { STORAGE_TOKEN };

/**
 * Registers the `StorageManager` singleton and a `LocalStorageDriver`
 * factory for every configured disk whose `driver` is `"local"` (or
 * omitted. Local is the default). Same `extend()` mechanism a plugin
 * would use to add e.g. an "s3" disk later; those disks are skipped
 * here so the plugin's own `extend(name, ...)` can own them. No
 * `boot()` needed. `LocalStorageDriver` has no async warm-up
 * (`mkdir`/`writeFile` happen lazily per-call, same "sync driver
 * construction, lazy I/O" philosophy already established for
 * `DatabaseManager`/`CacheManager`).
 */
export class StorageServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(STORAGE_TOKEN, (app) => {
      const config = app.config.require<StorageConfig>("storage");
      const manager = new StorageManager(app, config);

      for (const [name, disk] of Object.entries(config.disks)) {
        if (!isLocalDiskConfig(disk)) {
          continue;
        }

        manager.extend(
          name,
          () =>
            new LocalStorageDriver(disk.root, disk.url, {
              // The provider is the only place that holds both the disk's
              // name and its config, and a temporary URL needs the name to
              // address the route. Captured here so the driver stays
              // constructible without a container.
              temporaryUrl: disk.temporaryUrls === true ? signedDiskUrls(name) : undefined,
            }),
        );
      }

      return manager;
    });
  }
}
