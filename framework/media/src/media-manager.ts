import { STORAGE_TOKEN, type Application } from "@mahiframework/core";
import type { StorageDriver, StorageManager } from "@mahiframework/storage";
import type { ResolvedMediaConfig } from "./media-config.js";

/**
 * The service behind `MEDIA_TOKEN`: everything that needs config or a
 * disk and is not a property of a single row.
 *
 * Uploads, deletes and the attach helpers land here in later phases. For
 * now it owns the two things every one of them needs — the resolved
 * config, and disk resolution — which is also what keeps
 * `MediaFile.url()` and friends from each having to resolve storage
 * themselves.
 *
 * Takes `app` rather than a `StorageManager` so storage is resolved
 * lazily, per call. `MediaServiceProvider` may legally be registered
 * before `StorageServiceProvider` in `config/app.ts` — the ordering
 * constraint is on `boot()`, not `register()` — and resolving in the
 * constructor would turn a provider-order mistake into a boot failure
 * instead of a clear error at first use.
 */
export class MediaManager {
  constructor(
    private readonly app: Application,
    readonly config: ResolvedMediaConfig,
  ) {}

  /**
   * The driver for `disk`, or for the configured media disk when
   * omitted, or the storage default when that is unset too.
   *
   * The `null`/`undefined` collapse is deliberate: a media row stores
   * `null` for "the default disk", and `Storage.disk(undefined)`
   * resolves the default at read time. Threading the null through means
   * a row written before a `storage.default` change still reads from
   * whatever the default is now, rather than from a name frozen at
   * upload.
   */
  disk(disk?: string | null): StorageDriver {
    return this.storage().disk(disk ?? this.config.disk ?? undefined);
  }

  /** The disk name to stamp on a new row, or null for "the default". */
  diskName(disk?: string | null): string | null {
    return disk ?? this.config.disk ?? null;
  }

  /**
   * Whether files on `disk` have public URLs.
   *
   * Reads the disk's `url` config key rather than calling `url()` and
   * catching, because `url()` THROWS on a private disk — that is
   * storage's contract, and the message is good, but it makes it useless
   * as a predicate. `diskConfig()` is public on the manager and
   * `DiskConfig` carries an index signature, so this works for every
   * driver rather than only `local`.
   *
   * This is the whole of what laravel-media's `config('media.public_disks')`
   * bought, without a second list of disks to disagree with the real one.
   */
  isPublic(disk?: string | null): boolean {
    const name = this.diskName(disk) ?? this.storage().getDefaultDriver();
    const config = this.storage().diskConfig<{ url?: string } | undefined>(name);

    return typeof config?.url === "string" && config.url !== "";
  }

  private storage(): StorageManager {
    return this.app.make<StorageManager>(STORAGE_TOKEN);
  }
}
