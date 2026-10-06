import { describe, expect, it } from "vitest";
import { FakeImageDriver, UnsupportedImageOpError } from "@mahiframework/media";
import { SharpImageDriver, frameCount, isAnimated } from "../src/sharp-image-driver.js";
import { AnimatedImageError } from "../src/errors.js";
import {
  animated,
  exifRotatedJpeg,
  formatOf,
  gradientPng,
  jpeg,
  pixelBomb,
  png,
  sizeOf,
  topLeftPixel,
  transparentPng,
  webp,
} from "./__fixtures__/images.js";

describe("reading", () => {
  it("decodes a PNG and reports its dimensions", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(120, 80));

    expect(await driver.dimensions(image)).toEqual({ width: 120, height: 80 });
  });

  it.each([
    ["png", png],
    ["jpeg", jpeg],
    ["webp", webp],
  ])("decodes %s input", async (_name, make) => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await make(100, 60));

    expect(await driver.dimensions(image)).toEqual({ width: 100, height: 60 });
  });

  it("rejects bytes that are not an image", async () => {
    // `media`'s `runModifiers()` turns this into `UndecodableImageError`,
    // so the requirement is that it throws at READ rather than returning
    // a handle that fails later.
    const driver = new SharpImageDriver();

    await expect(driver.read(new TextEncoder().encode("definitely not an image"))).rejects.toThrow(
      /unsupported image format/i,
    );
  });

  it("rejects a truncated image rather than decoding the part that arrived", async () => {
    // `failOn: "truncated"`. The alternative is a half-decoded image
    // with a grey band across the bottom, stored as though it were fine.
    const full = await jpeg(200, 200);
    const driver = new SharpImageDriver();

    await expect(driver.read(full.subarray(0, Math.floor(full.length * 0.5)))).rejects.toThrow();
  });

  it("refuses a handle from another driver", async () => {
    // Handles are opaque AND driver-specific. No type can catch a
    // foreign one, so the driver must — guessing would read another
    // driver's state object as a pixel buffer. `FakeImageDriver`
    // asserts the mirror of this.
    const fake = new FakeImageDriver(100, 60);
    const foreign = await fake.read(await png());
    const driver = new SharpImageDriver();

    await expect(driver.dimensions(foreign)).rejects.toThrow(/handle it did not create/);
    await expect(driver.apply(foreign, { type: "scaleDown", width: 10 })).rejects.toThrow(
      /handle it did not create/,
    );
  });
});

/**
 * THE REASON THIS PACKAGE HOLDS RAW PIXELS.
 *
 * A sharp instance is a lazy pipeline: two `.resize()` calls on one
 * instance do not compose, the second replaces the first, and
 * `metadata()` reports the SOURCE dimensions rather than the current
 * ones. A driver whose handle held the instance would pass every type
 * check and be silently wrong in exactly these two cases.
 */
