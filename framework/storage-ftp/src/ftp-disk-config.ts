import type { FtpDiskConfig } from "./ftp-storage-driver.js";

/**
 * Whether a disk config is an FTP disk.
 *
 * `driver: "ftp"` is what makes `StorageServiceProvider` skip the disk —
 * `isLocalDiskConfig` rejects any explicit driver other than `"local"` —
 * leaving the name free for this package's provider to claim.
 */
export function isFtpDiskConfig(value: unknown): value is FtpDiskConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const disk = value as Record<string, unknown>;

  return disk.driver === "ftp" && typeof disk.host === "string" && typeof disk.user === "string";
}
