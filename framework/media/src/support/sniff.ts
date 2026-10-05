import { DEFAULT_MIME_TYPE } from "./mime.js";

/**
 * How many leading bytes `sniffMimeType()` needs.
 *
 * The longest check below reads a 12-byte ISO-BMFF box plus a brand, and
 * the ZIP/OOXML check looks 60 bytes in for the content-type entry.
 */
export const SNIFF_BYTES = 64;

/**
 * Identify a file from its leading bytes.
 *
 * THE CLIENT'S `Content-Type` IS NOT EVIDENCE. It is a header the
 * uploader controls, so a `.php` payload announcing `image/png` would
 * pass any check based on it. Everything this package decides — whether
 * the file is accepted, what extension it is stored under, whether an
 * image driver is handed the bytes — follows from what the bytes
 * actually are.
 *
 * Returns `undefined` rather than `application/octet-stream` for
 * unrecognised bytes, so a caller can tell "this is definitely not a
 * known binary format" from "we gave up". Most text formats (CSV, JSON,
 * SVG, plain text) have no magic number and land here by design; the
 * caller falls back to the extension for those.
 *
 * Deliberately not a dependency. `file-type` covers far more formats,
 * but it is a large tree for a table that only has to recognise what
 * people upload to a web application, and the house pattern is to
 * hand-roll a small table rather than take the dep.
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  // Image formats first: they are the overwhelming majority of uploads,
  // so the common case should not walk the whole table.
  if (starts(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // APNG is a PNG with an `acTL` chunk before the first `IDAT`. Worth
    // distinguishing because it is animated, and an app that resizes it
    // with a still-image path silently drops the animation.
    return hasPngAnimationChunk(bytes) ? "image/apng" : "image/png";
  }

  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }

  if (starts(bytes, [0x42, 0x4d])) {
    return "image/bmp";
  }

  if (starts(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return "image/x-icon";
  }

  if (starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }

  // RIFF container: WebP and WAV share the outer header and differ in
  // the form type at offset 8.
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46])) {
    if (ascii(bytes, 8, 4) === "WEBP") {
      return "image/webp";
    }

    if (ascii(bytes, 8, 4) === "WAVE") {
      return "audio/wav";
    }
  }

  // ISO base media file format: MP4, MOV, AVIF, HEIC all carry an
  // `ftyp` box at offset 4 and are told apart by the brand after it.
  if (ascii(bytes, 4, 4) === "ftyp") {
    return isoBrandMimeType(ascii(bytes, 8, 4));
  }

  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }

  // ZIP, and everything built on it. The OOXML formats are ZIPs whose
  // first entry names the document type, so the archive answer has to
  // come last.
  if (starts(bytes, [0x50, 0x4b]) && isZipEntryHeader(bytes)) {
    return zipMimeType(bytes);
  }

  if (starts(bytes, [0x1f, 0x8b])) {
    return "application/gzip";
  }

  if (starts(bytes, [0x42, 0x5a, 0x68])) {
    return "application/x-bzip2";
  }

  if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return "application/x-7z-compressed";
  }

  if (starts(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) {
    return "application/vnd.rar";
  }

  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Matroska and WebM share the EBML header; the doc type sits in the
    // first few dozen bytes.
    return contains(bytes, "webm") ? "video/webm" : "video/x-matroska";
  }

  if (starts(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return "audio/ogg";
  }

  if (starts(bytes, [0x66, 0x4c, 0x61, 0x43])) {
    return "audio/flac";
  }

  // MP3: either an ID3 tag or a raw frame sync.
  if (starts(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) {
    return "audio/mpeg";
  }

  if (starts(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return "application/rtf";
  }

  // Legacy Office (doc/xls/ppt) share one OLE2 container and cannot be
  // told apart from the header alone, so the extension decides which.
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "application/x-ole-storage";
  }

  if (starts(bytes, [0x00, 0x01, 0x00, 0x00, 0x00]) || starts(bytes, [0x4f, 0x54, 0x54, 0x4f])) {
    return "font/ttf";
  }

  if (starts(bytes, [0x77, 0x4f, 0x46, 0x46])) {
    return "font/woff";
  }

  if (starts(bytes, [0x77, 0x4f, 0x46, 0x32])) {
    return "font/woff2";
  }

  return undefined;
}

/**
 * Whether these bytes look like a script or markup rather than a binary
 * asset.
 *
 * The thing an upload endpoint most needs to refuse, and the reason it
 * cannot trust an extension: a file named `avatar.png` whose bytes begin
 * `<?php` is the oldest upload exploit there is, and it sniffs as
 * nothing, so a MIME check alone would let it through on the extension's
 * word.
 *
 * Checked against a decoded prefix rather than exact magic numbers
 * because none of these formats has one, and leading whitespace or a BOM
 * is legal in all of them.
 */