describe("chaining against a lazy pipeline (the trap)", () => {
  it("crops a resized image against its NEW dimensions, not the source's", async () => {
    // The single most important test in the package. The chain is what
    // `[resizeDown(80), cropToSquare()]` produces: measure, then cut.
    //
    // Source is 100x60. After scaling to 80 wide it is 80x48, so a
    // centred square is 48x48 taken from x=16. Against a lazy pipeline
    // the measurement would come back 100x60, giving a 60x60 square from
    // x=20 — bigger than the image it was cut from.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));

    const resized = await driver.apply(image, { type: "scaleDown", width: 80 });
    const { width, height } = await driver.dimensions(resized);

    expect({ width, height }).toEqual({ width: 80, height: 48 });

    const size = Math.min(width, height);
    const cropped = await driver.apply(resized, {
      type: "crop",
      width: size,
      height: size,
      x: Math.floor((width - size) / 2),
      y: Math.floor((height - size) / 2),
    });

    expect(await driver.dimensions(cropped)).toEqual({ width: 48, height: 48 });
  });

  it("keeps a no-op scaleDown a no-op after a real one", async () => {
    // Verified against a raw sharp instance: `.resize(50)` then
    // `.resize(4000)` returns the UNTOUCHED 100x60 source, because the
    // second call discards the first. Here the 50 must survive.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));

    const small = await driver.apply(image, { type: "scaleDown", width: 50 });
    const bounded = await driver.apply(small, { type: "scaleDown", width: 4000 });

    expect(await driver.dimensions(bounded)).toEqual({ width: 50, height: 30 });
  });

  it("reports dimensions mid-chain without encoding", async () => {
    // `metadata()` on a pipeline answers about the input. This has to
    // answer about the handle.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));
    const rotated = await driver.apply(image, { type: "rotate", degrees: 90 });

    expect(await driver.dimensions(rotated)).toEqual({ width: 60, height: 100 });
  });

  it("leaves the handle it was given untouched", async () => {
    // `apply()` may be immutable or in-place and callers must use the
    // return value either way — but this driver IS immutable, and a
    // modifier holding a reference (as `setBackgroundColor` does with
    // the original) depends on that.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));

    await driver.apply(image, { type: "scaleDown", width: 20 });

    expect(await driver.dimensions(image)).toEqual({ width: 100, height: 60 });
  });
});

