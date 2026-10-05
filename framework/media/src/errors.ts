/**
 * Base class for every error this package throws, so an app can catch
 * the whole family in one `catch` when it would rather render a generic
 * upload failure than discriminate.
 */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A file was rejected by the `accept()` constraints on a collection.
 *
 * Thrown before a single byte reaches the disk, so a rejected upload
 * leaves nothing behind to clean up. Carries the sniffed type rather than
 * the client-supplied one, because that is what was actually judged.
 */
export class UnacceptableMediaTypeError extends MediaError {
  constructor(
    readonly mimeType: string,
    readonly extension: string,
  ) {
    super(
      `A file of type "${mimeType}" (.${extension}) is not accepted here. ` +
        `Widen the collection's accept({ mimes, extensions }) to allow it.`,
    );
  }
}

/**
 * A file exceeded the collection's `maxBytes`.
 *
 * Separate from `UnacceptableMediaTypeError` because the remedy is
 * different and a caller usually wants to say so: the wrong *type* is the
 * user picking the wrong file, the wrong *size* is the right file being
 * too big.
 */
export class MediaTooLargeError extends MediaError {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(
      `This file is ${size} bytes, which exceeds the ${maxBytes} byte limit for this collection.`,
    );
  }
}

/**
 * A stored file's checksum does not match the one recorded on its row.
 *
 * Raised only by `verify()` and `media:check --verify`, never on a plain
 * read: verification costs a full read of the file, so it is opt-in and
 * explicit rather than something every download pays for.
 */
export class MediaChecksumMismatchError extends MediaError {
  constructor(
    readonly mediaId: string,
    readonly algorithm: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Media ${mediaId} should have ${algorithm} checksum ${expected} but the stored file ` +
        `hashes to ${actual}. The file has been modified or replaced out of band.`,
    );
  }
}

/**
 * A modifier needed an image driver and none is configured.
 *
 * `@mahiframework/media` ships no image library on purpose, so this is
 * the expected state for an app that stores documents and then adds its
 * first thumbnail. The message therefore has to name the fix, not just
 * the problem.
 */
export class NoImageDriverError extends MediaError {
  constructor() {
    super(
      `No image driver is configured, so image modifiers cannot run. Install one ` +
        `(e.g. \`npm install @mahiframework/media-sharp\`), register its service provider, ` +
        `and set \`image: { default: "sharp" }\` in config/media.ts.`,
    );
  }
}

/**
 * The configured driver cannot perform an operation a modifier asked for.
 *
 * Thrown rather than skipped. laravel-media's pipeline silently drops
 * modifiers it does not recognise, which yields an unmodified image and
 * no indication why — a failure you find out about from a user's
 * screenshot.
 */
export class UnsupportedImageOpError extends MediaError {
  constructor(
    readonly driver: string,
    readonly op: string,
  ) {
    super(
      `The "${driver}" image driver does not support the "${op}" operation. ` +
        `Use a driver that does, or drop the modifier that needs it.`,
    );
  }
}

/**
 * The bytes could not be decoded as an image.
 *
 * Distinct from `UnacceptableMediaTypeError`, which is about a file the
 * collection refuses. This is a file that passed the accept rules,
 * sniffed as an image, and still would not decode — a truncated upload,
 * or a format the driver was built without.
 */
export class UndecodableImageError extends MediaError {
  constructor(
    readonly mimeType: string,
    options?: { cause?: unknown },
  ) {
    super(`The image could not be decoded as ${mimeType}. It may be truncated or corrupt.`);
    this.cause = options?.cause;
  }
}

/**
 * The source file could not be read.
 *
 * Covers a path that does not exist, a stream that failed mid-read, and a
 * `File` whose backing blob has been revoked. One error rather than three
 * because the caller's remedy is the same in every case and the message
 * carries the detail.
 */
export class UnreadableMediaSourceError extends MediaError {
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`The media source could not be read: ${reason}`);
    this.cause = options?.cause;
  }
}
