import { imageModifier, modifier, type MediaModifier } from "../pipeline/modifier.js";
import { extensionForMimeType, mimeTypeForExtension } from "../support/mime.js";

/**
 * Shrink to fit inside `width` × `height`, preserving aspect ratio.
 *
 * NEVER ENLARGES. A 200×200 avatar asked to fit 2000×2000 stays
 * 200×200 — upscaling produces a blurry image from no new information,
 * and an upload pipeline that silently did it would make every small
 * logo worse.
 *
 * Omit `height` and the image is bounded by width alone, which is the
 * common "max 1200px wide, any height" case.
 */
export function resizeDown(width?: number, height?: number): MediaModifier {
  return imageModifier("resizeDown", async (context) => {
    await context.apply({ type: "scaleDown", width, height });
  });
}

/**
 * Crop to a centred square.
 *
 * CENTRED, which is a deliberate divergence. laravel-media's
 * `CropToSquare` computes its offset as `x = width - size`,
 * `y = height - size`, anchoring the crop to the bottom right — so a
 * portrait photo cropped for an avatar keeps the subject's chest and
 * loses their face. That reads as a bug rather than a choice, and this
 * is the behaviour every caller expects.
 */
export function cropToSquare(): MediaModifier {
  return imageModifier("cropToSquare", async (context) => {
    const { width, height } = await context.dimensions();
    const size = Math.min(width, height);

    if (width === height) {
      return;
    }

    await context.apply({
      type: "crop",
      width: size,
      height: size,
      x: Math.floor((width - size) / 2),
      y: Math.floor((height - size) / 2),
    });
  });
}

/**
 * Encode the result as a different format.
 *
 * Touches no pixels — it sets the encode format, and the effect lands
 * when the chain finishes. That is why `format("webp")` can appear
 * anywhere in a chain and still decide the output.
 *
 * Accepts an extension (`"webp"`) or a MIME type (`"image/webp"`),
 * because both read naturally depending on where the value came from.
 */
export function format(target: string): MediaModifier {
  const extension = target.includes("/")
    ? (extensionForMimeType(target) ?? target.split("/").pop() ?? target)
    : target.replace(/^\./, "").toLowerCase();

  return modifier(
    "format",
    async (context, next) => {
      context.encode = { ...context.encode, format: extension };

      return next(context);
    },
    // Declared so the upload path can name the stored file correctly
    // before the chain runs. See `MediaModifier.targetFormat`.
    { targetFormat: extension },
  );
}

/**
 * Set the lossy quality, 1–100.
 *
 * Ignored by formats that have no such notion (PNG, GIF), which is the
 * driver's business rather than something to validate here — a chain of
 * `[resizeDown(800), quality(82)]` should work unchanged whether the
 * upload was a JPEG or a PNG.
 *
 * Clamped rather than rejected. A caller passing 0 or 150 means "as low
 * as possible" or "as high as possible", and failing an upload over an
 * out-of-range quality setting serves nobody.
 */
export function quality(value: number): MediaModifier {
  const clamped = Math.max(1, Math.min(100, Math.round(value)));

  return modifier("quality", async (context, next) => {
    context.encode = { ...context.encode, quality: clamped };

    return next(context);
  });
}

/**
 * Flatten transparency onto a solid colour.
 *
 * Fills a new canvas and composites the original over it, which is the
 * only way to do this with the generic operations — there is no
 * alpha-aware blend op. The practical need is converting a transparent
 * PNG to JPEG, which has no alpha channel and would otherwise render
 * transparent areas as black.
 */
export function setBackgroundColor(color: string): MediaModifier {
  return imageModifier("setBackgroundColor", async (context) => {
    const { width, height } = await context.dimensions();
    const canvas = await context.driver.create(width, height);
    const original = context.image;

    context.image = canvas;

    await context.apply({ type: "fill", color });
    await context.apply({ type: "place", image: original, x: 0, y: 0 });
  });
}

/** Rotate clockwise by whole degrees. */
export function rotate(degrees: number): MediaModifier {
  return imageModifier("rotate", async (context) => {
    await context.apply({ type: "rotate", degrees });
  });
}

/**
 * The MIME type a `format()` modifier would produce, if the chain has
 * one.
 *
 * Used by the upload path to decide an extension before encoding, so
 * the generated storage path already carries the right one and no file
 * has to be moved afterwards. laravel-media writes the new bytes to the
 * OLD path, leaving a `.png` file whose row claims `webp`.
 */
export function targetMimeType(modifiers: readonly MediaModifier[], fallback: string): string {
  // The LAST declared format wins, matching how the context's encode
  // options are overwritten in chain order.
  const forced = modifiers.filter((entry) => entry.targetFormat !== undefined).pop();

  if (forced?.targetFormat === undefined) {
    return fallback;
  }

  return mimeTypeForExtension(forced.targetFormat) ?? fallback;
}