describe("operations", () => {
  it("reports every op in media's set as supported", () => {
    const driver = new SharpImageDriver();

    for (const op of ["scaleDown", "crop", "fill", "place", "rotate"] as const) {
      expect(driver.supports(op)).toBe(true);
    }
  });

  it("reports an op it has never heard of as unsupported", () => {
    // Why `supports()` is a membership test and not `() => true`: an op
    // added to `media` tomorrow must report false here until it is
    // actually implemented, rather than claiming support and failing
    // from inside libvips.
    const driver = new SharpImageDriver();

    expect(driver.supports("posterise" as never)).toBe(false);
  });

  it("throws UnsupportedImageOpError rather than ignoring an unknown op", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png());

    await expect(driver.apply(image, { type: "posterise" } as never)).rejects.toThrow(
      UnsupportedImageOpError,
    );
  });

  it.each([
    [50, undefined, 50, 30],
    [undefined, 30, 50, 30],
    [50, 50, 50, 30],
    [4000, 4000, 100, 60],
    [1, undefined, 1, 1],
  ])("scaleDown to %sx%s gives %ix%i", async (width, height, wantWidth, wantHeight) => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));
    const applied = await driver.apply(image, { type: "scaleDown", width, height });

    expect(await driver.dimensions(applied)).toEqual({
      width: wantWidth,
      height: wantHeight,
    });
  });

  it("crops exactly the requested rectangle", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));
    const applied = await driver.apply(image, { type: "crop", width: 20, height: 10, x: 1, y: 2 });

    expect(await driver.dimensions(applied)).toEqual({ width: 20, height: 10 });
  });

  it("throws on a crop that runs off the edge", async () => {
    // libvips refuses rather than clamping, and that is the right
    // answer: a silently smaller crop is a wrong thumbnail, and the
    // caller's arithmetic is what needs fixing.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));

    await expect(
      driver.apply(image, { type: "crop", width: 50, height: 10, x: 90, y: 0 }),
    ).rejects.toThrow(/extract_area/);
  });

  it("fills the canvas with a colour, keeping its dimensions", async () => {
    const driver = new SharpImageDriver();
    const canvas = await driver.create(40, 25);
    const filled = await driver.apply(canvas, { type: "fill", color: "#ffffff" });

    expect(await driver.dimensions(filled)).toEqual({ width: 40, height: 25 });
    expect(await topLeftPixel(await driver.encode(filled, { format: "png" }))).toEqual([
      255, 255, 255,
    ]);
  });

  it.each(["#f00", "#ff0000", "red", "rgb(255,0,0)"])("accepts the colour %s", async (color) => {
    // The contract requires `#rgb`/`#rrggbb` at minimum; sharp's parser
    // takes CSS names and functions too, and there is no reason to
    // narrow it.
    const driver = new SharpImageDriver();
    const canvas = await driver.create(10, 10);
    const filled = await driver.apply(canvas, { type: "fill", color });

    expect(await topLeftPixel(await driver.encode(filled, { format: "png" }))).toEqual([255, 0, 0]);
  });

  it("composites one image onto another without resizing either", async () => {
    const driver = new SharpImageDriver();
    const base = await driver.read(await png(100, 60, "#ff0000"));
    const overlay = await driver.read(await png(20, 20, "#0000ff"));

    const placed = await driver.apply(base, { type: "place", image: overlay, x: 5, y: 5 });

    expect(await driver.dimensions(placed)).toEqual({ width: 100, height: 60 });
  });

  it("places the overlay at the requested offset", async () => {
    // Dimensions alone would pass for an implementation that ignored
    // `x`/`y` entirely, so the pixels are what gets asserted.
    const driver = new SharpImageDriver();
    const base = await driver.read(await png(40, 40, "#ff0000"));
    const overlay = await driver.read(await png(10, 10, "#0000ff"));

    const placed = await driver.apply(base, { type: "place", image: overlay, x: 20, y: 20 });
    const encoded = await driver.encode(placed, { format: "png" });

    // Top-left is still the base; the overlay landed at (20,20).
    expect(await topLeftPixel(encoded)).toEqual([255, 0, 0]);
    expect(await pixelAt(encoded, 25, 25)).toEqual([0, 0, 255]);
  });

  it.each([
    [90, 60, 100],
    [-90, 60, 100],
    [180, 100, 60],
    [360, 100, 60],
    [0, 100, 60],
  ])("rotating %i degrees gives %ix%i", async (degrees, wantWidth, wantHeight) => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));
    const applied = await driver.apply(image, { type: "rotate", degrees });

    expect(await driver.dimensions(applied)).toEqual({ width: wantWidth, height: wantHeight });
  });

  it("rotates off-axis onto a transparent background, not black", async () => {
    // sharp's default fill is opaque black, which puts four black
    // triangles into a 45-degree rotation that nobody asked for.
    // Transparent leaves the decision to a later `setBackgroundColor`
    // or to the encoder.
    const driver = new SharpImageDriver();
    const image = await driver.read(await jpeg(100, 60));
    const applied = await driver.apply(image, { type: "rotate", degrees: 45 });
    const encoded = await driver.encode(applied, { format: "png" });

    expect(await alphaAt(encoded, 0, 0)).toBe(0);
  });
});

describe("the canvas from create()", () => {
  it("is the requested size", async () => {
    const driver = new SharpImageDriver();

    expect(await driver.dimensions(await driver.create(120, 80))).toEqual({
      width: 120,
      height: 80,
    });
  });

  it("is transparent rather than an invented colour", async () => {
    // `setBackgroundColor` always fills, so the initial colour is never
    // seen there — but a `create()` that had silently chosen black would
    // be a surprise to anything else that used it.
    const driver = new SharpImageDriver();
    const canvas = await driver.create(10, 10);

    expect(await alphaAt(await driver.encode(canvas, { format: "png" }), 0, 0)).toBe(0);
  });
});

