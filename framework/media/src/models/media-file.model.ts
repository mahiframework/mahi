import type { Readable } from "node:stream";
import { TempFile, app } from "@mahiframework/core";
import { Cast, Model, type BuilderFor, type DispatchesEventsMap } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";
import { MediaChecksumMismatchError } from "../errors.js";
import { MediaCreated, MediaDeleted, MediaUpdated } from "../events/media-event.js";
import { checksumStream } from "../support/checksum.js";
import { isRasterImage } from "../support/mime.js";
import { MEDIA_TOKEN } from "../tokens.js";
import type { MediaManager } from "../media-manager.js";

/**
 * One stored file: an avatar, a logo, an invoice PDF, a video.
 *
 * Named `MediaFile` rather than `Media` because every row *is* a file —
 * it has a path, a size, a mime type and a checksum — and because
 * `media` as a bare noun is a collective, which makes `Media.find(id)`
 * returning a single row read wrong. The table stays `media`: it is the
 * collection, the same relationship `ActivityLog` has with
 * `activity_logs`. `Media` is the facade.
 *
 * A row may be owned polymorphically (`model_type`/`model_id`, set by
 * `hasManyMedia`/`hasOneMedia`) or referenced by a foreign key on the
 * owner's own table (`users.avatar_id`, set by `belongsToMedia`). In the
 * second case BOTH morph columns stay null, because the owner is the one
 * holding the reference. That is why they are nullable, and why a row
 * reached only through such a key cannot be found by owner — the app
 * declares the column with `registerMediaReference()` so `media:prune`
 * can reach it.
 */
export interface MediaFileAttributes {
  /** An auto-increment key, hence `bigint`: 64-bit on every engine. */
  id: bigint;

  /**
   * The owning model's `morphAlias()`, or null for a `belongsToMedia`
   * row whose owner holds the foreign key instead.
   *
   * Null here means `media:prune` cannot find the row by owner, so
   * reclaiming it depends on the app having declared the referencing
   * column with `registerMediaReference()`.
   */
  model_type: string | null;

  /**
   * The owning model's key, stringified.
   *
   * TEXT, not a typed key column, which is the one place this schema
   * diverges from `permissions`. There `model_id` is the local side of a
   * `morphToMany` pivot whose key is bound raw, so it has to match the
   * key's type exactly — a `bigint` against a `varchar` makes Postgres
   * raise `operator does not exist` — and the cost is one key type per
   * application. Nothing here does that: the column is only read back by
   * equality through `morphMany` eager loading, which stringifies both
   * sides. Text therefore holds every key type losslessly and ANY model
   * can own media, which is what a multipurpose package owes its
   * callers. Same column and same reasoning as
   * `notifications.notifiable_id`.
   */
  model_id: string | null;

  /** A logical bucket within one owner: `"photos"`, `"attachments"`. */
  collection: string | null;

  /**
   * The storage disk, or null for "whatever the default disk is now".
   *
   * Null rather than the default's resolved name, so a row written
   * before a `storage.default` change still reads from the current
   * default — `Storage.disk(undefined)` resolves at read time. A row
   * that must pin one disk names it.
   */
  disk: string | null;

  /** Disk-relative path, including the extension. Never user-supplied. */
  path: string;

  /**
   * The name the file had when it arrived, used for downloads and zip
   * entries.
   *
   * Deliberately NOT part of `path`. Keeping a user-supplied name off
   * the filesystem is what stops `../../etc/passwd` and friends from
   * ever being a question, and it means two users uploading `photo.jpg`
   * do not collide.
   */
  original_filename: string;

  /**
   * Size in bytes of the file as stored, after any modifiers ran.
   *
   * A `number`, though the column is an `unsignedBigInteger` and the
   * driver hands back a `bigint`. `Cast.integer()` narrows it, because
   * `JSON.stringify` throws on a `bigint` — deliberately — and a media
   * row is exactly the thing an application serialises into an API
   * response. The precision lost is above 2^53 bytes, which is nine
   * petabytes in one file.
   */
  size: number;

  /** Sniffed from the file's leading bytes, never from the client. */
  mime_type: string;

  /** No leading dot. May be `""` for a file with no discernible type. */
  extension: string;

  checksum_hash: string;
  /** The algorithm `checksum_hash` was produced with, e.g. `"sha256"`. */
  checksum_algo: string;

  /** Pixel dimensions, for images only. Null for every other type. */
  image_width: number | null;
  image_height: number | null;

  /** Position within a collection. 1-indexed; 0 means unordered. */
  order: number;

  /** Application-defined metadata: alt text, captions, EXIF. */
  custom_properties: Record<string, unknown> | null;

