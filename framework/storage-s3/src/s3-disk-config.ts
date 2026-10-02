import type { S3DiskConfig } from "./s3-storage-driver.js";

/**
 * Whether a disk config is an S3 disk.
 *
 * `driver: "s3"` is what makes `StorageServiceProvider` skip the disk —
 * `isLocalDiskConfig` rejects any explicit driver other than `"local"` —
 * leaving the name free for this package's provider to claim.
 */
export function isS3DiskConfig(value: unknown): value is S3DiskConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const disk = value as Record<string, unknown>;

  return disk.driver === "s3" && typeof disk.bucket === "string";
}