describe("encoding", () => {
  it.each(["png", "jpeg", "jpg", "webp", "avif", "tiff", "gif"])(
    "encodes to %s and the result decodes at the right size",
    async (format) => {
      // Asserting DECODABILITY and dimensions rather than byte length:
      // an encoder's output size is not a stable thing to pin, and
      // "produced some bytes" would pass for a corrupt file.
      const driver = new SharpImageDriver();
      const image = await driver.read(await png(64, 48));
      const encoded = await driver.encode(image, { format });

      expect(encoded.byteLength).toBeGreaterThan(0);
      expect(await sizeOf(encoded)).toEqual({ width: 64, height: 48 });
    },
  );

  it('encodes "jpg" as JPEG', async () => {
    // `media`'s MIME table canonicalises `image/jpeg` to the `jpg`
    // extension, and `EncodeOptions.format` carries that extension
    // through. A chain ending in `format("jpg")` that threw at the very
    // last step is the failure this prevents.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(32, 32));

    expect(await formatOf(await driver.encode(image, { format: "jpg" }))).toBe("jpeg");
  });

  it.each([
    ["JPG", "jpeg"],
    [".jpg", "jpeg"],
    ["jpe", "jpeg"],
    ["tif", "tiff"],
  ])("normalises the format %s to %s", async (given, expected) => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(32, 32));

    expect(await formatOf(await driver.encode(image, { format: given }))).toBe(expected);
  });

  it("names the formats it has when asked for one it does not", async () => {
    // The alternative is libvips' own error, which lists twenty names
    // including `dz` and `raw` — formats no media file should become.
    const driver = new SharpImageDriver();
    const image = await driver.read(await png());

    await expect(driver.encode(image, { format: "bmp" })).rejects.toThrow(
      /cannot encode to "bmp".*Supported formats/s,
    );
  });

  it("honours an explicit quality", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await gradientPng(200, 200));

    const low = await driver.encode(image, { format: "jpg", quality: 20 });
    const high = await driver.encode(image, { format: "jpg", quality: 95 });

    expect(low.byteLength).toBeLessThan(high.byteLength);
  });

  it("keeps PNG lossless by default", async () => {
    // THE PNG PALETTE TRAP. `palette: true` quantises to 256 colours —
    // measurably lossy on a photographic image — so defaulting it on
    // would make every PNG upload silently degrade. A caller asking for
    // PNG has not agreed to that.
    const driver = new SharpImageDriver();
    const source = await gradientPng(200, 200);
    const image = await driver.read(source);

    const encoded = await driver.encode(image, { format: "png" });

    expect(await maxChannelDifference(source, encoded)).toBe(0);
  });

  it("quantises PNG only when a quality is asked for", async () => {
    // `quality()` is the thing that means "I accept loss", so it is
    // what opts into the palette. The file gets much smaller and the
    // pixels measurably move — both are the point.
    const driver = new SharpImageDriver();
    const source = await gradientPng(200, 200);
    const image = await driver.read(source);

    const lossless = await driver.encode(image, { format: "png" });
    const quantised = await driver.encode(image, { format: "png", quality: 80 });

    expect(quantised.byteLength).toBeLessThan(lossless.byteLength);
    expect(await maxChannelDifference(source, quantised)).toBeGreaterThan(0);
  });
});

describe("alpha", () => {
  it("survives a resize and a round trip", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await transparentPng(80, 80));
    const resized = await driver.apply(image, { type: "scaleDown", width: 40 });
    const encoded = await driver.encode(resized, { format: "png" });

    expect(await alphaAt(encoded, 0, 0)).toBe(0);
  });

  it("flattens onto white rather than black through setBackgroundColor", async () => {
    // The `setBackgroundColor("#fff")` → `format("jpg")` path, which is
    // the practical reason `fill` and `place` exist. JPEG has no alpha,
    // so an implementation that merely DROPPED the channel would render
    // the transparent area black — and the fixture is transparent BLACK
    // specifically so that failure is visible.
    const driver = new SharpImageDriver();
    const original = await driver.read(await transparentPng(40, 40));
    const { width, height } = await driver.dimensions(original);

    const canvas = await driver.create(width, height);
    const filled = await driver.apply(canvas, { type: "fill", color: "#ffffff" });
    const composited = await driver.apply(filled, { type: "place", image: original, x: 0, y: 0 });

    expect(await topLeftPixel(await driver.encode(composited, { format: "jpg" }))).toEqual([
      255, 255, 255,
    ]);
  });

  it("goes black without the flatten, which is why setBackgroundColor exists", async () => {
    // The control for the test above. If this also came out white, the
    // flatten would be proving nothing.
    const driver = new SharpImageDriver();
    const image = await driver.read(await transparentPng(40, 40));

    expect(await topLeftPixel(await driver.encode(image, { format: "jpg" }))).toEqual([0, 0, 0]);
  });
});

