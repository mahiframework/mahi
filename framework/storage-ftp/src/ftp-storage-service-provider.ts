import { ServiceProvider, STORAGE_TOKEN } from "@mahiframework/core";
import { signedDiskUrls, type StorageConfig, type StorageManager } from "@mahiframework/storage";
import { FtpStorageDriver } from "./ftp-storage-driver.js";
import { isFtpDiskConfig } from "./ftp-disk-config.js";

/**
 * Registers an `FtpStorageDriver` for every disk in `config/storage.ts`
 * whose `driver` is `"ftp"`.
 *
 * `StorageServiceProvider` deliberately skips any disk config that isn't
 * local so that a plugin's own `extend(name, ...)` can own it, and this is
 * that plugin. List it **after** `StorageServiceProvider` in
 * `config/app.ts`, since `register()` here resolves `STORAGE_TOKEN`, which
 * that provider binds.
 *
 * Registration is not connection: a driver is constructed only when its
 * disk is resolved, and the control connection opens on that driver's first
 * operation. An app that lists this provider but never touches an FTP disk
 * never logs in, so an appliance being offline at boot is not a boot
 * failure.
 */
export class FtpStorageServiceProvider extends ServiceProvider {
  register(): void {
    const storage = this.app.make<StorageManager>(STORAGE_TOKEN);
    const config = this.app.config.require<StorageConfig>("storage");

    for (const [name, disk] of Object.entries(config.disks)) {
      if (!isFtpDiskConfig(disk)) {
        continue;
      }

      storage.extend(
        name,
        () =>
          new FtpStorageDriver(disk, disk.url, {
            temporaryUrl: disk.temporaryUrls === true ? signedDiskUrls(name) : undefined,
          }),
      );
    }
  }

  /**
   * Close every FTP connection that was actually opened.
   *
   * `isResolved` first, for the same reason the SFTP provider checks it: on
   * a shutdown after a failed boot, `make()`ing the manager would construct
   * the very drivers, and so open the very sockets, that shutdown exists to
   * release.
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
