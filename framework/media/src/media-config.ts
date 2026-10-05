/**
 * The optional `"media"` config namespace.
 *
 * Every field has a default, so an app that never writes
 * `config/media.ts` gets a working package: files on the storage default
 * disk, four-level nested UUID paths, sha256 checksums recorded but not
 * verified.
 *
 * NOTHING HERE IMPORTS A MODEL. A `config/*.ts` is loaded before
 * `app.bootstrap()`, so importing a model would pull the ORM into
 * config-load time. That is also why there is no `models` key: swapping
 * the class this package reads and writes goes through
 * `useMediaModels()`, which takes the class itself rather than a name.
 * See `docs/extending-models`.
 *
 * THERE IS DELIBERATELY NO `publicDisks` KEY. `spatie`-style media
 * packages in PHP carry one because `Storage` there cannot answer "is
 * this disk publicly readable", so the package keeps a side-list and
 * picks a public or signed URL from it. `@mahiframework/storage` already
 * encodes the fact: a disk with a `url` prefix is public, and one without
 * throws from `url()` saying exactly that. A second list here could only
 * ever disagree with the real one, and it would be per-row meaningless
 * anyway — a media row has exactly one `disk`. `MediaFile.isPublic()`
 * reads `Storage.diskConfig(name).url` instead.
 */
export interface MediaConfig {
  /**
   * The disk new media is written to. Defaults to the storage default
   * disk, which is what a single-disk app wants and never has to think
   * about.
   *
   * Stored as `null` on the row when it resolves to the default, not as
   * the default's name: `Storage.disk(undefined)` resolves at read time,
   * so a row written before a `storage.default` change still reads from
   * whatever "default" means now. A row that must pin a specific disk
   * names it explicitly through the collection's `disk()`.
   */
  disk?: string;

  /** A path prefix under the disk root, e.g. `"uploads"`. */
  path?: string;

  /**
   * How many directory levels the generated UUID path is split across.
   * Defaults to 4: `8c19165c/9b72/4d57/90ae/21d7b362a9f3.webp`.
   *
   * Nesting exists because a single flat directory with a million
   * entries is slow to list and slow to stat on most filesystems. Four
   * levels keeps any one directory small at every realistic volume.
   * Changing it does not move existing files — paths are stored, not
   * recomputed — so an app may change it freely and only new uploads
   * are affected.
   */
  pathNesting?: number;

  hashing?: MediaHashingConfig;

  accept?: MediaAcceptConfig;

  /** Database connection for the `media` table. Defaults to the app's. */
  connection?: string;
}

export interface MediaHashingConfig {
  /**
   * The `node:crypto` hash used for `checksum_hash`. Defaults to
   * `"sha256"`.
   *
   * Not md5. A checksum here answers "has this file changed underneath
   * us", and md5's collision weakness makes that answer forgeable by
   * anyone who can write to the disk. sha256 costs a little more per
   * upload and nothing per read, because reads do not verify.
   *
   * Changing this does not invalidate existing rows: each row stores the
   * algorithm it was hashed with, and `verify()` rehashes with the
   * current one once a file has checked out under its old one.
   */
  algorithm?: string;

  /**
   * Verify the stored file against its recorded checksum on every read
   * through `contents()`/`readStream()`. Defaults to `false`.
   *
   * Off by default because verification costs a full read of the file,
   * which doubles the cost of serving one and makes streaming pointless
   * — you cannot stream the first byte until you have hashed the last.
   * `verify()` is the explicit call for the paths that need it.
   */
  verify?: boolean;
}

export interface MediaAcceptConfig {
  /** Mime patterns, matched with `Str.is`, so `"image/*"` works. */
  mimes?: string[];
  /** Extensions, without a leading dot. */
  extensions?: string[];
  /** Hard upper bound on a single file, in bytes. */
  maxBytes?: number;
}

/** An `accept` block with its arrays normalised. */
export interface ResolvedAccept {
  mimes: readonly string[];
  extensions: readonly string[];
  maxBytes: number | null;
}

/** The config with every default applied, built once at provider boot. */
export interface ResolvedMediaConfig {
  /** Null when no disk was named, meaning "the storage default". */
  disk: string | null;
  path: string | null;
  pathNesting: number;
  hashAlgorithm: string;
  verifyHashes: boolean;
  /** The app-wide floor every collection's own `accept()` narrows. */
  accept: ResolvedAccept;
  connection: string | undefined;
}

const DEFAULT_PATH_NESTING = 4;
const DEFAULT_HASH_ALGORITHM = "sha256";

/**
 * Normalise a config block once, at provider boot.
 *
 * Every default is applied here with `??`, which is both the single place
 * to read them and immune to merge-order surprises: contributing them via
 * `ConfigRepository.merge()` would deep-merge the INCOMING values last
 * and silently overwrite the app's own config rather than layering under
 * it.
 */
export function resolveConfig(config: MediaConfig = {}): ResolvedMediaConfig {
  const hashing = config.hashing ?? {};

  return {
    disk: config.disk ?? null,
    path: normalisePrefix(config.path),
    pathNesting: config.pathNesting ?? DEFAULT_PATH_NESTING,
    hashAlgorithm: hashing.algorithm ?? DEFAULT_HASH_ALGORITHM,
    verifyHashes: hashing.verify ?? false,
    accept: resolveAccept(config.accept),
    connection: config.connection,
  };
}

/** Normalise an `accept` block, from config or from a collection. */
export function resolveAccept(accept: MediaAcceptConfig = {}): ResolvedAccept {
  return {
    // Lowercased on the way in and compared lowercased later: a filter
    // that a capitalisation defeats is not a filter. `.JPG` off a camera
    // and `image/JPEG` from a careless client both have to match.
    mimes: (accept.mimes ?? []).map((mime) => mime.toLowerCase()),
    extensions: (accept.extensions ?? []).map((extension) =>
      extension.replace(/^\./, "").toLowerCase(),
    ),
    maxBytes: accept.maxBytes ?? null,
  };
}

/**
 * Trim a path prefix to the shape the path generator expects: no leading
 * or trailing slash, and empty string treated as absent.
 *
 * Normalised here rather than at every join so `"uploads"`,
 * `"/uploads"` and `"uploads/"` all produce the same stored paths. An app
 * that got this wrong would otherwise discover it as a directory named
 * `""` on the disk.
 */
function normalisePrefix(path: string | undefined): string | null {
  if (path === undefined) {
    return null;
  }

  const trimmed = path.replace(/^\/+|\/+$/g, "");

  return trimmed === "" ? null : trimmed;
}
