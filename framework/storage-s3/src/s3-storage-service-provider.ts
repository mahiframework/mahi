import { ServiceProvider, STORAGE_TOKEN } from "@mahiframework/core";
import { signedDiskUrls, type StorageConfig, type StorageManager } from "@mahiframework/storage";
import { S3StorageDriver } from "./s3-storage-driver.js";
import { isS3DiskConfig } from "./s3-disk-config.js";

/**
 * Registers an `S3StorageDriver` for every disk in `config/storage.ts`
 * whose `driver` is `"s3"`.
 *
 * `StorageServiceProvider` deliberately skips any disk config that isn't
 * local so that a plugin's own `extend(name, ...)` can own it, and this is
 * that plugin. List it **after** `StorageServiceProvider` in
 * `config/app.ts`, since `register()` here resolves `STORAGE_TOKEN`, which
 * that provider binds.
 *
 * Registration is not connection, and here it isn't even an import: the
 * AWS SDK is loaded lazily on a disk's first operation, so an app that
 * lists this provider but never touches an S3 disk pays nothing for it —
 * no client, no sockets, and none of the 18 MB of SDK parsed.
 */
export class S3StorageServiceProvider extends ServiceProvider {
  register(): void {
    const storage = this.app.make<StorageManager>(STORAGE_TOKEN);
    const config = this.app.config.require<StorageConfig>("storage");

    for (const [name, disk] of Object.entries(config.disks)) {
      if (!isS3DiskConfig(disk)) {
        continue;
      }

      storage.extend(
        name,
        () =>
          new S3StorageDriver(disk, disk.url, {
            // S3 signs natively, so the fallback is NOT the default here.
            // `temporaryUrls: "proxy"` opts into routing downloads through
            // this application instead, for a bucket that should stay
            // unreachable from the internet.
            temporaryUrl: disk.temporaryUrls === "proxy" ? signedDiskUrls(name) : undefined,
          }),
      );
    }
  }

  /**
   * Release the pooled sockets of every S3 client that was actually built.
   *
   * `isResolved` first, for the same reason the SFTP provider checks it: on
   * a shutdown after a failed boot, `make()`ing the manager would construct
   * the very drivers that shutdown exists to release.
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
