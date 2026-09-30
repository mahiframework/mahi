import { ServiceProvider, STORAGE_TOKEN } from "@mahiframework/core";
import type { StorageConfig, StorageManager } from "@mahiframework/storage";
import { SftpStorageDriver } from "./sftp-storage-driver.js";
import { isSftpDiskConfig } from "./sftp-disk-config.js";

/**
 * Registers an `SftpStorageDriver` for every disk in `config/storage.ts`
 * whose `driver` is `"sftp"`.
 *
 * `StorageServiceProvider` deliberately skips any disk config that isn't
 * local so that a plugin's own `extend(name, ...)` can own it, and this
 * is that plugin. List it **after** `StorageServiceProvider` in
 * `config/app.ts`, since `register()` here resolves `STORAGE_TOKEN`,
 * which that provider binds.
 *
 * Registration is not connection: the factories are registered, but a
 * driver is only constructed when the disk is actually resolved, and the
 * SSH session opens on that driver's first operation. An app that lists
 * this provider but never touches an SFTP disk never opens a socket, so
 * a NAS being asleep at boot is not a boot failure.
 */
export class SftpStorageServiceProvider extends ServiceProvider {
  register(): void {
    const storage = this.app.make<StorageManager>(STORAGE_TOKEN);
    const config = this.app.config.require<StorageConfig>("storage");

    for (const [name, disk] of Object.entries(config.disks)) {
      if (!isSftpDiskConfig(disk)) {
        continue;
      }

      storage.extend(name, () => new SftpStorageDriver(disk, disk.url));
    }
  }

  /**
   * Close every SFTP session that was actually opened.
   *
   * `isResolved` first, for the same reason `CacheServiceProvider` checks
   * it: on a shutdown after a failed boot, `make()`ing the manager would
   * construct the very drivers, and so open the very sockets, that
   * shutdown exists to release.
   */
  async shutdown(): Promise<void> {
    if (!this.app.isResolved(STORAGE_TOKEN)) {
      return;
    }

    const storage = this.app.make<StorageManager>(STORAGE_TOKEN);

    for (const error of await storage.disconnectAll()) {
      this.app.logger.error("storage: failed to disconnect a disk.", { error });
    }
  }
}
