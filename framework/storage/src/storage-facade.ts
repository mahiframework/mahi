import type { Readable, Writable } from "node:stream";
import { Facade } from "@mahiframework/facades";
import { STORAGE_TOKEN } from "@mahiframework/core";
import type { StorageManager } from "./storage-manager.js";
import type { StorageDriver, StreamSource } from "./storage-driver.js";

/**
 * Thin facade over the `StorageManager` singleton bound at `STORAGE_TOKEN`,
 * for call sites that would otherwise read
 * `app().make<StorageManager>(STORAGE_TOKEN).disk().put(...)`.
 *
 *   await Storage.put("avatars/1.png", buffer);
 *   const bytes = await Storage.get("avatars/1.png");
 *   const url = Storage.url("avatars/1.png");
 *   await Storage.disk("s3").put("backups/db.sqlite", buffer);   // a specific disk
 *
 * `disk()`/`url(path, disk?)` come from the `StorageManager`; the plain
 * file operations (`put`/`get`/`exists`/`delete`) are forwarded to the
 * DEFAULT disk, the common case, matching how Laravel's `Storage` facade
 * proxies to the default filesystem. For a non-default disk, go through
 * `Storage.disk(name)` (a `StorageDriver`) and call the same methods on it.
 *
 * Prefer constructor-injecting `StorageManager` (via `STORAGE_TOKEN`)
 * where that's practical (e.g. inside a `ServiceProvider`/`Command` that
 * already receives `app`), use this only where threading
 * `app`/`StorageManager` through is genuinely inconvenient, same guidance
 * as `app()` itself.
 */
export class Storage extends Facade<StorageManager>(() => STORAGE_TOKEN) {
  /** The named disk (default if omitted). Laravel's `Storage::disk()`. */
  static disk(name?: string): StorageDriver {
    return this.instance().disk(name);
  }

  static put(path: string, contents: Buffer | string): Promise<void> {
    return this.disk().put(path, contents);
  }

  static get(path: string): Promise<Buffer> {
    return this.disk().get(path);
  }

  static exists(path: string): Promise<boolean> {
    return this.disk().exists(path);
  }

  static delete(path: string): Promise<void> {
    return this.disk().delete(path);
  }

  static files(directory?: string): Promise<string[]> {
    return this.disk().files(directory);
  }

  static allFiles(directory?: string): Promise<string[]> {
    return this.disk().allFiles(directory);
  }

  static directories(directory?: string): Promise<string[]> {
    return this.disk().directories(directory);
  }

  static allDirectories(directory?: string): Promise<string[]> {
    return this.disk().allDirectories(directory);
  }

  static list(directory?: string): Promise<{ files: string[]; directories: string[] }> {
    return this.disk().list(directory);
  }

  static readStream(path: string, options?: { start?: number; end?: number }): Promise<Readable> {
    return this.disk().readStream(path, options);
  }

  static writeStream(path: string, options?: { flags?: "w" | "a" }): Promise<Writable> {
    return this.disk().writeStream(path, options);
  }

  static putStream(path: string, source: StreamSource): Promise<void> {
    return this.disk().putStream(path, source);
  }

  static size(path: string): Promise<number> {
    return this.disk().size(path);
  }

  static lastModified(path: string): Promise<Date> {
    return this.disk().lastModified(path);
  }

  static mimeType(path: string): Promise<string | undefined> {
    return this.disk().mimeType(path);
  }

  static copy(from: string, to: string): Promise<void> {
    return this.disk().copy(from, to);
  }

  static move(from: string, to: string): Promise<void> {
    return this.disk().move(from, to);
  }

  static deleteDirectory(directory: string): Promise<void> {
    return this.disk().deleteDirectory(directory);
  }

  static makeDirectory(directory: string): Promise<void> {
    return this.disk().makeDirectory(directory);
  }

  /** Symlink `link` to `original` on the default disk. Throws on a driver without links. */
  static symlink(original: string, link: string): Promise<void> {
    return this.disk().symlink(original, link);
  }

  /** Hard link `link` to `original` on the default disk. Throws on a driver without links. */
  static hardlink(original: string, link: string): Promise<void> {
    return this.disk().hardlink(original, link);
  }

  /** Whether the default disk can create links of `kind`. */
  static supportsLink(kind: "soft" | "hard"): Promise<boolean> {
    return this.disk().supportsLink(kind);
  }

  /**
   * Client-facing URL for `path` on the named (or default) disk. See
   * `StorageManager.url()` (throws for a private disk, use `path()`).
   */
  static url(path: string, disk?: string): string {
    return this.instance().url(path, disk);
  }

  /**
   * Absolute on-disk location of `path` on the named (or default) disk.
   * See `StorageManager.path()`. Laravel's `Storage::path()`.
   */
  static path(path: string, disk?: string): string {
    return this.instance().path(path, disk);
  }

  /**
   * Time-limited URL for `path` on the named (or default) disk. See
   * `StorageManager.temporaryUrl()`. Laravel's
   * `Storage::temporaryUrl()`.
   */
  static temporaryUrl(path: string, expiresIn?: number, disk?: string): Promise<string> {
    return this.instance().temporaryUrl(path, expiresIn, disk);
  }
}