  created_at: DateTime;
  updated_at: DateTime;
}

/**
 * The `media` table's model.
 *
 * The key is a plain auto-increment `bigint`, assigned by the database.
 *
 * `morphName` is not decoration. `morphAlias()` otherwise falls back to
 * the table name, and the queue codec throws at dispatch for a `Model`
 * field on a job whose class has none.
 *
 * Reads and writes inside this package go through `mediaModels.media`,
 * never through this class directly, so an application can swap in a
 * subclass. See `models/registry.ts`.
 */
export class MediaFile extends Model<MediaFileAttributes>()({
  table: "media",
  primaryKey: "id",
  morphName: "MediaFile",
  casts: {
    // `size` is an `unsignedBigInteger`, so the driver returns a
    // `bigint`. See the attribute's docstring for why it must not stay
    // one.
    size: Cast.integer(),
    custom_properties: Cast.json<Record<string, unknown>>(),
    created_at: Cast.datetime(),
    updated_at: Cast.datetime(),
  },
}) {
  /**
   * Fire this package's own events alongside the generic
   * `ModelCreated`/`ModelUpdated`/`ModelDeleted` ones.
   *
   * A static, NOT a key in the `Model<A>()({ ... })` config — the config
   * object has no such field, so putting it there compiles and is
   * silently ignored.
   *
   * `created`/`updated`/`deleted` only. There is no `MediaRetrieved`,
   * which would fire on every row read, and no `-ing` events: a
   * `MediaCreating` listener could not see the file, because the bytes
   * are written before the row is inserted.
   */
  static override dispatchesEvents: DispatchesEventsMap = {
    created: MediaCreated,
    updated: MediaUpdated,
    deleted: MediaDeleted,
  };

  /**
   * Delete the stored file when the row goes.
   *
   * In `deleting`, not a listener on `MediaDeleted`, for two reasons.
   * The hook still has the loaded row, so `disk` and `path` are
   * readable — a `deleted` payload for a row nothing preloaded is only
   * `{ id }`. And it runs inside whatever transaction the caller opened,
   * so a rollback leaves the file in place; a listener firing afterwards
   * would have deleted the bytes for a row that came back.
   *
   * Registered here rather than in the provider so it applies however
   * the row is deleted: `deleteInstance()`, a static `delete()`, a
   * relation write, or a subclass. `static boot()` is the one-time
   * per-class hook and is NOT chained to `super.boot()`.
   *
   * A failed file delete does not fail the row delete. The row is the
   * record of intent, the file is a side effect, and a vanished mount
   * must not make a record undeletable — `media:prune --files` reclaims
   * what is left.
   */
  static override boot(): void {
    this.on("deleting", async (media) => {
      // The payload is the loaded row when the caller had one, and a
      // bare `{ [primaryKey]: id }` when nothing preloaded it. Only the
      // first names a file to delete; the row is removed either way, and
      // `media:prune --files` reclaims the bytes in the second case.
      const path: unknown = media.path;

      if (typeof path !== "string" || path === "") {
        return;
      }

      const disk: unknown = media.disk;

      await mediaManager().deleteFile(typeof disk === "string" ? disk : null, path);
    });
  }

  /**
   * Every file owned by one record, in collection order.
   *
   * Pass `Post.morphAlias()` rather than a literal, so a later morph-map
   * change moves both sides at once.
   */
  static for(
    modelType: string,
    modelId: string | number | bigint,
  ): BuilderFor<MediaFileAttributes, MediaFile> {
    return this.query()
      .where("model_type", modelType)
      .where("model_id", String(modelId))
      .orderBy("order", "asc");
  }

  /** One collection across every owner, in collection order. */
  static inCollection(collection: string): BuilderFor<MediaFileAttributes, MediaFile> {
    return this.query().where("collection", collection).orderBy("order", "asc");
  }

  /**
   * A public URL for this file.
   *
   * THROWS on a private disk. That is `@mahiframework/storage`'s
   * contract, not this package's embellishment, and the message it
   * raises names the fix. Call `isPublic()` first to branch, or
   * `temporaryUrl()` for a signed link that works either way.
   */
  url(): string {
    return this.manager().disk(this.disk).url(this.path);
  }

  /**
   * A signed, expiring URL for this file.
   *
   * Works on a private disk, which is the point. S3 presigns natively; a
   * local disk needs `temporaryUrls: true` in its own storage config and
   * otherwise rejects rather than minting a link that would 404.
   */
  temporaryUrl(expiresIn?: number): Promise<string> {
    return this.manager().disk(this.disk).temporaryUrl(this.path, expiresIn);
  }

  /** Whether this file's disk serves public URLs. */
  isPublic(): boolean {
    return this.manager().isPublic(this.disk);
  }

  /**
   * Whether an image driver could decode this file.
   *
   * Derived from the sniffed `mime_type`, never the extension. SVG is
   * excluded: it is an image to a browser and a text document to a
   * decoder. See `support/mime.ts`.
   */
  isImage(): boolean {
    return isRasterImage(this.mime_type);
  }

  /** The whole file, in memory. Prefer `readStream()` for large ones. */
  contents(): Promise<Buffer> {
    return this.manager().disk(this.disk).get(this.path);
  }

  /**
   * A stream over the file's bytes.
   *
   * `start`/`end` are inclusive byte offsets, so an HTTP `Range` maps
   * straight through.
   */
  readStream(options?: { start?: number; end?: number }): Promise<Readable> {
    return this.manager().disk(this.disk).readStream(this.path, options);
  }

  /**
   * Copy this file to a local scratch file and return it.
   *
   * For tools that cannot read a remote disk — you cannot hand an S3 key
   * to `ffmpeg`. The caller owns the result: scope it with `await using`
   * or `delete()` it. Nothing leaks either way, since `TempFile` sweeps
   * on process exit.
   */
  async toTempFile(): Promise<TempFile> {
    return TempFile.fromStream(await this.readStream(), this.extension);
  }

  /**
   * Verify the stored file against its recorded checksum.
   *
   * Streamed, not buffered: a checksum exists to detect a file changing
   * underneath us, and reading a 5GB video into memory to find out would
   * make verification the most expensive thing here.
   *
   * ON SUCCESS, THE ALGORITHM SELF-HEALS. A row hashed under an older
   * algorithm than the one now configured is rehashed and saved, because
   * the file has just been proven intact — which makes changing
   * `hashing.algorithm` a background migration rather than a flag day.
   * laravel-media does the same and it is the best idea in its hashing
   * code.
   *
   * Throws `MediaChecksumMismatchError` on a mismatch rather than
   * returning false: a file that does not match its checksum has been
   * modified or replaced out of band, and a boolean invites a caller to
   * ignore it.
   */
  async verify(): Promise<void> {
    const actual = await checksumStream(await this.readStream(), this.checksum_algo);

    if (actual !== this.checksum_hash) {
      throw new MediaChecksumMismatchError(
        String(this.id),
        this.checksum_algo,
        this.checksum_hash,
        actual,
      );
    }

    const configured = this.manager().config.hashAlgorithm;

    if (configured !== this.checksum_algo) {
      await this.refreshChecksum(configured);
    }
  }

  /**
   * Rehash the stored file and save the new digest.
   *
   * Call after replacing a file's bytes out of band. `verify()` calls it
   * for the algorithm-upgrade case.
   */
  async refreshChecksum(algorithm?: string): Promise<void> {
    const using = algorithm ?? this.manager().config.hashAlgorithm;

    this.checksum_hash = await checksumStream(await this.readStream(), using);
    this.checksum_algo = using;

    await this.save();
  }

  /** One custom property, or undefined. */
  getCustomProperty<T = unknown>(key: string): T | undefined {
    return this.custom_properties?.[key] as T | undefined;
  }

  /**
   * Set one custom property. Does NOT save.
   *
   * Unsaved so a caller can set several and write once. Returns `this`
   * for chaining, matching laravel-media's
   * `setCustomProperty(...)->save()`.
   */
  setCustomProperty(key: string, value: unknown): this {
    this.custom_properties = { ...(this.custom_properties ?? {}), [key]: value };

    return this;
  }

  /** Whether a custom property is present, including when its value is null. */
  hasCustomProperty(key: string): boolean {
    return this.custom_properties !== null && key in this.custom_properties;
  }

  /** Remove one custom property. Does NOT save. */
  forgetCustomProperty(key: string): this {
    if (this.custom_properties === null) {
      return this;
    }

    const remaining = { ...this.custom_properties };

    delete remaining[key];
    this.custom_properties = remaining;

    return this;
  }

  /**
   * The media manager, resolved per call.
   *
   * Not held on the instance: a model is hydrated by the ORM with no
   * container in scope, and caching a manager on a row would pin the
   * application that happened to be current when it was read — which
   * breaks in tests, where each case builds its own.
   */
  private manager(): MediaManager {
    return mediaManager();
  }
}

/**
 * The media manager for the current application.
 *
 * A module function rather than only a method, because the `deleting`
 * hook receives a payload that may not be a loaded model and so cannot
 * call one.
 */
function mediaManager(): MediaManager {
  return app().make<MediaManager>(MEDIA_TOKEN);
}
