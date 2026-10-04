import { Manager, type Application } from "@mahiframework/core";
import type { StorageDriver } from "./storage-driver.js";

/**
 * Filesystem disk. `url` is the public HTTP prefix (`"/storage"` or a
 * CDN origin); omit it for a private disk, whose `url()` **throws** (use
 * `path()` for its on-disk location). `driver` defaults to `"local"`,
 * the only built-in.
 */
export interface LocalDiskConfig {
  driver?: "local";
  root: string;
  url?: string;
  /**
   * Allow `temporaryUrl()` on this disk, served by the stock
   * temporary-URL route.
   *
   * Opt-in, and the signature is already the authorisation, so this is
   * defence in depth: it is the list of disks reachable over HTTP at all,
   * which bounds what a leaked `APP_KEY` could reach. Requires
   * `serveTemporaryDiskFile()` to be mounted.
   */
  temporaryUrls?: boolean;
}

export type DiskConfig = LocalDiskConfig | { driver: string; [key: string]: unknown };

export interface StorageConfig {
  default: string;
  disks: Record<string, DiskConfig>;
}

/**
 * Resolves named storage "disks" (`Manager<StorageDriver>`, same pattern
 * as `DatabaseManager`/`CacheManager`). `"local"` is built in via
 * `StorageServiceProvider`; `.extend("s3", ...)` is the documented
 * extension point for a future remote driver.
 *
 * Disk names are the `extend()` keys (same as every other Manager in
 * this framework. There is no `create{Name}Driver` indirection). A
 * Laravel-style `"public"` disk is just another named local disk with
 * a `url` prefix; `StorageServiceProvider` registers one factory per
 * configured local disk.
 */
export class StorageManager extends Manager<StorageDriver> {
  constructor(
    app: Application,
    private config: StorageConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  diskConfig<T = DiskConfig>(name: string): T {
    return this.config.disks[name] as T;
  }

  /** Domain-flavored alias for `driver()`, mirroring `DatabaseManager.connection()`/`CacheManager.store()`. */
  disk(name?: string): StorageDriver {
    return this.driver(name);
  }

  /**
   * Replace the resolved driver for a disk (default if omitted),
   * bypassing the configured factory and any cached instance, the
   * storage analogue of `QueueManager.swap()`. The test-only primitive
   * behind `Storage.fake()`; production code configures disks through
   * `config/storage.ts`.
   */
  swap(driver: StorageDriver, name?: string): void {
    this.resolved.set(name ?? this.getDefaultDriver(), driver);
  }

  /**
   * Client-facing URL for `path` on the named (or default) disk,
   * `disk().url(path)`. A public disk (one with a `url` prefix) returns
   * an HTTP URL; a private disk **throws** (like Laravel). Use `path()`
   * for the on-disk location of a private-disk file.
   */
  url(path: string, disk?: string): string {
    return this.disk(disk).url(path);
  }

  /**
   * Absolute on-disk location of `path` on the named (or default) disk,
   * `disk().path(path)`. Laravel's `Storage::path()`; for server-side use
   * (the client-facing counterpart is `url()`).
   */
  path(path: string, disk?: string): string {
    return this.disk(disk).path(path);
  }

  /**
   * Time-limited URL for `path` on the named (or default) disk,
   * `disk().temporaryUrl(path, expiresIn)`. Laravel's
   * `Storage::temporaryUrl()`, and the answer for a private disk, where
   * `url()` throws.
   */
  temporaryUrl(path: string, expiresIn?: number, disk?: string): Promise<string> {
    return this.disk(disk).temporaryUrl(path, expiresIn);
  }
}

export function isLocalDiskConfig(value: unknown): value is LocalDiskConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const disk = value as Record<string, unknown>;

  if (typeof disk.root !== "string") {
    return false;
  }

  if (disk.driver !== undefined && disk.driver !== "local") {
    return false;
  }

  return true;
}
