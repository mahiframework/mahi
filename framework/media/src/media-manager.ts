import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { STORAGE_TOKEN, Str, type Application } from "@mahiframework/core";
import type { StorageDriver, StorageManager } from "@mahiframework/storage";
import { MediaTooLargeError, UnacceptableMediaTypeError } from "./errors.js";
import type { ImageManager } from "./image/image-manager.js";
import { resolveAccept, type ResolvedAccept, type ResolvedMediaConfig } from "./media-config.js";
import { resolveSource, type MediaSource, type ResolvedSource } from "./media-source.js";
import { mediaModels } from "./models/registry.js";
import type { MediaFile } from "./models/media-file.model.js";
import type { MediaModifier } from "./pipeline/modifier.js";
import { runModifiers } from "./pipeline/run-modifiers.js";
import { checksum, checksumStream } from "./support/checksum.js";
import {
  DEFAULT_MIME_TYPE,
  extensionForMimeType,
  isRasterImage,
  mimeTypeForExtension,
} from "./support/mime.js";
import { PathGenerator, sanitiseFilename } from "./support/path-generator.js";
import { looksExecutable, resolveMimeType } from "./support/sniff.js";
import { IMAGE_TOKEN } from "./tokens.js";

/**
 * Bytes ready to be written, after any modifiers.
 *
 * Exactly one of `bytes`/`path` is set, the same contract
 * `ResolvedSource` has — a transformed image is always buffered, an
 * untransformed stream stays on disk.
 */
interface StorablePayload {
  bytes: Uint8Array | undefined;
  path: string | undefined;
  size: number;
  mimeType: string;
  extension: string;
  width: number | null;
  height: number | null;
}

/** Everything `add()` can be told about one file. */
export interface AddMediaOptions {
  /** The owning record, as a morph alias and key. */
  owner?: { type: string; id: string | number | bigint };
  collection?: string | null;
  /** The disk to write to. Null or omitted means the configured default. */
  disk?: string | null;
  /** A path prefix under the disk root, overriding config. */
  path?: string | null;
  /** Override the stored download name. Sanitised either way. */
  filename?: string;
  /** Position within a collection. */
  order?: number;
  customProperties?: Record<string, unknown> | null;
  /** Narrows what is allowed, on top of the app-wide config floor. */
  accept?: ResolvedAccept;
  /**
   * Transformations applied to the image before it is stored.
   *
   * Ignored for anything that is not a raster image — the package is
   * multipurpose, and a PDF must never reach an image driver. Resolving
   * a driver at all is deferred until there is an image to transform,
   * so an app that stores only documents never needs one installed.
   */
  modifiers?: readonly MediaModifier[];
}

/**
 * The service behind `MEDIA_TOKEN`: everything that needs config or a
 * disk and is not a property of a single row.
 *
 * Takes `app` rather than a `StorageManager` so storage is resolved
 * lazily, per call. `MediaServiceProvider` may legally be registered
 * before `StorageServiceProvider` in `config/app.ts` — the ordering
 * constraint is on `boot()`, not `register()` — and resolving in the
 * constructor would turn a provider-order mistake into a boot failure
 * instead of a clear error at first use.
 */
export class MediaManager {
  private readonly paths: PathGenerator;

  constructor(
    private readonly app: Application,
    readonly config: ResolvedMediaConfig,
  ) {
    this.paths = new PathGenerator(config.pathNesting);
  }

