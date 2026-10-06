import {
  IMAGE_OPS,
  UnsupportedImageOpError,
  type EncodeOptions,
  type ImageDriver,
  type ImageHandle,
  type ImageOp,
  type ImageOpType,
} from "@mahiframework/media";
import type { Channels } from "sharp";
import { encodeOptionsFor, normaliseFormat, sharpFormat } from "./encode-options.js";
import { AnimatedImageError } from "./errors.js";
import { loadSharp, type SharpModule, type SharpPipeline } from "./sharp-loader.js";

/**
 * Teach `MediaConfig` about this driver's own config block.
 *
 * DECLARATION MERGING, not a change to `@mahiframework/media`. An app's
 * `config/media.ts` is typed as `MediaConfig`, so without this a `sharp`
 * key is a type error — and `media` cannot declare the key itself
 * without naming a driver it deliberately does not depend on.
 *
 * Exactly the mechanism `@mahiframework/core` uses for `ProviderHooks`:
 * an optional package augments a type in the package it extends, and an
 * app that does not install this one never sees the key. Importing
 * anything from `@mahiframework/media-sharp` is what brings it into
 * scope, which the provider import already does.
 */
declare module "@mahiframework/media" {
  interface MediaConfig {
    /** Options for the sharp image driver. Every field has a default. */
    sharp?: SharpConfig;
  }
}

/** The `"media.sharp"` config namespace. Every field has a default. */
export interface SharpConfig {
  /**
   * The decompression-bomb guard, in pixels. Defaults to sharp's own
   * 268 megapixels (`16383 * 16383`).
   *
   * WORTH LOWERING FOR USER UPLOADS. A 60-megapixel PNG is a few hundred
   * kilobytes on the wire and 240 MB of raw pixels once decoded — and
   * because this driver materialises raw pixels between every operation
   * (see the class docstring), it holds exactly that, twice, per op.
   * `media`'s `accept.maxBytes` cannot catch it, because the FILE is
   * small; only a pixel bound can.
   *
   * An app accepting uploads from the public should set something like
   * `50_000_000`, which still allows an 8000x6000 photo.
   */
  limitInputPixels?: number;

  /**
   * Apply EXIF orientation on read. Defaults to `true`.
   *
   * A phone photo is stored in whatever orientation the sensor read it
   * and carries a tag saying how to turn it. Ignoring the tag produces
   * sideways thumbnails — the bug every image pipeline ships once — and
   * it also corrupts geometry: `cropToSquare()` measures the image to
   * decide its crop, so an unrotated portrait gets cropped as though it
   * were landscape.
   *
   * Turn it off only if the application applies orientation itself.
   */
  autoOrient?: boolean;

  /**
   * Accept animated input and flatten it to its first frame, instead of
   * throwing `AnimatedImageError`. Defaults to `false`.
   *
   * The default refuses because flattening an animation is silent data
   * loss (see `AnimatedImageError`). Set this when a still IS the
   * intent — an avatar pipeline that should accept an animated GIF and
   * produce a static WebP — so the flattening is a decision on the
   * record rather than an accident.
   */
  allowAnimated?: boolean;
}

/**
 * Marks our own state objects, so a foreign handle is detectable.
 *
 * A symbol rather than duck-typing on field names, which is what
 * `FakeImageDriver` has to do (it predates any other driver). Two
 * drivers that both keep a `width` and a `height` would be
 * indistinguishable structurally, and mistaking one for the other means
 * reading another driver's object as a pixel buffer.
 */
const STATE = Symbol("mahi.media-sharp.state");

/**
 * The raw-pixel state behind every handle this driver issues.
 *
 * Not a `sharp` instance. That is the single most important decision in
 * this package and the class docstring explains it.
 */
interface SharpImageState {
  readonly [STATE]: true;
  /** Uncompressed pixels, `width * height * channels` bytes. */
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  /**
   * 1 (greyscale), 2 (greyscale+alpha), 3 (RGB) or 4 (RGBA).
   *
   * sharp's own union rather than `number`, because it is what both
   * `OutputInfo.channels` produces and `Raw.channels` consumes — the two
   * ends of every materialisation. Typing it as `number` would need a
   * cast at each one, which is exactly where a 5 would get through.
   */
  readonly channels: Channels;
}

interface SharpImageHandle extends ImageHandle {
  readonly __image: SharpImageState;
}

