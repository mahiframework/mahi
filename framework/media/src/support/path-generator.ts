import { randomUUID } from "node:crypto";

/**
 * Where a file is stored on the disk.
 *
 * A random UUID split across directories, never anything derived from
 * the upload:
 *
 *   8c19165c/9b72/4d57/90ae/21d7b362a9f3.webp
 *
 * TWO REASONS, both load-bearing.
 *
 * Keeping a user-supplied name off the filesystem is what stops
 * `../../etc/passwd`, a 300-character name, an emoji a filesystem
 * normalises differently, and a `.php` extension on a public disk from
 * ever being a question. The original name lives in `original_filename`
 * and is used only for `Content-Disposition`.
 *
 * Nesting keeps any one directory small. A flat directory with a million
 * entries is slow to list and slow to stat on most filesystems, and some
 * object-store consoles refuse to page through it at all.
 *
 * laravel-media's equivalent replaces the first TWO hyphens of a UUID,
 * which contradicts the four-level layout its own test fixtures have on
 * disk — a `str_replace` limit of 2. Four is the useful reading and what
 * this does.
 */
export class PathGenerator {
  /**
   * @param nesting how many leading UUID groups become directories.
   *                Clamped to 0–4, since a UUID has five groups and the
   *                last must remain the filename.
   */
  constructor(private readonly nesting: number) {}

  /**
   * A fresh path for a file with `extension` (no leading dot, may be
   * empty), optionally under a prefix.
   *
   * The UUID is generated here rather than taken from the media row's
   * snowflake id, deliberately. A snowflake encodes a timestamp and a
   * sequence, so a path built from one would let anyone holding a single
   * URL enumerate neighbouring uploads by decrementing it — which on a
   * public disk is a data leak. A v4 UUID is unguessable.
   */
  generate(extension: string, prefix?: string | null): string {
    const groups = randomUUID().split("-");
    const depth = Math.max(0, Math.min(4, Math.trunc(this.nesting)));
    const directories = groups.slice(0, depth);
    const name = groups.slice(depth).join("");
    const suffix = extension === "" ? "" : `.${extension}`;
    const parts = prefix == null || prefix === "" ? [] : [prefix];

    return [...parts, ...directories, `${name}${suffix}`].join("/");
  }
}

/**
 * Sanitise the name a file is downloaded as.
 *
 * Not a storage path — this is `original_filename`, which only ever
 * reaches a `Content-Disposition` header. It is still cleaned, because
 * the column is read back into other contexts (a zip entry name, a
 * filesystem write by whatever consumes the download) and a name
 * carrying a path separator would escape all of them.
 *
 * Directory parts, control characters and leading dots go; length is
 * capped well inside every filesystem's limit while leaving room for the
 * extension. A name that sanitises away entirely becomes `"file"`,
 * because an empty `filename=""` makes a browser invent its own.
 */
export function sanitiseFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";

  const cleaned = base

    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();

  if (cleaned === "") {
    return "file";
  }

  return cleaned.length > 180 ? truncatePreservingExtension(cleaned, 180) : cleaned;
}

/**
 * Shorten a name without destroying its extension.
 *
 * A plain `slice()` would turn `very-long-name.pdf` into
 * `very-long-nam`, and a download with no extension opens in the wrong
 * application.
 */
function truncatePreservingExtension(name: string, limit: number): string {
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || name.length - dot > 12) {
    return name.slice(0, limit);
  }

  const extension = name.slice(dot);

  return name.slice(0, limit - extension.length) + extension;
}
