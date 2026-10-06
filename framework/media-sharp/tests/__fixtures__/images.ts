import sharp from "sharp";

/**
 * Real encoded images, GENERATED WITH SHARP AT TEST TIME rather than
 * checked in as binaries.
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. The dimensions are at the call site. `png(1000, 800)` says what
 *      it is; a `fixtures/cat.png` requires opening it to find out, and
 *      a test asserting `width === 1000` against a file nobody has
 *      looked at is a test of a comment.
 *   2. No binaries in the repo, so `pack:check` stays happy (it allows
 *      only `dist`, `README.md` and `LICENSE`) and review stays textual.
 *   3. The generator is the same library under test, which sounds
 *      circular and is not: these produce ENCODED PNG/JPEG/WebP bytes,
 *      and what is being tested is the driver's handling of them. A
 *      fixture sharp cannot write is a fixture sharp cannot read either,
 *      so there is nothing to hide behind.
 */

/** A solid-colour RGBA PNG. Alpha channel present. */
export async function png(width = 100, height = 60, background = "#ff0000"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();
}

/** A solid-colour RGB JPEG. No alpha, which is the point of having it. */
export async function jpeg(width = 100, height = 60, background = "#00ff00"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();
}

/** A solid-colour WebP. */
export async function webp(width = 100, height = 60, background = "#0000ff"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } })
    .webp()
    .toBuffer();
}

/**
 * A fully transparent PNG, for the alpha and flatten cases.
 *
 * Transparent BLACK specifically (`rgba(0,0,0,0)`), because that makes
 * the `setBackgroundColor("#fff")` → JPEG test meaningful: an
 * implementation that drops the alpha instead of compositing produces
 * black, and one that composites produces white. Transparent white
 * would pass either way.
 */
export async function transparentPng(width = 40, height = 40): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

/**
 * A JPEG whose pixels are landscape and whose EXIF orientation tag says
 * to turn it a quarter turn.
 *
 * Orientation 6 means "rotate 90° clockwise for display", so a 100x60
 * stored image is a 60x100 image to a human. This is what every phone
 * photo looks like, and the fixture that catches a driver which ignores
 * the tag — verified: the raw decode is 100x60, and `.rotate()` makes it
 * 60x100.
 */
export async function exifRotatedJpeg(width = 100, height = 60): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#ff0000" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

/**
 * A photographic-ish gradient PNG: every pixel a different colour.
 *
 * For the PNG palette case. A solid-colour fixture survives
 * quantisation to 256 colours perfectly, so it cannot tell a lossless
 * encode from a lossy one — this one has 40,000 distinct colours and a
 * palettised version measurably differs.
 */
export async function gradientPng(width = 200, height = 200): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;

      pixels[offset] = x % 256;
      pixels[offset + 1] = y % 256;
      pixels[offset + 2] = (x * y) % 256;
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * An animated GIF or WebP with three differently-coloured frames.
 *
 * THE `pageHeight` GOES IN THE INPUT OPTIONS, not the output ones. This
 * is the non-obvious part and it is worth stating, because the obvious
 * spelling silently produces a still: frames are supplied as one tall
 * raw buffer, and it is `raw.pageHeight` that tells libvips where to cut
 * it. Passing `pageHeight` to `.gif()` instead yields a single 60-pixel
 * frame — verified both ways, which is how this comment exists.
 */
export async function animated(
  format: "gif" | "webp" = "gif",
  frames = 3,
  size = 20,
): Promise<Buffer> {
  const pixels = Buffer.alloc(size * size * frames * 4);

  for (let frame = 0; frame < frames; frame++) {
    for (let pixel = 0; pixel < size * size; pixel++) {
      const offset = (frame * size * size + pixel) * 4;

      // Distinct per frame, so a flattening implementation cannot be
      // mistaken for a correct one by accident.
      pixels[offset] = frame === 0 ? 255 : 0;
      pixels[offset + 1] = frame === 1 ? 255 : 0;
      pixels[offset + 2] = frame === 2 ? 255 : 0;
      pixels[offset + 3] = 255;
    }
  }

  const pipeline = sharp(pixels, {
    raw: { width: size, height: size * frames, channels: 4, pageHeight: size },
  });

  return format === "gif"
    ? pipeline.gif({ loop: 0, delay: [100, 100, 100] }).toBuffer()
    : pipeline.webp({ loop: 0, delay: [100, 100, 100] }).toBuffer();
}

/**
 * A decompression bomb: a tiny file that decodes to an enormous raster.
 *
 * 25 megapixels of a single colour compresses to a few kilobytes, which
 * is the entire problem — `media`'s `accept.maxBytes` sees a small file
 * and waves it through, and the allocation only happens on decode. With
 * raw materialisation this driver would hold 100 MB of it.
 */
export async function pixelBomb(side = 5000): Promise<Buffer> {
  return sharp({ create: { width: side, height: side, channels: 3, background: "#ff0000" } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Decode bytes and report their dimensions, for asserting on output. */
export async function sizeOf(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(Buffer.from(bytes)).metadata();

  return { width: width ?? 0, height: height ?? 0 };
}

/** Decode bytes and report the format sharp sees, for round-trip checks. */
export async function formatOf(bytes: Uint8Array): Promise<string> {
  return (await sharp(Buffer.from(bytes)).metadata()).format ?? "unknown";
}

/** The RGB of the top-left pixel, for the flatten and fill cases. */
export async function topLeftPixel(bytes: Uint8Array): Promise<[number, number, number]> {
  const { data } = await sharp(Buffer.from(bytes))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
}