/**
 * An `ImageDriver` backed by sharp (libvips).
 *
 * This is the package that makes `resizeDown()` do something — the
 * `imagick` to `media`'s `gd`, in the Laravel framing the design came
 * from. `@mahiframework/media` ships the modifier contracts and no image
 * library, so an app storing documents pays for no native build.
 *
 * ## Why the handle holds raw pixels and not a sharp instance
 *
 * **A sharp instance is a LAZY PIPELINE, and the last resize wins.**
 * Verified against sharp 0.35.5 / libvips 8.18.7:
 *
 * ```js
 * const bad = sharp(src)                                    // 100x60
 *   .resize({ width: 50,   fit: "inside", withoutEnlargement: true })
 *   .resize({ width: 4000, fit: "inside", withoutEnlargement: true });
 *
 * await bad.toBuffer();   // 100x60  ← the FIRST resize was discarded
 * ```
 *
 * The intent — shrink to 50 wide, then apply a 4000-wide bound that
 * should be a no-op — produces an untouched image. Two `.resize()` calls
 * on one instance do not compose; the second replaces the first.
 *
 * Worse for this interface, `metadata()` on a pipeline reports the
 * **source** dimensions rather than the current ones:
 *
 * ```js
 * const p = sharp(src).resize({ width: 50, fit: "inside" });
 * (await p.metadata()).width;                                  // 100 ← wrong
 * (await p.toBuffer({ resolveWithObject: true })).info.width;   // 50  ← right
 * ```
 *
 * `ImageDriver.apply()` is specified as "apply one operation, return the
 * result", and `cropToSquare()` calls `dimensions()` mid-chain to decide
 * its crop. Both are silently wrong against a lazy instance: a chain of
 * `[resizeDown(80), cropToSquare()]` would measure 100x60 instead of
 * 80x48 and cut a square of the wrong size from the wrong offset. No
 * error, just a bad thumbnail.
 *
 * So every `apply()` materialises to raw pixels. The round trip is
 * pixel-identical and preserves alpha (verified: `channels: 4` in and
 * out, `hasAlpha` true after), and chaining then behaves:
 *
 * ```
 * start      -> 100 x 60
 * after 50   -> 50 x 30
 * after 4000 -> 50 x 30   ← the no-op stayed a no-op
 * ```
 *
 * **The cost is memory and CPU**, and it is real. A 4000x3000 RGBA image
 * is 48 MB of raw pixels, held between every pair of operations, and
 * each materialisation is a full libvips pass — so a four-modifier chain
 * costs four passes rather than the one fused pipeline libvips is
 * exceptionally good at. That is a genuine regression against
 * hand-written sharp code, and it buys correctness.
 *
 * Two mitigations, in order: fuse adjacent ops once `ImageDriver` grows
 * an optional `applyAll()` (additive, and turns the common
 * `[crop, resize, format]` into one pass); and know the shape — a chain
 * of two or three modifiers on a web-sized upload is a few hundred
 * milliseconds, and an app processing thousands of images a second
 * should write sharp directly rather than through a portable interface.
 *
 * The alternative design — hold the lazy instance and have `media` never
 * measure mid-chain — was rejected: it pushes the footgun into every
 * future driver and into `cropToSquare`, and the whole point of shipping
 * a driver contract is that a driver cannot quietly behave differently.
 */
export class SharpImageDriver implements ImageDriver {
  private readonly limitInputPixels: number;
  private readonly autoOrient: boolean;
  private readonly allowAnimated: boolean;

  constructor(config: SharpConfig = {}) {
    // sharp's own default, spelled out rather than passed as `true`, so
    // `dimensions()` and the error message can both name a number.
    this.limitInputPixels = config.limitInputPixels ?? 16383 * 16383;
    this.autoOrient = config.autoOrient ?? true;
    this.allowAnimated = config.allowAnimated ?? false;
  }

  /**
   * Decode bytes into a handle.
   *
   * Three guards earn their place here, and all three are about input
   * nobody chose to send:
   *
   * `limitInputPixels` is the decompression-bomb bound, and it has to be
   * on the READ because that is the only place the pixel count is known
   * before the allocation. See the config docstring for why `maxBytes`
   * cannot do it.
   *
   * `failOn: "truncated"` rejects a partial upload rather than decoding
   * the bytes that did arrive into a half-grey image. `media` turns the
   * rejection into `UndecodableImageError`, which is the honest answer.
   *
   * Animated input is refused unless configured otherwise, because this
   * handle holds one frame. See `AnimatedImageError`.
   */
  async read(bytes: Uint8Array): Promise<ImageHandle> {
    const sharp = await loadSharp();
    // A Buffer view rather than a copy: `media` has already read these
    // bytes into memory once and a full-size image does not want a
    // second allocation for no reason.
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let pipeline = sharp(input, {
      limitInputPixels: this.limitInputPixels,
      failOn: "truncated",
    });

    if (!this.allowAnimated) {
      await this.refuseAnimated(pipeline);
    }

    if (this.autoOrient) {
      // No arguments: this is EXIF auto-orientation, not a rotation.
      // Applied on READ so every subsequent op — and every
      // `dimensions()` a modifier measures — sees the image the way a
      // human sees it.
      pipeline = pipeline.rotate();
    }

    return this.materialise(pipeline);
  }