  /**
   * Store a file and record it.
   *
   * THE ORDER HERE IS THE CONTRACT. Validate, then write the file, then
   * insert the row — so a rejected upload touches neither, and a failed
   * write leaves no row pointing at a file that is not there. The
   * reverse (row first) would make every reader handle a row whose file
   * never arrived, which is a state nothing can repair.
   *
   * The opposite failure, a file with no row, is possible: the write
   * succeeds and the insert fails. That one is recoverable — the bytes
   * are orphaned, `media:prune --files` reclaims them — and it is the
   * right way round to be broken.
   *
   * Every type decision comes from the file's own bytes. See
   * `support/sniff.ts` for why the client's `Content-Type` is not
   * evidence.
   */
  async add(source: MediaSource, options: AddMediaOptions = {}): Promise<MediaFile> {
    const resolved = await resolveSource(source);

    try {
      const accept = options.accept ?? this.config.accept;
      const identified = this.identify(resolved, options.filename);

      this.assertAcceptable(resolved, identified.mimeType, identified.extension, accept);

      // Modifiers run BEFORE the path is generated and before anything
      // is written, so the stored file's extension, size, mime type,
      // dimensions and checksum all describe the bytes that actually
      // land on the disk. laravel-media transforms AFTER writing and
      // then overwrites the original at its old path, which leaves a
      // `.png` file whose row claims `webp`.
      const transformed = await this.transform(resolved, identified, options.modifiers ?? []);

      const disk = this.diskName(options.disk);
      const prefix = options.path ?? this.config.path;
      const path = this.paths.generate(transformed.extension, prefix);

      await this.write(this.disk(disk), path, transformed);

      const algorithm = this.config.hashAlgorithm;

      return await mediaModels.media.create({
        model_type: options.owner?.type ?? null,
        model_id: options.owner === undefined ? null : String(options.owner.id),
        collection: options.collection ?? null,
        disk,
        path,
        original_filename: sanitiseFilename(
          options.filename ??
            resolved.filename ??
            `file${transformed.extension === "" ? "" : `.${transformed.extension}`}`,
        ),
        size: transformed.size,
        mime_type: transformed.mimeType,
        extension: transformed.extension,
        checksum_hash: await this.hash(transformed, algorithm),
        checksum_algo: algorithm,
        image_width: transformed.width,
        image_height: transformed.height,
        order: options.order ?? 0,
        custom_properties: options.customProperties ?? null,
      });
    } finally {
      // A drained stream left a scratch file behind. Released whether or
      // not the upload succeeded, so a rejected 2GB video does not sit
      // in the temp directory until the process exits.
      await resolved.release();
    }
  }

  /**
   * Delete a row and its file.
   *
   * The file is removed by the model's `deleting` hook rather than here,
   * so deleting through `MediaFile.deleteInstance()`, a relation, or a
   * cascade all clean up too — not only the calls that come through this
   * method.
   */
  async delete(media: MediaFile): Promise<void> {
    await media.deleteInstance();
  }

  /** Remove a stored file, tolerating one that is already gone. */
  async deleteFile(disk: string | null, path: string): Promise<void> {
    try {
      await this.disk(disk).delete(path);
    } catch {
      // A missing file is the desired end state. Storage's `delete()`
      // already uses `force`, so this guards against a vanished mount or
      // a permission change, neither of which should fail a row delete.
    }
  }

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

  /**
   * Decide what a file is, from its bytes first and its name second.
   *
   * The extension follows from the resolved MIME type rather than from
   * the upload's own name, so a PNG called `report.pdf` is stored as
   * `.png`. Only when the type is unknown does the supplied name's
   * extension stand in — which is the text-format case (CSV, SVG,
   * Markdown), none of which has a magic number.
   */
  private identify(
    resolved: ResolvedSource,
    override: string | undefined,
  ): { mimeType: string; extension: string } {
    const name = override ?? resolved.filename ?? "";
    const named = name.includes(".") ? (name.split(".").pop() ?? "") : "";
    const mimeType = resolveMimeType(resolved.head, mimeTypeForExtension(named));

    if (mimeType === DEFAULT_MIME_TYPE) {
      // Nothing recognised the bytes and the name said nothing either.
      // An empty extension is honest, and the column allows it.
      return { mimeType, extension: named.toLowerCase() };
    }

    return { mimeType, extension: extensionForMimeType(mimeType) ?? named.toLowerCase() };
  }