describe("EXIF orientation", () => {
  it("applies the orientation tag on read", async () => {
    // A phone photo is stored in sensor orientation with a tag saying
    // how to turn it. Orientation 6 on a 100x60 raster means the image
    // a human sees is 60x100 — so this is also what makes
    // `cropToSquare()` measure the right thing.
    const driver = new SharpImageDriver();
    const image = await driver.read(await exifRotatedJpeg(100, 60));

    expect(await driver.dimensions(image)).toEqual({ width: 60, height: 100 });
  });

  it("encodes the oriented image, not the stored one", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await exifRotatedJpeg(100, 60));

    expect(await sizeOf(await driver.encode(image, { format: "png" }))).toEqual({
      width: 60,
      height: 100,
    });
  });

  it("leaves the raster alone when autoOrient is off", async () => {
    // For an app that applies orientation itself and would otherwise
    // get it applied twice.
    const driver = new SharpImageDriver({ autoOrient: false });
    const image = await driver.read(await exifRotatedJpeg(100, 60));

    expect(await driver.dimensions(image)).toEqual({ width: 100, height: 60 });
  });

  it("does nothing to an image without a tag", async () => {
    const driver = new SharpImageDriver();
    const image = await driver.read(await png(100, 60));

    expect(await driver.dimensions(image)).toEqual({ width: 100, height: 60 });
  });
});

describe("decompression bombs", () => {
  it("refuses an image whose pixel count exceeds the limit", async () => {
    // The fixture is 25 megapixels and a few kilobytes on disk — which
    // is the whole problem. `media`'s `accept.maxBytes` sees a small
    // file and waves it through; only a pixel bound catches it, and with
    // raw materialisation this driver would otherwise hold 75 MB of it.
    const driver = new SharpImageDriver({ limitInputPixels: 1_000_000 });

    await expect(driver.read(await pixelBomb(5000))).rejects.toThrow(/exceeds pixel limit/i);
  });

  it("allows an image inside the limit", async () => {
    const driver = new SharpImageDriver({ limitInputPixels: 1_000_000 });
    const image = await driver.read(await png(500, 500));

    expect(await driver.dimensions(image)).toEqual({ width: 500, height: 500 });
  });

  it("does not re-apply the limit to its own intermediate buffers", async () => {
    // THE BOUND IS FOR UNTRUSTED INPUT, NOT FOR OUR OWN PIXELS.
    //
    // Some operations GROW the image: 900x900 is 0.81 megapixels and
    // passes a 1-megapixel limit, but `rotate(45)` makes it 1273x1273 —
    // 1.6 megapixels. If the limit were applied when building a
    // pipeline over a handle, the NEXT op would re-read that
    // intermediate buffer and refuse it, failing an image the app had
    // already accepted with an operation the app explicitly asked for.
    const driver = new SharpImageDriver({ limitInputPixels: 1_000_000 });
    const image = await driver.read(await png(900, 900));

    const rotated = await driver.apply(image, { type: "rotate", degrees: 45 });
    const { width } = await driver.dimensions(rotated);

    expect(width * width).toBeGreaterThan(1_000_000);

    // Both a further op and the encode have to keep working.
    const resized = await driver.apply(rotated, { type: "scaleDown", width: 100 });

    expect(await driver.dimensions(resized)).toEqual({ width: 100, height: 100 });
    expect((await driver.encode(rotated, { format: "png" })).byteLength).toBeGreaterThan(0);
  });

  it("defaults to sharp's own 268 megapixel bound", async () => {
    // Permissive by default so the driver is not surprising, and
    // documented as the thing an upload-accepting app should lower.
    const driver = new SharpImageDriver();
    const image = await driver.read(await pixelBomb(2000));

    expect(await driver.dimensions(image)).toEqual({ width: 2000, height: 2000 });
  });
});

