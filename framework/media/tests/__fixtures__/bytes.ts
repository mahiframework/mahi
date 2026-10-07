/**
 * Minimal byte sequences carrying each format's real magic number.
 *
 * Hand-built rather than checked-in binaries: every check in
 * `support/sniff.ts` reads at most the first 64 bytes, so a header plus
 * padding exercises exactly what the sniffer looks at, and a reader can
 * see what is being claimed without opening a hex editor.
 *
 * These are NOT decodable images. Phase 4's image tests use a real
 * encoder; these prove the sniffer identifies a format from its header,
 * which is a different question.
 */

/**
 * Pad to `length` so a sniffed prefix has something to read.
 *
 * Returns `Buffer<ArrayBuffer>`, not a bare `Buffer`. `Buffer`'s default
 * type argument is `ArrayBufferLike`, which also covers a
 * `SharedArrayBuffer`-backed view, and `new File([...])` rejects those —
 * its `BufferSource` is `NonSharedArrayBufferView | ArrayBuffer`.
 * `Buffer.alloc` only ever returns the non-shared form, so the annotation
 * was widening a value that was already narrow.
 */
function padded(header: number[], length = 64): Buffer<ArrayBuffer> {
  const buffer = Buffer.alloc(length);

  Buffer.from(header).copy(buffer);

  return buffer;
}

export const PNG = padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG whose `acTL` chunk before the first `IDAT` makes it animated. */
export const APNG = (() => {
  const buffer = Buffer.alloc(64);

  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("acTL", 12, "latin1");

  return buffer;
})();

export const JPEG = padded([0xff, 0xd8, 0xff, 0xe0]);
export const GIF = padded([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
export const BMP = padded([0x42, 0x4d]);
export const TIFF = padded([0x49, 0x49, 0x2a, 0x00]);
export const ICO = padded([0x00, 0x00, 0x01, 0x00]);

/** RIFF container with a `WEBP` form type at offset 8. */
export const WEBP = riff("WEBP");
/** The same container with `WAVE`, which must not read as an image. */
export const WAV = riff("WAVE");

function riff(form: string): Buffer<ArrayBuffer> {
  const buffer = Buffer.alloc(64);

  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(56, 4);
  buffer.write(form, 8, "latin1");

  return buffer;
}

/** An ISO base media file with `ftyp` at offset 4 and a brand at 8. */
function isoBmff(brand: string): Buffer<ArrayBuffer> {
  const buffer = Buffer.alloc(64);

  buffer.writeUInt32BE(32, 0);
  buffer.write("ftyp", 4, "latin1");
  buffer.write(brand, 8, "latin1");

  return buffer;
}

export const MP4 = isoBmff("isom");
export const AVIF = isoBmff("avif");
export const HEIC = isoBmff("heic");
export const QUICKTIME = isoBmff("qt  ");

export const PDF = padded([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
export const GZIP = padded([0x1f, 0x8b, 0x08]);
export const SEVEN_ZIP = padded([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
export const FLAC = padded([0x66, 0x4c, 0x61, 0x43]);
export const MP3 = padded([0x49, 0x44, 0x33, 0x03]);
export const OGG = padded([0x4f, 0x67, 0x67, 0x53]);
export const WOFF2 = padded([0x77, 0x4f, 0x46, 0x32]);

/** A ZIP local file header, with room for an entry name. */
function zip(entry: string): Buffer<ArrayBuffer> {
  const buffer = Buffer.alloc(64);

  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(buffer);
  buffer.write(entry, 30, "latin1");

  return buffer;
}

export const ZIP = zip("hello.txt");
export const DOCX = zip("[Content_Types].xml\u0000word/document.xml");
export const XLSX = zip("[Content_Types].xml\u0000xl/workbook.xml");

/** `PK` followed by something that is not a ZIP entry signature. */
export const NOT_ZIP = padded([0x50, 0x4b, 0x99, 0x99]);

/** The OLE2 container every legacy Office format shares. */
export const OLE2 = padded([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Things an upload endpoint must refuse regardless of their name. */
export const PHP = Buffer.from('<?php echo "pwned"; ?>');
export const PHP_SHORT_TAG = Buffer.from('<?= system($_GET["c"]) ?>');
export const SHEBANG = Buffer.from("#!/bin/sh\nrm -rf /\n");
export const HTML = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>");
export const SCRIPT = Buffer.from('<script>alert("xss")</script>');
/** PHP behind a BOM and whitespace, which must not evade the check. */
export const PHP_OBFUSCATED = Buffer.from('\uFEFF\n\t  <?php echo "sneaky";');

/** Formats with no magic number at all, where the extension decides. */
export const CSV = Buffer.from("name,email\nada,ada@example.com\n");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
export const PLAIN = Buffer.from("just some words");
