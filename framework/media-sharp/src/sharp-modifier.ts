import { imageModifier, type MediaModifier } from "@mahiframework/media";
import { SharpImageDriver } from "./sharp-image-driver.js";
import type { SharpPipeline } from "./sharp-loader.js";

/** A transformation written directly against a sharp pipeline. */
export type SharpTransform = (pipeline: SharpPipeline) => SharpPipeline;

/**
 * A modifier that reaches past `ImageOp` to a real sharp instance.
 *
 * `media`'s five generic ops cover the common cases and will never cover
 * libvips' several hundred. Rather than grow `ImageOp` until it is a
 * union of everything any driver can do — which would make every other
 * driver report `supports()` false for most of it — a driver package
 * exports its own modifiers. The design anticipated this.
 *
 * ```ts
 * import { sharpModifier } from "@mahiframework/media-sharp";
 *
 * withModifiers([
 *   resizeDown(1200),
 *   sharpModifier("vignette", (pipeline) => pipeline.blur(8).modulate({ brightness: 0.9 })),
 * ]);
 * ```
 *
 * **NOT PORTABLE, BY CONSTRUCTION.** A chain containing one of these
 * only works under this driver; swap the driver and it throws rather
 * than silently skipping. That is the honest trade, and the reason this
 * is named `sharpModifier` rather than something neutral like
 * `nativeModifier` — the name is the warning, at the call site, where
 * the decision is made.
 *
 * ## The one rule for `fn`
 *
 * **Make at most one geometry call.** The transform receives a lazy
 * pipeline, and sharp's `.resize()` does not compose: two calls on one
 * instance means the second replaces the first, silently. See
 * `SharpImageDriver`'s docstring for the verified demonstration. Filters
 * (`blur`, `sharpen`, `grayscale`, `tint`, `modulate`) compose fine and
 * may be chained freely; `resize`, `extract` and `rotate` should appear
 * once. Two resizes want two modifiers, which materialise in between and
 * behave.
 *
 * Do not call `.toBuffer()`, `.toFile()` or any other terminal method:
 * return the pipeline and the driver materialises it.
 */
export function sharpModifier(name: string, fn: SharpTransform): MediaModifier {
  return imageModifier(name, async (context) => {
    // The driver, not the configured one by name: a `sharpModifier` in a
    // chain running under some other driver is a programming error, and
    // it has to fail rather than be skipped. `media`'s own
    // `UnsupportedImageOpError` cannot say this — there is no `ImageOp`
    // here to be unsupported — so the message names the modifier.
    const driver = context.driver;

    if (!(driver instanceof SharpImageDriver)) {
      throw new Error(
        `The "${name}" modifier is specific to @mahiframework/media-sharp, but the configured ` +
          `image driver is "${context.driverName}" (${driver.constructor.name}). A chain using ` +
          `sharpModifier() only runs under the sharp driver.`,
      );
    }

    context.image = await driver.applyNative(context.image, fn);
  });
}

/**
 * Gaussian blur. `sigma` is the mask's standard deviation, 0.3–1000.
 *
 * Shipped named because reaching for a blur should not require knowing
 * that libvips measures it in sigma rather than pixels. Roughly,
 * `sigma = 1 + radius / 2`.
 */
export function blur(sigma = 1): MediaModifier {
  return sharpModifier("blur", (pipeline) => pipeline.blur(sigma));
}

/**
 * Sharpen, with sharp's own defaults when given nothing.
 *
 * Worth having after a `resizeDown`: downscaling softens an image, and a
 * mild sharpen is the standard remedy — it is what most thumbnail
 * pipelines do and what a hand-written sharp script would do here.
 */
export function sharpen(sigma?: number): MediaModifier {
  return sharpModifier("sharpen", (pipeline) =>
    sigma === undefined ? pipeline.sharpen() : pipeline.sharpen({ sigma }),
  );
}

/**
 * Convert to greyscale.
 *
 * Note that this genuinely reduces the channel count — a greyscale
 * handle holds one channel per pixel rather than three — so it also
 * shrinks what every subsequent operation has to carry.
 */
export function grayscale(): MediaModifier {
  return sharpModifier("grayscale", (pipeline) => pipeline.grayscale());
}

/** Tint the image with a colour, preserving luminance. */
export function tint(color: string): MediaModifier {
  return sharpModifier("tint", (pipeline) => pipeline.tint(color));
}

/**
 * Trim uniform borders away.
 *
 * The auto-crop for a logo that arrived with 40 pixels of white around
 * it. `threshold` is how different from the border colour a pixel has to
 * be to count as content, which matters for a JPEG whose "uniform"
 * border is uniform only to the eye.
 */
export function trim(threshold?: number): MediaModifier {
  return sharpModifier("trim", (pipeline) =>
    threshold === undefined ? pipeline.trim() : pipeline.trim({ threshold }),
  );
}

/**
 * Pad the image out with a border.
 *
 * The inverse of `trim`, and the way to letterbox something to a fixed
 * canvas: `resizeDown` fits it inside the bounds, then this pads the
 * remainder. Defaults to transparent padding, which an opaque output
 * format then flattens — pass a `background` for a known colour.
 */
export function extend(
  padding: number | { top?: number; bottom?: number; left?: number; right?: number },
  background = "#00000000",
): MediaModifier {
  const sides =
    typeof padding === "number"
      ? { top: padding, bottom: padding, left: padding, right: padding }
      : { top: 0, bottom: 0, left: 0, right: 0, ...padding };

  return sharpModifier("extend", (pipeline) => pipeline.extend({ ...sides, background }));
}