  /**
   * Reject anything the collection does not accept, before writing.
   *
   * Checked in cost order: size first (one comparison), then the
   * executable sniff, then the type lists.
   */
  private assertAcceptable(
    resolved: ResolvedSource,
    mimeType: string,
    extension: string,
    accept: ResolvedAccept,
  ): void {
    if (accept.maxBytes !== null && resolved.size > accept.maxBytes) {
      throw new MediaTooLargeError(resolved.size, accept.maxBytes);
    }

    // Refused unconditionally, not merely when the type lists exclude
    // it. A file whose bytes begin `<?php` sniffs as nothing, so a
    // MIME-only check would admit it on its extension's word — and on a
    // public disk served by anything that executes PHP, that is remote
    // code execution. An app that genuinely wants to store scripts
    // stores them as text through its own path, not through an upload
    // endpoint.
    if (looksExecutable(resolved.head)) {
      throw new UnacceptableMediaTypeError(mimeType, extension);
    }

    if (accept.mimes.length === 0 && accept.extensions.length === 0) {
      return;
    }

    // OR semantics, matching laravel-media: satisfying either list is
    // enough. `Str.is` gives the globs, so `image/*` works — its
    // `acceptTypes` is exact-match only, even though its own generator
    // registry globs for the same kind of lookup.
    const mimeOk = accept.mimes.length > 0 && Str.is(accept.mimes, mimeType.toLowerCase());
    const extensionOk =
      accept.extensions.length > 0 && accept.extensions.includes(extension.toLowerCase());

    if (!mimeOk && !extensionOk) {
      throw new UnacceptableMediaTypeError(mimeType, extension);
    }
  }

  /**
   * Run the modifier chain, if there is one and the file is an image.
   *
   * Three conditions, each load-bearing. No modifiers means no work. A
   * non-image means no work EITHER — this package stores documents and
   * video, and handing a PDF to an image decoder would fail an upload
   * that should simply have been stored. And only then is an image
   * driver resolved, so an app that never transforms an image never
   * needs one installed.
   *
   * A transformed image is always buffered. It has just been through a
   * decoder, which held the whole raster in memory anyway, so streaming
   * the encoded result would save nothing.
   */
  private async transform(
    resolved: ResolvedSource,
    identified: { mimeType: string; extension: string },
    modifiers: readonly MediaModifier[],
  ): Promise<StorablePayload> {
    if (modifiers.length === 0 || !isRasterImage(identified.mimeType)) {
      return {
        bytes: resolved.bytes,
        path: resolved.path,
        size: resolved.size,
        mimeType: identified.mimeType,
        extension: identified.extension,
        width: null,
        height: null,
      };
    }

    const images = this.app.make<ImageManager>(IMAGE_TOKEN);
    const driverName = images.getDefaultDriver();
    const bytes = resolved.bytes ?? (await readFile(this.requirePath(resolved)));

    const result = await runModifiers(
      images.driver(driverName),
      driverName,
      bytes,
      identified.mimeType,
      modifiers,
    );

    return {
      bytes: result.bytes,
      path: undefined,
      size: result.bytes.byteLength,
      mimeType: result.mimeType,
      extension: result.extension,
      width: result.width,
      height: result.height,
    };
  }

  /** Write the payload, buffered or streamed. */
  private async write(
    driver: StorageDriver,
    path: string,
    payload: StorablePayload,
  ): Promise<void> {
    if (payload.bytes !== undefined) {
      await driver.put(path, Buffer.from(payload.bytes));

      return;
    }

    await driver.putStream(path, createReadStream(this.requirePath(payload)));
  }

  /** Hash the payload, streaming when it was never buffered. */
  private async hash(payload: StorablePayload, algorithm: string): Promise<string> {
    if (payload.bytes !== undefined) {
      return checksum(payload.bytes, algorithm);
    }

    return checksumStream(createReadStream(this.requirePath(payload)), algorithm);
  }

  /**
   * The local path of a payload that was not buffered.
   *
   * `resolveSource()` guarantees exactly one of `bytes`/`path`, so this
   * is unreachable — but asserting it beats a `!` that would turn the
   * impossible into an `undefined` passed to `createReadStream`.
   */
  private requirePath(payload: { bytes?: Uint8Array; path?: string }): string {
    if (payload.path === undefined) {
      throw new Error("The resolved media source has neither bytes nor a local path.");
    }

    return payload.path;
  }

  private storage(): StorageManager {
    return this.app.make<StorageManager>(STORAGE_TOKEN);
  }
}

/** Re-exported so a collection can narrow the app-wide floor. */
export { resolveAccept };
