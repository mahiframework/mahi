import { describe, expect, it } from "vitest";
import { encodeOptionsFor, normaliseFormat } from "../src/encode-options.js";

describe("normaliseFormat", () => {
  it.each([
    ["png", "png"],
    ["jpeg", "jpeg"],
    ["webp", "webp"],
    ["avif", "avif"],
    ["tiff", "tiff"],
    ["gif", "gif"],
  ])("passes %s through", (given, expected) => {
    expect(normaliseFormat(given)).toBe(expected);
  });

  it.each([
    ["jpg", "jpeg"],
    ["jpe", "jpeg"],
    ["jfif", "jpeg"],
    ["tif", "tiff"],
  ])("maps the alias %s to %s", (given, expected) => {
    expect(normaliseFormat(given)).toBe(expected);
  });

  it.each(["JPG", "Jpeg", "WEBP", ".jpg", ".PNG"])(
    "is case- and dot-insensitive about %s",
    (given) => {
      expect(() => normaliseFormat(given)).not.toThrow();
    },
  );

  it("maps jpg to jpeg, which is the one that matters", () => {
    // `media`'s MIME table canonicalises `image/jpeg` to the `jpg`
    // EXTENSION, because that is what users expect a stored file to be
    // called, and `EncodeOptions.format` carries the extension. Every
    // per-format decision past this point keys on `jpeg`.
    expect(normaliseFormat("jpg")).toBe("jpeg");
  });

  it.each(["bmp", "svg", "pdf", "dz", "raw", ""])("refuses %s", (given) => {
    // `dz` and `raw` are the interesting ones: libvips accepts both, and
    // neither is a thing a media file should become. A deep-zoom tile
    // pyramid on the disk where a thumbnail was expected is worse than
    // an error.
    expect(() => normaliseFormat(given)).toThrow(/cannot encode to/);
  });

  it("names the supported formats in the error", () => {
    expect(() => normaliseFormat("bmp")).toThrow(/png, jpeg, webp, avif, tiff, gif/);
  });
});

describe("encodeOptionsFor", () => {
  it("defaults JPEG to 82 with mozjpeg", () => {
    // `mozjpeg` is the in-process replacement for laravel-media's
    // shelled-out `jpegoptim`: a smaller file at the same visual
    // quality, with no binary to install.
    expect(encodeOptionsFor("jpeg", undefined)).toEqual({ quality: 82, mozjpeg: true });
  });

  it("defaults WebP to 80", () => {
    expect(encodeOptionsFor("webp", undefined)).toEqual({ quality: 80 });
  });

  it("defaults AVIF to 55, not 80", () => {
    // AVIF's quality scale is NOT JPEG's. 55 is roughly comparable
    // output to a quality-82 JPEG; 80 produces a file larger than the
    // JPEG it was meant to replace, which defeats the point of using
    // AVIF at all.
    expect(encodeOptionsFor("avif", undefined)).toEqual({ quality: 55 });
  });

  it("gives PNG lossless compression and no palette", () => {
    // THE PNG TRAP. `compressionLevel` is free — zlib effort, identical
    // pixels out. `palette` is not: it quantises to 256 colours, which
    // is measurably lossy on a photograph. A caller asking for PNG has
    // asked for a lossless format and has not agreed to quantisation.
    expect(encodeOptionsFor("png", undefined)).toEqual({ compressionLevel: 9 });
  });

  it("turns the PNG palette on only when a quality is given", () => {
    // `quality()` is the modifier that means "I accept loss", so it is
    // what opts in. sharp's PNG `quality` IS the palette target and has
    // no effect without the flag, so the two have to travel together.
    expect(encodeOptionsFor("png", 80)).toEqual({
      compressionLevel: 9,
      palette: true,
      quality: 80,
    });
  });

  it.each(["jpeg", "webp", "avif", "tiff"] as const)(
    "lets an explicit quality override the %s default",
    (format) => {
      expect(encodeOptionsFor(format, 33)).toMatchObject({ quality: 33 });
    },
  );

  it("invents no quality for GIF, which has none", () => {
    // GIF is palette-quantised rather than lossy, so there is no
    // sensible default to pick — but an explicit `quality()` in the
    // chain should not be silently dropped either.
    expect(encodeOptionsFor("gif", undefined)).toEqual({});
    expect(encodeOptionsFor("gif", 60)).toEqual({ quality: 60 });
  });
});
