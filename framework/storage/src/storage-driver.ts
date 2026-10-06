import type { Readable, Writable } from "node:stream";

/**
 * Any byte source `putStream()` can drain onto the disk, a Node
 * `Readable`, a web `ReadableStream` (e.g. `new Response("x").body` or a
 * `fetch` body), or any async iterable of chunks.
 */
export type StreamSource = Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/**
 * Laravel's "disk" abstraction: a small, uniform interface over one or
 * more named storage backends, resolved via `StorageManager` (the
 * `Manager<T>` pattern, same as `DatabaseManager`/`CacheManager`).
 *
 * The core is six methods (`put`/`get`/`exists`/`delete`/`url`/`path`);
 * the rest add directory listing, streaming, file metadata and links.
 * Every one is a thing a future driver (`s3`, etc.) has to implement
 * correctly, so they are grouped and documented rather than sprawling.
 */
export interface StorageDriver {
  put(path: string, contents: Buffer | string): Promise<void>;
  get(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  /**
   * A client-facing URL for this file. A local disk with a configured
   * `url` prefix (the Laravel "public" disk) returns that prefix plus
   * the relative path; a private disk (no `url` configured) **throws**,
   * matching Laravel, whose `Storage::url()` raises
   * `"This driver does not support retrieving URLs"` for such a disk.
   * Use `path()` when you
   * actually want the on-disk location. `servePublicDisk()` is the
   * matching HTTP handler for the prefix case. Node can serve the
   * storage root directly, so there is no `storage:link` symlink step.
   */
  url(path: string): string;
  /**
   * The absolute on-disk location of `path`, for server-side use
   * (passing to another process, streaming, etc.), Laravel's
   * `Storage::path()`. Only meaningful for filesystem-backed disks; a
   * future remote driver (S3, etc.) would throw here.
   */
  path(path: string): string;
  /**
   * A URL granting time-limited read access to `path`, Laravel's
   * `Storage::temporaryUrl()`. The answer for a private disk, where
   * `url()` throws.
   *
   * Two strategies produce one interchangeable result. A driver whose
   * backend signs URLs natively does that: `S3StorageDriver` returns a
   * presigned `GetObject` link the bucket itself validates, so the bytes
   * never pass through this process. Every other driver falls back to a
   * signed link at a route this application serves, which verifies the
   * signature and streams the file off the disk.
   *
   * The fallback is opt-in per disk (`temporaryUrls: true` in
   * `config/storage.ts`) and needs that route mounted, so this **throws**
   * on a disk that has neither a native signer nor the fallback wired —
   * rather than returning a link that 404s. The error names the fix.
   *
   * @param expiresIn Lifetime in seconds. Defaults to 5 minutes.
   */
  temporaryUrl(path: string, expiresIn?: number): Promise<string>;

  // ── Listing ──────────────────────────────────────────────────────────
  // Paths returned are disk-relative, POSIX-separated and sorted, so tests
  // are deterministic. A non-existent directory yields `[]` (Laravel), not
  // an error.

  /** Files directly under `directory` (relative paths). */
  files(directory?: string): Promise<string[]>;
  /** Files anywhere under `directory`, recursively. */
  allFiles(directory?: string): Promise<string[]>;
  /** Immediate subdirectories of `directory`. */
  directories(directory?: string): Promise<string[]>;
  /** Subdirectories anywhere under `directory`, recursively. */
  allDirectories(directory?: string): Promise<string[]>;
  /** Convenience one-level listing: `{ files, directories }`. */
  list(directory?: string): Promise<{ files: string[]; directories: string[] }>;

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * A Node `Readable` over the file's bytes. Existence is verified up
   * front so a missing file rejects with `FileNotFoundException` before
   * any chunk, never as a late `ENOENT` on the stream. `start`/`end` are
   * inclusive byte offsets (as `fs.createReadStream`).
   */
  readStream(path: string, options?: { start?: number; end?: number }): Promise<Readable>;
  /**
   * A Node `Writable` to the file; parent directories are created first.
   * The default `flags: "w"` truncates, `"a"` appends. Writes go to a
   * temp sibling and `rename` into place on `finish`, so a crashed write
   * never leaves a partial file at the final path.
   */
  writeStream(path: string, options?: { flags?: "w" | "a" }): Promise<Writable>;
  /**
   * Drain any `Readable` / web `ReadableStream` / async iterable onto the
   * disk, Laravel's `put($path, $resource)`. Atomic like `writeStream`.
   */
  putStream(path: string, source: StreamSource): Promise<void>;

  // ── Metadata / manipulation ──────────────────────────────────────────

  /** Byte length of the file. Throws `FileNotFoundException` if missing. */
  size(path: string): Promise<number>;
  /** Last-modified time. Throws `FileNotFoundException` if missing. */
  lastModified(path: string): Promise<Date>;
  /** Best-effort MIME type from the extension; `undefined` if unknown. */
  mimeType(path: string): Promise<string | undefined>;
  /** Copy a file. Parent dirs of `to` created. Throws if `from` missing. */
  copy(from: string, to: string): Promise<void>;
  /** Move/rename a file. Parent dirs of `to` created. */
  move(from: string, to: string): Promise<void>;
  /** Recursively remove a directory (no error if it doesn't exist). */
  deleteDirectory(directory: string): Promise<void>;
  /** Create a directory (and parents). No error if it already exists. */
  makeDirectory(directory: string): Promise<void>;

  // ── Links ────────────────────────────────────────────────────────────
  // Two names for the same bytes, where the backend has such a notion.
  // Only the filesystem and SFTP drivers do: an object store has no link
  // concept at all, and FTP exposes no command for one, so those throw
  // `UnsupportedDriverFeatureException` rather than quietly copying —
  // a copy has different semantics (independent bytes, double the space)
  // and silently substituting it would be the wrong answer for whatever
  // the caller wanted a link *for*.
  //
  // Both paths are disk-relative and both are guarded, so a link always
  // points at something on the same disk. A target outside the root is
  // refused, not because it is hard but because `LocalStorageDriver`
  // would then refuse to read the file back through its own symlink
  // guard — an escaping link is a file this disk can create and cannot
  // use.
  //
  // Shared contract: `original` must exist (else `FileNotFoundException`),
  // parent directories of `link` are created, and an existing `link` path
  // is an error rather than a silent replace. Use `move()` to overwrite.

  /**
   * A symbolic link at `link` pointing to `original`.
   *
   * The link is a path reference: it survives `original` being replaced
   * and dangles if `original` is deleted. `LocalStorageDriver` stores the
   * target *relative* to the link's own directory, so the storage root
   * can be moved or bind-mounted at another path in a container without
   * every link breaking.
   */
  symlink(original: string, link: string): Promise<void>;

  /**
   * A hard link at `link`: a second directory entry for the same inode.
   *
   * Indistinguishable from `original` afterwards, with no "real one" and
   * no dangling — the bytes live until the last name is removed. Cannot
   * span filesystems, so on a disk whose root straddles a mount point
   * this can fail where `symlink()` succeeds, and directories are
   * rejected by the OS.
   */
  hardlink(original: string, link: string): Promise<void>;

  /**
   * Whether this driver can create links of `kind`, for a caller that
   * would rather branch than catch.
   *
   * Async because the honest answer is not always known locally: SFTP
   * hard links need `hardlink@openssh.com`, which is a property of the
   * server, so answering requires having talked to it. Never throws —
   * a driver that cannot determine support reports `false`.
   */
  supportsLink(kind: "soft" | "hard"): Promise<boolean>;
}
