import { describe, expect, it } from "vitest";
import { looksExecutable, resolveMimeType, sniffMimeType } from "../src/support/sniff.js";
import { extensionForMimeType, isRasterImage, mimeTypeForExtension } from "../src/support/mime.js";
import * as bytes from "./__fixtures__/bytes.js";

describe("sniffMimeType", () => {
  it.each([
    ["PNG", bytes.PNG, "image/png"],
    ["APNG", bytes.APNG, "image/apng"],
    ["JPEG", bytes.JPEG, "image/jpeg"],
    ["GIF", bytes.GIF, "image/gif"],
    ["BMP", bytes.BMP, "image/bmp"],
    ["TIFF", bytes.TIFF, "image/tiff"],
    ["ICO", bytes.ICO, "image/x-icon"],
    ["WebP", bytes.WEBP, "image/webp"],
    ["WAV", bytes.WAV, "audio/wav"],
    ["MP4", bytes.MP4, "video/mp4"],
    ["AVIF", bytes.AVIF, "image/avif"],
    ["HEIC", bytes.HEIC, "image/heic"],
    ["QuickTime", bytes.QUICKTIME, "video/quicktime"],
    ["PDF", bytes.PDF, "application/pdf"],
    ["gzip", bytes.GZIP, "application/gzip"],
    ["7z", bytes.SEVEN_ZIP, "application/x-7z-compressed"],
    ["FLAC", bytes.FLAC, "audio/flac"],
    ["MP3", bytes.MP3, "audio/mpeg"],
    ["Ogg", bytes.OGG, "audio/ogg"],
    ["WOFF2", bytes.WOFF2, "font/woff2"],
    ["ZIP", bytes.ZIP, "application/zip"],
  ])("identifies %s", (_label, input, expected) => {
    expect(sniffMimeType(input)).toBe(expected);
  });

  it("tells WebP and WAV apart inside one RIFF container", () => {
    // Both start `RIFF`; only the form type at offset 8 differs. Getting
    // this wrong would hand an audio file to an image decoder.
    expect(sniffMimeType(bytes.WEBP)).toBe("image/webp");
    expect(sniffMimeType(bytes.WAV)).toBe("audio/wav");
  });

  it("tells OOXML formats apart from a plain zip", () => {
    // All three are ZIPs; the first entry names the payload.
    expect(sniffMimeType(bytes.DOCX)).toContain("wordprocessingml");
    expect(sniffMimeType(bytes.XLSX)).toContain("spreadsheetml");
    expect(sniffMimeType(bytes.ZIP)).toBe("application/zip");
  });

  it("rejects a PK prefix that is not a zip signature", () => {
    // `PK` alone is not enough: only `\x03\x04`, `\x05\x06` and
    // `\x07\x08` are real headers, and mislabelling the rest as an
    // archive would be a lie about the file.
    expect(sniffMimeType(bytes.NOT_ZIP)).toBeUndefined();
  });

  it("distinguishes an animated PNG from a still one", () => {
    expect(sniffMimeType(bytes.PNG)).toBe("image/png");
    expect(sniffMimeType(bytes.APNG)).toBe("image/apng");
  });

  it("returns undefined for formats with no magic number", () => {
    // Not `application/octet-stream`: the caller needs to tell "this is
    // definitely not a known binary" from "we gave up", so it can fall
    // back to the extension.
    expect(sniffMimeType(bytes.CSV)).toBeUndefined();
    expect(sniffMimeType(bytes.SVG)).toBeUndefined();
    expect(sniffMimeType(bytes.PLAIN)).toBeUndefined();
  });

  it("does not crash on empty or truncated input", () => {
    expect(sniffMimeType(new Uint8Array())).toBeUndefined();
    expect(sniffMimeType(new Uint8Array([0x89]))).toBeUndefined();
    expect(sniffMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeUndefined();
  });
});

describe("looksExecutable", () => {
  it.each([
    ["PHP", bytes.PHP],
    ["a PHP short tag", bytes.PHP_SHORT_TAG],
    ["a shebang", bytes.SHEBANG],
    ["HTML", bytes.HTML],
    ["a script tag", bytes.SCRIPT],
  ])("refuses %s", (_label, input) => {
    expect(looksExecutable(input)).toBe(true);
  });

  it("sees through a BOM and leading whitespace", () => {
    // The evasion that matters. A check anchored strictly at byte zero
    // would pass this, and the file would still execute.
    expect(looksExecutable(bytes.PHP_OBFUSCATED)).toBe(true);
  });

  it("allows ordinary files", () => {
    expect(looksExecutable(bytes.PNG)).toBe(false);
    expect(looksExecutable(bytes.PDF)).toBe(false);
    expect(looksExecutable(bytes.CSV)).toBe(false);
    expect(looksExecutable(bytes.PLAIN)).toBe(false);
  });

  it("allows an SVG, which is markup but not executable on its own", () => {
    // SVG can carry script, which is why it should not be served from a
    // domain that matters — but it is a legitimate upload and this check
    // is about the file being a program, not about XSS.
    expect(looksExecutable(bytes.SVG)).toBe(false);
  });
});

describe("resolveMimeType", () => {
  it("prefers the bytes over the extension", () => {
    // The whole point. A PNG named `.pdf` is a PNG.
    expect(resolveMimeType(bytes.PNG, "application/pdf")).toBe("image/png");
  });

  it("falls back to the extension when nothing sniffs", () => {
    expect(resolveMimeType(bytes.CSV, "text/csv")).toBe("text/csv");
  });

  it("falls back to octet-stream when neither knows", () => {
    expect(resolveMimeType(bytes.PLAIN, undefined)).toBe("application/octet-stream");
  });

  it("lets the extension decide between the legacy Office formats", () => {
    // `.doc`, `.xls` and `.ppt` share one OLE2 container, so the bytes
    // genuinely cannot tell them apart. This is the only case where the
    // extension overrides a successful sniff.
    expect(resolveMimeType(bytes.OLE2, "application/vnd.ms-excel")).toBe(
      "application/vnd.ms-excel",
    );
    expect(resolveMimeType(bytes.OLE2, undefined)).toBe("application/octet-stream");
  });
});

describe("the mime table", () => {
  it("maps extensions to types", () => {
    expect(mimeTypeForExtension("jpg")).toBe("image/jpeg");
    expect(mimeTypeForExtension(".JPG")).toBe("image/jpeg");
    expect(mimeTypeForExtension("photo.webp")).toBe("image/webp");
    expect(mimeTypeForExtension("nonsense")).toBeUndefined();
  });

  it("maps types back to a canonical extension", () => {
    // `jpeg` and `jpg` both map in; `jpg` is the one that comes back.
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("application/pdf")).toBe("pdf");
  });

  it("ignores a charset parameter", () => {
    expect(extensionForMimeType("text/csv; charset=utf-8")).toBe("csv");
  });

  it("covers what storage's twelve-entry table does not", () => {
    // The reason this package carries its own table: storage's exists to
    // serve framework assets, not to name user uploads.
    for (const extension of ["mp4", "mov", "webm", "avif", "heic", "docx", "zip", "mp3"]) {
      expect(mimeTypeForExtension(extension)).toBeDefined();
    }
  });
});

describe("isRasterImage", () => {
  it("accepts formats a decoder can read", () => {
    expect(isRasterImage("image/png")).toBe(true);
    expect(isRasterImage("image/jpeg")).toBe(true);
    expect(isRasterImage("image/avif")).toBe(true);
  });

  it("rejects SVG", () => {
    // An image to a browser, a text document to a decoder. Treating it
    // as rasterisable is how XML ends up in a JPEG encoder.
    expect(isRasterImage("image/svg+xml")).toBe(false);
  });

  it("rejects everything that is not an image", () => {
    expect(isRasterImage("application/pdf")).toBe(false);
    expect(isRasterImage("video/mp4")).toBe(false);
  });
});
