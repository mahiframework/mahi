import { Readable } from "node:stream";
import { app, type Collection } from "@mahiframework/core";
import { MediaError } from "../errors.js";
import type { MediaManager } from "../media-manager.js";
import type { MediaFile } from "../models/media-file.model.js";
import { MEDIA_TOKEN } from "../tokens.js";
import { zipStream, type ZipEntry } from "./zip-stream.js";

/** An empty archive is almost certainly a bug at the call site. */
export class EmptyArchiveError extends MediaError {
  constructor() {
    super(
      "There is nothing to put in the archive. Check the collection is not empty before " +
        "offering a download, rather than sending a zip with no entries.",
    );
  }
}

/**
 * Several media files as one downloadable archive.
 *
 *   const zip = MediaZip.of(await user.photos().get()).filename("photos.zip");
 *
 *   return new Response(zip.webStream(), {
 *     headers: {
 *       "Content-Type": "application/zip",
 *       "Content-Disposition": contentDisposition("attachment", zip.name()),
 *     },
 *   });
 *
 * Returns a STREAM, not a response, because this package does not depend
 * on `@mahiframework/http` — and because the app owns the authorization
 * and caching decisions that go on the response anyway.
 *
 * Nothing is buffered: each file is read from its disk, deflated and
 * emitted in chunks. laravel-media's equivalent builds the whole archive
 * in a temp file and loads every member into memory with
 * `addFromString`, which for a gallery download is the difference
 * between working and an OOM.
 */
export class MediaZip {
  private archiveName = "download.zip";
  private naming: (media: MediaFile, index: number) => string = (media) => media.original_filename;

  private constructor(private readonly files: readonly MediaFile[]) {}

  /** An archive of these files, in the order given. */
  static of(files: Collection<MediaFile> | readonly MediaFile[]): MediaZip {
    const all = Array.isArray(files) ? files : (files as Collection<MediaFile>).all();

    return new MediaZip(all);
  }

  /** The archive's own filename. */
  filename(name: string): this {
    this.archiveName = name.endsWith(".zip") ? name : `${name}.zip`;

    return this;
  }

  /**
   * Name entries yourself, for example to group them into folders.
   *
   *   zip.nameEntries((media) => `${media.collection}/${media.original_filename}`);
   *
   * Collisions are still de-duplicated afterwards, so a callback that
   * returns the same name twice is safe.
   */
  nameEntries(naming: (media: MediaFile, index: number) => string): this {
    this.naming = naming;

    return this;
  }

  /** The archive's filename, for a `Content-Disposition` header. */
  name(): string {
    return this.archiveName;
  }

  /** How many files the archive will contain. */
  count(): number {
    return this.files.length;
  }

  /**
   * The archive as a Node stream.
   *
   * Each entry's `open()` is called only when the writer reaches it, so
   * at most one file is in flight and a thousand-file archive holds one
   * file's worth of buffers.
   */
  stream(): Readable {
    if (this.files.length === 0) {
      throw new EmptyArchiveError();
    }

    const manager = app().make<MediaManager>(MEDIA_TOKEN);

    const entries: ZipEntry[] = this.files.map((media, index) => ({
      name: this.naming(media, index),
      modified: media.created_at.toDate(),
      open: () => manager.disk(media.disk).readStream(media.path),
    }));

    return zipStream(entries);
  }

  /** The archive as a web stream, for a `Response` body. */
  webStream(): ReadableStream<Uint8Array> {
    // `Readable.toWeb` returns node:stream/web's ReadableStream; the
    // global (DOM) one is structurally identical at runtime, and a
    // `Response` body wants the global type.
    return Readable.toWeb(this.stream()) as unknown as ReadableStream<Uint8Array>;
  }
}
