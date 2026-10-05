/**
 * A decoded image, held by whichever driver produced it.
 *
 * OPAQUE ON PURPOSE. The branded `__image` field is never read; it
 * exists so the type is not structurally `{}`, which would make every
 * object assignable to it. A driver puts its own native handle inside —
 * a `sharp` instance, a canvas, an ImageMagick wand — and this package
 * never names that type, which is what keeps it free of any image
 * dependency.
 *
 * Handles are opaque but not interchangeable: passing one driver's
 * handle to another is a programming error no type can catch, and a
 * driver that receives a foreign handle should fail rather than guess.
 */
export interface ImageHandle {
  readonly __image: unknown;
}

/**
 * One transformation, as data rather than code.
 *
 * This is the whole reason modifiers are portable. A `resizeDown(200)`
 * does not know how to resize anything — it emits `{ type: "scaleDown",
 * width: 200 }` and a driver executes it. Swapping the driver swaps the
 * implementation of every modifier at once, the way `gd` and `imagick`
 * both implement the same operations in PHP.
 *
 * Deliberately a closed union. An open `{ type: string, ...args }` would
 * let an app invent operations no driver implements, and the failure
 * would be at runtime in the driver rather than at the call site.
 */
export type ImageOp = ScaleDownOp | CropOp | FillOp | PlaceOp | RotateOp;

/**
 * Shrink to fit inside the given bounds, preserving aspect ratio.
 *
 * NEVER ENLARGES, which is what distinguishes it from a plain resize: a
 * 200×200 avatar asked to fit 2000×2000 stays 200×200 rather than being
 * upscaled into a blurry mess. Omitting one dimension bounds only the
 * other.
 */
export interface ScaleDownOp {
  type: "scaleDown";
  width?: number;
  height?: number;
}

/** Take a rectangle out of the image. Offsets are from the top left. */
export interface CropOp {
  type: "crop";
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Flood the whole canvas with a colour, discarding what was there. */
export interface FillOp {
  type: "fill";
  /** A CSS colour string. Drivers must accept `#rgb`/`#rrggbb` at least. */
  color: string;
}

/** Composite another image on top of this one. */
export interface PlaceOp {
  type: "place";
  image: ImageHandle;
  x: number;
  y: number;
}

/** Rotate clockwise by whole degrees. */
export interface RotateOp {
  type: "rotate";
  degrees: number;
}

/** Every operation name, for a driver's `supports()` and for tests. */
export const IMAGE_OPS = ["scaleDown", "crop", "fill", "place", "rotate"] as const;

export type ImageOpType = (typeof IMAGE_OPS)[number];

/** How a modified image should be written back out. */
export interface EncodeOptions {
  /**
   * The target format, as a bare extension (`"webp"`, `"jpg"`).
   *
   * An extension rather than a MIME type because that is what a driver's
   * encoder selection keys on in practice, and because the result is
   * also the stored file's extension.
   */
  format: string;

  /**
   * Lossy quality, 1–100. Ignored by formats that have no such notion.
   *
   * Not defaulted here. A driver picks its own sensible default when
   * this is undefined, because the right number differs per format and
   * per encoder — 82 is a good JPEG and a wasteful WebP.
   */
  quality?: number;
}

/**
 * What an image library has to provide for the generic modifiers to work.
 *
 * Six methods, which is deliberately few. Everything expressive lives in
 * `ImageOp`, so adding a modifier does not change this interface and a
 * driver written today keeps working when one is added — it will simply
 * report `supports()` false for an operation it has never heard of.
 *
 * Drivers live in their own packages (`@mahiframework/media-sharp`), so
 * `@mahiframework/media` itself has no image dependency and stays useful
 * for documents, video and arbitrary uploads. That mirrors how
 * `@mahiframework/storage` ships only a local disk and leaves S3, SFTP
 * and FTP to their own packages, each declaring its heavy library as an
 * optional peer.
 *
 * A driver may expose more than this. Its own package can export
 * modifiers that reach for native features the generic ops cannot
 * express — the escape hatch for "I need exactly this sharp call".
 */
export interface ImageDriver {
  /** Decode bytes into a handle. Throws if they are not a readable image. */
  read(bytes: Uint8Array): Promise<ImageHandle>;

  /**
   * A new blank canvas.
   *
   * Needed by `setBackgroundColor`, which fills a canvas and composites
   * the original over it — the only way to flatten transparency without
   * an alpha-aware blend operation.
   */
  create(width: number, height: number): Promise<ImageHandle>;

  /**
   * Apply one operation, returning the result.
   *
   * Returns a handle rather than mutating, so a driver may be either
   * immutable or in-place. An in-place driver returns the same handle it
   * was given; callers must use the return value regardless.
   *
   * Must throw `UnsupportedImageOpError` for an operation it cannot
   * perform, never silently no-op. laravel-media's pipeline drops
   * modifiers it does not recognise, which produces an unmodified image
   * and no indication why — the kind of failure found via a user's
   * screenshot.
   */
  apply(image: ImageHandle, op: ImageOp): Promise<ImageHandle>;

  /** Encode back to bytes. */
  encode(image: ImageHandle, options: EncodeOptions): Promise<Uint8Array>;

  /** Current pixel dimensions, after whatever operations have run. */
  dimensions(image: ImageHandle): Promise<{ width: number; height: number }>;

  /**
   * Whether this driver implements an operation.
   *
   * Lets a modifier fail at the point of use with a message naming both
   * the driver and the operation, instead of the driver throwing from
   * somewhere deeper.
   */
  supports(op: ImageOpType): boolean;
}
