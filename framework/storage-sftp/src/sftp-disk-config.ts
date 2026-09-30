import type { SftpDiskConfig } from "./sftp-storage-driver.js";

/**
 * Type guard for an `"sftp"` disk entry in `config/storage.ts`, the
 * counterpart to `@mahiframework/storage`'s `isLocalDiskConfig`.
 *
 * Checks the fields that cannot be defaulted: a `driver` of exactly
 * `"sftp"`, plus a `host` and `username`. Credentials are not required
 * here, an agent-less, password-less config is valid when the server
 * accepts the key ssh2 finds.
 */
export function isSftpDiskConfig(value: unknown): value is SftpDiskConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const disk = value as Record<string, unknown>;

  return (
    disk.driver === "sftp" && typeof disk.host === "string" && typeof disk.username === "string"
  );
}
