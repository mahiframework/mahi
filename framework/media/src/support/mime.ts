/**
 * Extension ↔ MIME mapping, richer than
 * `@mahiframework/storage`'s `guessMimeType()`.
 *
 * Duplicated rather than shared, which is the house pattern:
 * `http/src/response.ts` carries its own copy of storage's identical
 * twelve-entry map with a comment saying it does so to avoid the
 * dependency. The difference here is scope. Storage's table covers what
 * the framework itself serves; a media package has to name whatever a
 * user uploads, which means video, audio, modern image formats, office
 * documents and archives — none of which storage has any business
 * knowing about.
 *
 * Both directions are needed. Extension → MIME fills in a type for a
 * file whose bytes sniffed as nothing recognisable, and MIME → extension
 * names a file whose upload arrived without one.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // Images
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",

  // Video
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  ogv: "video/ogg",
  webm: "video/webm",

  // Audio
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",

  // Documents
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

  // Text and data
  css: "text/css",
  html: "text/html",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",

  // Archives
  "7z": "application/x-7z-compressed",
  bz2: "application/x-bzip2",
  gz: "application/gzip",
  rar: "application/vnd.rar",
  tar: "application/x-tar",
  zip: "application/zip",

  // Fonts
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * The extension to prefer when several map to one MIME type.
 *
 * Built by inverting the table above, so the FIRST extension wins —
 * which is why `jpeg` precedes `jpg` alphabetically but `jpg` is the
 * answer: these overrides pin the common spelling rather than whichever
 * key happened to sort first.
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  ...invert(EXTENSION_TO_MIME),
  "image/jpeg": "jpg",
  "image/tiff": "tif",
  "audio/ogg": "ogg",
  "application/yaml": "yml",
  "text/javascript": "js",
};

/** The fallback for bytes nothing recognises. */
export const DEFAULT_MIME_TYPE = "application/octet-stream";

/** The MIME type for a file name or extension, or undefined. */
export function mimeTypeForExtension(extension: string): string | undefined {
  return EXTENSION_TO_MIME[normalise(extension)];
}

/**
 * The canonical extension for a MIME type, without a leading dot, or
 * undefined.
 *
 * Any `;charset=` parameter is stripped first: a client sending
 * `text/plain; charset=utf-8` means the same type as one that does not,
 * and an exact-match lookup would otherwise miss.
 */
export function extensionForMimeType(mimeType: string): string | undefined {
  const bare = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

  return MIME_TO_EXTENSION[bare];
}

/**
 * Whether this MIME type is a raster image an image driver could decode.
 *
 * SVG is deliberately excluded. It is an image to a browser but a text
 * document to a decoder, and treating it as rasterisable is how a media
 * library ends up handing XML to a JPEG encoder. An app that wants SVG
 * thumbnails needs a rasteriser, which is a generator rather than a
 * modifier and is out of scope.
 */
export function isRasterImage(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

/** Lowercase, strip any leading dots and any directory part. */
function normalise(extension: string): string {
  const last = extension.split(".").pop() ?? "";

  return last.toLowerCase();
}

function invert(table: Record<string, string>): Record<string, string> {
  const inverted: Record<string, string> = {};

  for (const [extension, mimeType] of Object.entries(table)) {
    inverted[mimeType] ??= extension;
  }

  return inverted;
}