  /**
   * A new blank canvas.
   *
   * RGBA rather than RGB, because the one caller is
   * `setBackgroundColor()`, which fills this and composites the original
   * over it. An RGB canvas would drop the original's alpha during the
   * composite and defeat the point.
   *
   * Transparent rather than black. A `create()` with no `fill()` after
   * it should not have invented a colour, and `setBackgroundColor()`
   * always fills.
   */
  async create(width: number, height: number): Promise<ImageHandle> {
    const sharp = await loadSharp();

    return this.materialise(
      sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      }),
    );
  }

  /**
   * Apply one operation and materialise the result.
   *
   * The materialisation is the whole design — see the class docstring.
   * `supports()` is checked here as well as in `ModifierContext.apply()`
   * because this driver is also reachable directly, and the contract
   * requires `UnsupportedImageOpError` rather than a deeper failure.
   */
  async apply(image: ImageHandle, op: ImageOp): Promise<ImageHandle> {
    if (!this.supports(op.type)) {
      throw new UnsupportedImageOpError("sharp", op.type);
    }

    const sharp = await loadSharp();

    return this.materialise(this.applyOp(sharp, this.state(image), op));
  }

  /** Encode back to bytes. */
  async encode(image: ImageHandle, options: EncodeOptions): Promise<Uint8Array> {
    const sharp = await loadSharp();
    const format = normaliseFormat(options.format);

    return this.pipelineFor(sharp, this.state(image))
      .toFormat(sharpFormat(format), encodeOptionsFor(format, options.quality))
      .toBuffer();
  }

  /**
   * Current pixel dimensions.
   *
   * Reads the handle's own state, so it is both free and correct
   * mid-chain. Against a lazy pipeline this would have to encode the
   * image to find out, and `metadata()` — the obvious call — would
   * answer about the source. That is the bug this design removes.
   */
  async dimensions(image: ImageHandle): Promise<{ width: number; height: number }> {
    const { width, height } = this.state(image);

    return { width, height };
  }

  /**
   * Whether this driver implements an operation.
   *
   * All five, today. Written as a membership test rather than
   * `() => true` so that an op added to `media` tomorrow reports `false`
   * here until it is actually implemented — which is the contract's
   * honesty requirement, and the reason `supports()` exists at all.
   */
  supports(op: ImageOpType): boolean {
    return (IMAGE_OPS as readonly string[]).includes(op);
  }

  /**
   * Run an arbitrary sharp transformation against a handle.
   *
   * The escape hatch's engine — `sharpModifier()` is the public face of
   * it, and that is where the usage rules are documented. Public rather
   * than private because the modifier lives in another module, and
   * narrower than exposing the state: a caller gets a pipeline and
   * returns a pipeline, and the raw-pixel materialisation that makes
   * chaining correct is still this class's business.
   */
  async applyNative(
    image: ImageHandle,
    transform: (pipeline: SharpPipeline) => SharpPipeline,
  ): Promise<ImageHandle> {
    const sharp = await loadSharp();

    return this.materialise(transform(this.pipelineFor(sharp, this.state(image))));
  }

  // ------------------------------------------------------------- internals

  /**
   * Build a pipeline over a handle's raw pixels.
   *
   * NO `limitInputPixels` HERE, deliberately. The bound exists to stop
   * an untrusted FILE from being decoded into an enormous raster, and
   * `read()` is the only place untrusted bytes enter — by this point the
   * pixels are ours, already counted, and already allocated.
   *
   * Applying it here as well breaks legitimate chains. An operation may
   * grow the image: a 900x900 admitted under a 1-megapixel limit becomes
   * 1273x1273 after `rotate(45)`, which is 1.6 megapixels — so the NEXT
   * op would re-read our own intermediate buffer and refuse it. Verified:
   * `Input image exceeds pixel limit`, on an image the app had already
   * accepted, from an operation the app explicitly asked for.
   */
  private pipelineFor(sharp: SharpModule, state: SharpImageState): SharpPipeline {
    return sharp(state.data, {
      raw: { width: state.width, height: state.height, channels: state.channels },
    });
  }

  /**
   * Map one `ImageOp` onto its sharp call.
   *
   * Exactly one sharp call per branch, which is what makes the lazy
   * pipeline safe to use here: the composition problem only bites when
   * two geometry calls land on one instance, and `materialise()` runs
   * between every pair.
   */
  private applyOp(sharp: SharpModule, state: SharpImageState, op: ImageOp): SharpPipeline {
    // `fill` discards the existing pixels by definition, so it builds a
    // canvas instead of reading one — handled before the shared
    // pipeline, which would otherwise be constructed and thrown away.
    if (op.type === "fill") {
      // Sized from the handle so `fill` is dimension-preserving like
      // every other op, and the colour string goes to sharp's own parser
      // so `#rgb`, `#rrggbb` and CSS names all work.
      return sharp({
        create: {
          width: state.width,
          height: state.height,
          channels: 4,
          background: op.color,
        },
      });
    }

    const pipeline = this.pipelineFor(sharp, state);

    switch (op.type) {
      case "scaleDown":
        // `fit: "inside"` + `withoutEnlargement` is the exact pair that
        // gives `scaleDown` its two documented properties, and both are
        // easy to get wrong: `fit: "cover"` crops to fill instead of
        // fitting, and omitting `withoutEnlargement` upscales a small
        // logo into a blurry one. The contract catches either.
        return pipeline.resize({
          width: op.width,
          height: op.height,
          fit: "inside",
          withoutEnlargement: true,
        });

      case "crop":
        return pipeline.extract({
          left: op.x,
          top: op.y,
          width: op.width,
          height: op.height,
        });

      case "place": {
        const overlay = this.state(op.image);

        return pipeline.composite([
          {
            input: overlay.data,
            raw: { width: overlay.width, height: overlay.height, channels: overlay.channels },
            left: op.x,
            top: op.y,
          },
        ]);
      }

      case "rotate":
        // A transparent background for the corners a non-right-angle
        // turn exposes. sharp's default is opaque black, which on a
        // 45-degree rotation produces four black triangles that no
        // caller asked for; transparent lets a later `setBackgroundColor`
        // or the encoder decide. A multiple of 90 exposes nothing, so
        // this is invisible in the common case.
        return pipeline.rotate(op.degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
  }

  /**
   * Run a pipeline to raw pixels and wrap them in a handle.
   *
   * `toBuffer({ resolveWithObject: true })` rather than `metadata()`:
   * `info` describes the bytes that came out, which is the only source
   * of truth for a pipeline's result dimensions. `metadata()` would
   * report the input's. That distinction is the whole reason this method
   * exists.
   */
  private async materialise(pipeline: SharpPipeline): Promise<SharpImageHandle> {
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

    return {
      __image: {
        [STATE]: true,
        data,
        width: info.width,
        height: info.height,
        channels: info.channels,
      },
    };
  }

  /**
   * Throw if the input has more than one frame.
   *
   * `pages` is undefined for a still PNG or JPEG and for a single-frame
   * GIF, and is the frame count for an animated GIF or WebP (verified
   * both ways). Read from `metadata()`, which decodes only the header —
   * so this costs nothing and, crucially, happens BEFORE any pixels are
   * allocated.
   */
  private async refuseAnimated(pipeline: SharpPipeline): Promise<void> {
    const { pages } = await pipeline.metadata();

    if (pages !== undefined && pages > 1) {
      throw new AnimatedImageError(pages);
    }
  }

  /**
   * Unwrap a handle, refusing one this driver did not create.
   *
   * Handles are opaque AND driver-specific: no type can catch a foreign
   * one, so the driver must. Guessing would read another driver's state
   * as a pixel buffer, which at best throws from inside libvips and at
   * worst produces garbage. `FakeImageDriver` asserts the mirror of
   * this, and the contract treats the pair as a property of the seam.
   */
  private state(image: ImageHandle): SharpImageState {
    const state = image.__image;

    if (!isSharpState(state)) {
      throw new Error(
        "The sharp image driver was handed a handle it did not create. Image handles are " +
          "opaque and driver-specific; they cannot be passed between drivers.",
      );
    }

    return state;
  }
}

function isSharpState(value: unknown): value is SharpImageState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[STATE] === true
  );
}

/**
 * How many frames an image has. `1` for a still, `0` if it will not
 * decode at all.
 *
 * For branching BEFORE an upload, so an animated GIF takes the
 * store-untouched path rather than throwing `AnimatedImageError` from
 * inside the modifier chain and being caught back out again. Only the
 * header is decoded, so this is cheap and allocates no pixels.
 *
 * Returns `0` rather than throwing on undecodable bytes: the caller is
 * asking "is this animated", and `media`'s own accept rules and
 * `UndecodableImageError` are what properly answer "is this an image".
 */
export async function frameCount(bytes: Uint8Array): Promise<number> {
  const sharp = await loadSharp();
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  try {
    // `pages` is undefined for a still PNG or JPEG and for a
    // single-frame GIF, and the frame count for an animated GIF or WebP.
    return (await sharp(input).metadata()).pages ?? 1;
  } catch {
    return 0;
  }
}

/** Whether these bytes are an animated image. See `frameCount`. */
export async function isAnimated(bytes: Uint8Array): Promise<boolean> {
  return (await frameCount(bytes)) > 1;
}