export function looksExecutable(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, SNIFF_BYTES))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();

  return (
    head.startsWith("<?php") ||
    head.startsWith("<?=") ||
    head.startsWith("#!") ||
    head.startsWith("<script") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<html")
  );
}

/** The MIME type for an ISO-BMFF brand. */
function isoBrandMimeType(brand: string): string {
  // `avis` is the animated AVIF brand; `mif1`/`msf1` are the HEIF ones.
  const brands: Record<string, string> = {
    avif: "image/avif",
    avis: "image/avif",
    heic: "image/heic",
    heix: "image/heic",
    hevc: "image/heic",
    mif1: "image/heif",
    msf1: "image/heif",
    qt: "video/quicktime",
    M4V: "video/x-m4v",
    M4A: "audio/mp4",
  };

  if (brands[brand] !== undefined) {
    return brands[brand];
  }

  // QuickTime's brand is `qt  ` (trailing spaces).
  if (brand.trimEnd() === "qt") {
    return "video/quicktime";
  }

  // `isom`, `iso2`, `mp41`, `mp42`, `dash` and friends are all MP4.
  return "video/mp4";
}

/**
 * Distinguish OOXML and friends from a plain ZIP.
 *
 * All of them are ZIPs. The first local file entry names the payload:
 * OOXML stores `[Content_Types].xml` and then a `word/`, `xl/` or
 * `ppt/` directory; ODF stores a `mimetype` entry whose contents are
 * the type itself.
 */
function zipMimeType(bytes: Uint8Array): string {
  const head = ascii(bytes, 0, SNIFF_BYTES);

  if (head.includes("word/")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (head.includes("xl/")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  if (head.includes("ppt/")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  return "application/zip";
}

/**
 * Whether a `PK`-prefixed file is really a ZIP.
 *
 * The four-byte signature matters: `PK\x03\x04` is a local file header,
 * `PK\x05\x06` an empty archive's end-of-central-directory, and
 * `PK\x07\x08` a spanned archive. Anything else beginning `PK` is not a
 * ZIP, and accepting it would mislabel the file.
 */
function isZipEntryHeader(bytes: Uint8Array): boolean {
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;

  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  );
}

/**
 * Whether a PNG declares an `acTL` chunk, which makes it an APNG.
 *
 * Only the sniffed prefix is searched, so a PNG with a large `iCCP` or
 * `eXIf` chunk ahead of its `acTL` reads as a still image. That is the
 * safe direction to be wrong in: the file is still a valid PNG and every
 * decoder handles it, it merely loses its animation if resized.
 */
function hasPngAnimationChunk(bytes: Uint8Array): boolean {
  return ascii(bytes, 8, SNIFF_BYTES - 8).includes("acTL");
}

function starts(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[index] === byte);
}

/** `length` bytes from `offset` as latin1, for signature comparison. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";

  for (let index = offset; index < offset + length && index < bytes.length; index++) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }

  return out;
}

function contains(bytes: Uint8Array, needle: string): boolean {
  return ascii(bytes, 0, SNIFF_BYTES).includes(needle);
}

/**
 * The best type available for a file, preferring its bytes.
 *
 * The resolution order is the whole point: sniffed bytes win, the
 * extension is consulted only for formats with no magic number (text,
 * CSV, SVG, legacy Office), and `application/octet-stream` is the
 * answer when neither knows.
 *
 * The one place the extension overrides a sniff is the OLE2 container,
 * which `.doc`, `.xls` and `.ppt` all share — the bytes genuinely
 * cannot tell them apart.
 */
export function resolveMimeType(bytes: Uint8Array, extensionMimeType: string | undefined): string {
  const sniffed = sniffMimeType(bytes);

  if (sniffed === "application/x-ole-storage") {
    return extensionMimeType ?? DEFAULT_MIME_TYPE;
  }

  return sniffed ?? extensionMimeType ?? DEFAULT_MIME_TYPE;
}