describe("animation", () => {
  it.each(["gif", "webp"] as const)(
    "refuses an animated %s rather than flattening it",
    async (format) => {
      // Silently turning a user's animated GIF into a still PNG is the
      // sort of thing discovered months later by somebody else. The
      // animation survives precisely because nothing touched it.
      const driver = new SharpImageDriver();

      await expect(driver.read(await animated(format))).rejects.toThrow(AnimatedImageError);
    },
  );

  it("names the frame count in the error", async () => {
    const driver = new SharpImageDriver();
    const error = await driver.read(await animated("gif", 3)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnimatedImageError);
    expect((error as AnimatedImageError).pages).toBe(3);
    expect((error as Error).message).toMatch(/3 frames/);
  });

  it("flattens to the first frame when the app opts in", async () => {
    // The explicit opt-out, for an avatar pipeline that genuinely wants
    // a still from an animated upload. A decision on the record rather
    // than an accident.
    const driver = new SharpImageDriver({ allowAnimated: true });
    const image = await driver.read(await animated("gif", 3, 20));

    expect(await driver.dimensions(image)).toEqual({ width: 20, height: 20 });
  });

  it("accepts a single-frame GIF, which is not animated", async () => {
    // `pages` is 1 rather than undefined for a still GIF, so an
    // off-by-one here would reject every static GIF ever uploaded.
    const driver = new SharpImageDriver();
    const still = await animated("gif", 1, 30);

    expect(await driver.dimensions(await driver.read(still))).toEqual({ width: 30, height: 30 });
  });

  it("answers the question up front, so an app can branch before uploading", async () => {
    expect(await isAnimated(await animated("gif", 3))).toBe(true);
    expect(await isAnimated(await animated("webp", 3))).toBe(true);
    expect(await isAnimated(await png())).toBe(false);
    expect(await isAnimated(await jpeg())).toBe(false);
    expect(await isAnimated(await animated("gif", 1))).toBe(false);
  });

  it("counts frames, reporting 0 for bytes that will not decode", async () => {
    // `frameCount` answers "is this animated". Deciding whether
    // something is an image at all belongs to `media`'s accept rules
    // and `UndecodableImageError`, so this does not throw.
    expect(await frameCount(await animated("gif", 3))).toBe(3);
    expect(await frameCount(await png())).toBe(1);
    expect(await frameCount(new TextEncoder().encode("nope"))).toBe(0);
  });
});

// ------------------------------------------------------------------ helpers

/** The RGB at a pixel, for asserting that an op landed where it should. */
async function pixelAt(bytes: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(bytes))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const offset = (y * info.width + x) * info.channels;

  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
}

/** The alpha at a pixel, for the transparency cases. */
async function alphaAt(bytes: Uint8Array, x: number, y: number): Promise<number> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return data[(y * info.width + x) * info.channels + 3] ?? 0;
}

/**
 * The largest per-channel difference between two encoded images.
 *
 * 0 proves a lossless round trip; anything above it quantifies the loss.
 * Comparing decoded pixels rather than bytes, since two encoders can
 * write the same image differently.
 */
async function maxChannelDifference(a: Uint8Array, b: Uint8Array): Promise<number> {
  const sharp = (await import("sharp")).default;
  const left = await sharp(Buffer.from(a)).removeAlpha().raw().toBuffer();
  const right = await sharp(Buffer.from(b)).removeAlpha().raw().toBuffer();

  let worst = 0;

  for (let index = 0; index < left.length; index++) {
    worst = Math.max(worst, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }

  return worst;
}
