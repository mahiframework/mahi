import type {
  AvifOptions,
  FormatEnum,
  GifOptions,
  JpegOptions,
  PngOptions,
  TiffOptions,
  WebpOptions,
} from "sharp";

/**
 * The formats this driver encodes to.
 *
 * A closed set rather than "whatever libvips accepts", because
 * `toFormat()` takes about twenty names (`dz`, `tile`, `jp2`, `raw`) and
 * most of them are not things a media file should become. An unknown
 * format gets a message naming the ones that work, instead of libvips'
 * own twenty-name list or — worse — a `.raw` tile pyramid on the disk.
 */
const FORMATS = ["png", "jpeg", "webp", "avif", "tiff", "gif"] as const;

type Format = (typeof FORMATS)[number];

/**
 * Extension spellings that are not their own sharp format name.
 *
 * `jpg` is the one that matters. `media`'s MIME table canonicalises
 * `image/jpeg` to the `jpg` EXTENSION — which is what users expect a
 * stored file to be called — and `EncodeOptions.format` carries that
 * extension straight through. sharp's `toFormat()` happens to accept
 * `"jpg"` as an alias in 0.35, but its per-format option objects are
 * keyed on the canonical name, and relying on an alias to also carry the
 * right option shape is how `format("jpg")` ends up silently skipping
 * `mozjpeg`. Normalising once here keeps one spelling past this point.
 */
const ALIASES: Record<string, Format> = {
  jpg: "jpeg",
  jpe: "jpeg",
  jfif: "jpeg",
  tif: "tiff",
  // Not an alias in libvips' sense — `heic`/`heif` and `avif` are
  // distinct containers — but an app asking for `heic` wants the modern
  // one, and AVIF is the format with universal browser support.
};

/**
 * Resolve an extension to a sharp format name.
 *
 * Throws on anything outside the set, which is the honest answer: the
 * alternative is handing an unrecognised string to `toFormat()` and
 * surfacing libvips' error at the very end of an otherwise successful
 * modifier chain, naming formats like `dz` that no caller asked about.
 */
export function normaliseFormat(format: string): Format {
  const lowered = format.replace(/^\./, "").toLowerCase();
  const resolved = ALIASES[lowered] ?? lowered;

  if (!isFormat(resolved)) {
    throw new Error(
      `The sharp image driver cannot encode to "${format}". Supported formats: ` +
        `${FORMATS.join(", ")} (and the aliases ${Object.keys(ALIASES).join(", ")}).`,
    );
  }

  return resolved;
}

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

/**
 * Per-format encoder options, with a quality default chosen per format.
 *
 * `EncodeOptions.quality` is deliberately undefined unless a `quality()`
 * modifier set one, because the right number is not global: 82 is a good
 * JPEG and a wasteful WebP, and AVIF's scale is different again — 80
 * there produces an enormous file for no visible gain. A single default
 * would have to be wrong for two of the three.
 *
 * This is also where laravel-media's shell-out optimizers are replaced.
 * It installs `jpegoptim` and `pngquant` as external binaries and pipes
 * the encoded file through them; `mozjpeg` and PNG palette quantisation
 * are the same two optimisations, in-process, with nothing to apt-get.
 * That is why those modifiers were left out of `media` as a driver
 * concern. The difference is that `pngquant` is LOSSY and this driver
 * will not apply it unasked — see the `png` case.
 */
export type FormatOptions =
  JpegOptions | PngOptions | WebpOptions | AvifOptions | TiffOptions | GifOptions;

export function encodeOptionsFor(format: Format, quality: number | undefined): FormatOptions {
  switch (format) {
    case "jpeg":
      return {
        quality: quality ?? 82,
        // Trellis quantisation and progressive scan optimisation: a
        // meaningfully smaller file at the same visual quality, which is
        // precisely what `jpegoptim` was being shelled out for.
        mozjpeg: true,
      };

    case "webp":
      return { quality: quality ?? 80 };

    case "avif":
      // AVIF's quality scale is not JPEG's. 55 is roughly comparable
      // output to a quality-82 JPEG at a fraction of the bytes; asking
      // for 82 here produces a file larger than the JPEG it replaced.
      return { quality: quality ?? 55 };

    case "png":
      // PNG IS LOSSLESS AND STAYS LOSSLESS BY DEFAULT.
      //
      // `compressionLevel: 9` is free — it is zlib effort, so the output
      // decodes to identical pixels, just smaller and slower to write.
      //
      // `palette: true` is NOT free, and this is the trap. It quantises
      // to a 256-colour palette, which on a photographic PNG measures a
      // mean per-channel error of 8 and a peak of 35 (verified on a
      // 200x200 gradient: 113 KB lossless versus 12 KB palettised).
      // Defaulting it on — as `pngquant` does, and as this package's own
      // plan proposed — would make every PNG upload silently lossy,
      // which is not something a caller asking for PNG has agreed to.
      //
      // So it is opt-in, via the thing that means "I accept loss":
      // `quality()`. sharp's PNG `quality` IS the palette target and has
      // no effect without the flag, so the two travel together.
      return quality === undefined
        ? { compressionLevel: 9 }
        : { compressionLevel: 9, palette: true, quality };

    case "tiff":
      return { quality: quality ?? 82 };

    case "gif":
      // Also quantised rather than lossy. Passed through when set so a
      // `quality()` in the chain is not silently dropped.
      return quality === undefined ? {} : { quality };
  }
}

/**
 * The `toFormat()` name, as sharp's own parameter type.
 *
 * `"avif"` is the reason this is not simply `keyof FormatEnum`. AVIF is
 * missing from sharp's `FormatEnum` interface — an upstream typing gap,
 * not a real limitation — so `toFormat()` declares its parameter as
 * `keyof FormatEnum | AvailableFormatInfo | "avif"` to let it through.
 * Naming that same union here keeps the whole thing cast-free.
 */
export function sharpFormat(format: Format): keyof FormatEnum | "avif" {
  return format;
}
