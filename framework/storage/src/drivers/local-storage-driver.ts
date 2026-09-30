import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { guessMimeType } from "../mime-types.js";
import pathModule from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { joinPublicUrl } from "../public-url.js";
import { CommittingWriteStream } from "../committing-write-stream.js";
import { FileNotFoundException } from "../exceptions.js";
import type { StorageDriver, StreamSource } from "../storage-driver.js";

/**
 * Filesystem-backed `StorageDriver`, the only built-in driver in the
 * first pass (S3/streaming uploads are deferred). All paths are resolved
 * relative to `root` and guarded against path traversal escaping it, a
 * real security requirement, not just API surface.
 *
 * The guard is two-layered: a lexical `path.resolve` check rejects `..`
 * segments and absolute paths, and, because a lexical check alone is
 * fooled by a symlink inside the root pointing outside it (`link.txt ->
 * ../../secret`), every read/write also `realpath`s the resolved target
 * (or its nearest existing ancestor, for a not-yet-created file) and
 * re-checks it against the `realpath`'d root before touching the disk.
 *
 * Pass `urlPrefix` (the disk's `url` config key) to make `url()` return
 * an HTTP URL instead of a filesystem path. That's the Laravel "public"
 * disk. Omit it for a private disk.
 */
export class LocalStorageDriver implements StorageDriver {
  constructor(
    private root: string,
    private urlPrefix?: string,
  ) {}

  /**
   * Lexical containment check only, rejects `..`/absolute escapes but is
   * blind to symlinks. Callers that touch the filesystem must additionally
   * go through `resolveReal()`; this is the cheap synchronous guard used by
   * `url()`/`path()` (which return a location without dereferencing it).
   */
  private resolve(path: string): string {
    const rootResolved = pathModule.resolve(this.root);
    const full = pathModule.resolve(rootResolved, path);

    if (full !== rootResolved && !full.startsWith(rootResolved + pathModule.sep)) {
      throw new Error(`Path [${path}] escapes the storage root.`);
    }

    return full;
  }

  /**
   * Lexical guard, then symlink-aware guard: `realpath` the resolved target
   * (or, when it doesn't exist yet, its nearest existing ancestor) and
   * confirm the *canonical* location is still inside the canonical root. A
   * symlink inside the root that points outside it therefore fails here even
   * though it passes the lexical check.
   */
  private async resolveReal(path: string): Promise<string> {
    const full = this.resolve(path);
    const rootReal = await fs.realpath(pathModule.resolve(this.root));

    // Refuse a *dangling* symlink at the target, one pointing at a
    // not-yet-existent file. Its `realpath` is ENOENT, so the walk below
    // would fall through to checking the (in-root) parent and wrongly allow
    // a `put()` to write through it to an outside path. A symlink whose
    // target exists is still vetted by the realpath check below.
    const link = await fs.lstat(full).catch(() => null);

    if (link?.isSymbolicLink()) {
      const target = await fs.realpath(full).catch(() => null);

      if (target === null) {
        throw new Error(`Path [${path}] escapes the storage root.`);
      }
    }

    let existing = full;

    // Walk up to the nearest ancestor that exists. The file itself may not
    // (a `put()` of a new path); its parent chain still must not escape.
    for (;;) {
      try {
        const real = await fs.realpath(existing);

        if (real !== rootReal && !real.startsWith(rootReal + pathModule.sep)) {
          throw new Error(`Path [${path}] escapes the storage root.`);
        }

        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }

        const parent = pathModule.dirname(existing);

        if (parent === existing) {
          break;
        }

        existing = parent;
      }
    }

    return full;
  }

  async put(path: string, contents: Buffer | string): Promise<void> {
    const full = this.resolve(path);
    await fs.mkdir(pathModule.dirname(full), { recursive: true });
    // Re-check after mkdir so a symlinked parent directory is caught before
    // we write through it, and refuse to follow a symlink at the target.
    await this.resolveReal(path);
    await fs.writeFile(full, contents, { flag: "w" });
  }

  async get(path: string): Promise<Buffer> {
    const full = await this.resolveReal(path);

    try {
      return await fs.readFile(full);
    } catch (error) {
      // A missing file is the typed exception, like every other
      // read-oriented method, rather than a bare ENOENT that a caller
      // would have to match on `code` to recognise.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileNotFoundException(path);
      }

      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.resolveReal(path).then(
      (full) =>
        fs.access(full).then(
          () => true,
          () => false,
        ),
      () => false,
    );
  }

  async delete(path: string): Promise<void> {
    await fs.rm(await this.resolveReal(path), { force: true });
  }

  url(path: string): string {
    if (this.urlPrefix === undefined || this.urlPrefix === "") {
      throw new Error(
        "This disk does not support retrieving URLs — it has no `url` prefix configured (it is a private disk). " +
          "Use `path()` for the on-disk filesystem location, or serve it through a route.",
      );
    }

    // Still resolve to enforce the path-traversal guard before building a URL.
    this.resolve(path);

    return joinPublicUrl(this.urlPrefix, path);
  }

  /**
   * The on-disk location for `path`, after the lexical traversal guard.
   *
   * This is a LOCATION, not a vetted file: it is synchronous and does not
   * dereference symlinks, so a symlink inside the root pointing outside it
   * passes here. Every method on this driver that actually touches the
   * filesystem re-checks through the symlink-aware `resolveReal()`. Prefer
   * those (`get()`, `put()`, `readStream()`, …) over handing this string to
   * `node:fs` yourself.
   */
  path(path: string): string {
    return this.resolve(path);
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async files(directory = ""): Promise<string[]> {
    return this.listOneLevel(directory).then((entry) => entry.files);
  }

  async directories(directory = ""): Promise<string[]> {
    return this.listOneLevel(directory).then((entry) => entry.directories);
  }

  async list(directory = ""): Promise<{ files: string[]; directories: string[] }> {
    return this.listOneLevel(directory);
  }

  async allFiles(directory = ""): Promise<string[]> {
    return (await this.walk(directory)).files;
  }

  async allDirectories(directory = ""): Promise<string[]> {
    return (await this.walk(directory)).directories;
  }

  /**
   * One directory level. A missing directory yields empty arrays (Laravel
   * behaviour) rather than throwing; anything else propagates. Paths are
   * disk-relative, POSIX-separated and sorted.
   */
  private async listOneLevel(
    directory: string,
  ): Promise<{ files: string[]; directories: string[] }> {
    const full = await this.resolveReal(directory);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(full, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { files: [], directories: [] };
      }

      throw error;
    }

    const files: string[] = [];
    const directories: string[] = [];

    for (const entry of entries) {
      const rel = this.toRelative(pathModule.join(directory, entry.name));

      if (entry.isDirectory()) {
        directories.push(rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }

    files.sort();
    directories.sort();

    return { files, directories };
  }

  /** Recursive listing, depth-first, accumulating relative file/dir paths. */
  private async walk(directory: string): Promise<{ files: string[]; directories: string[] }> {
    const files: string[] = [];
    const directories: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const level = await this.listOneLevel(dir);
      files.push(...level.files);

      for (const sub of level.directories) {
        directories.push(sub);
        await visit(sub);
      }
    };
    await visit(directory);
    files.sort();
    directories.sort();

    return { files, directories };
  }

  /** Turn an on-disk-joined path back into a sorted-friendly relative POSIX path. */
  private toRelative(joined: string): string {
    return joined.split(pathModule.sep).join("/").replace(/^\/+/, "");
  }

  // ── Streaming ────────────────────────────────────────────────────────

  async readStream(path: string, options?: { start?: number; end?: number }): Promise<Readable> {
    const full = await this.resolveReal(path);
    // Verify existence up front so a missing file is a typed rejection,
    // not a late `ENOENT` emitted on the stream after the caller has
    // already started piping it.
    const stat = await fs.stat(full).catch(() => null);

    if (stat === null || !stat.isFile()) {
      throw new FileNotFoundException(path);
    }

    return createReadStream(full, options);
  }

  async writeStream(path: string, options?: { flags?: "w" | "a" }): Promise<Writable> {
    const full = this.resolve(path);
    await fs.mkdir(pathModule.dirname(full), { recursive: true });
    await this.resolveReal(path);

    // Appending has no atomic-temp story (we'd have to copy the existing
    // file first); write straight to the target for `"a"`.
    if (options?.flags === "a") {
      return createWriteStream(full, { flags: "a" });
    }

    // Write to a temp sibling and rename into place once the caller has
    // finished, so a crashed or aborted write never leaves a partial file
    // visible at the final path. `CommittingWriteStream` is what makes
    // `finish` fire *after* the rename, so a caller that awaits it can
    // immediately read the file back.
    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`;

    return new CommittingWriteStream({
      target: createWriteStream(temp, { flags: "w" }),
      commit: () => fs.rename(temp, full),
      discard: () => fs.rm(temp, { force: true }),
    });
  }

  async putStream(path: string, source: StreamSource): Promise<void> {
    const readable = toNodeReadable(source);
    const writable = await this.writeStream(path);
    await pipeline(readable, writable);
  }

  // ── Metadata / manipulation ──────────────────────────────────────────

  async size(path: string): Promise<number> {
    return (await this.statFile(path)).size;
  }

  async lastModified(path: string): Promise<Date> {
    return (await this.statFile(path)).mtime;
  }

  async mimeType(path: string): Promise<string | undefined> {
    this.resolve(path);

    return guessMimeType(path);
  }

  async copy(from: string, to: string): Promise<void> {
    const fromFull = await this.resolveReal(from);

    if (
      !(await fs.stat(fromFull).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new FileNotFoundException(from);
    }

    const toFull = this.resolve(to);
    await fs.mkdir(pathModule.dirname(toFull), { recursive: true });
    await this.resolveReal(to);
    await fs.copyFile(fromFull, toFull);
  }

  async move(from: string, to: string): Promise<void> {
    const fromFull = await this.resolveReal(from);

    if (
      !(await fs.stat(fromFull).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new FileNotFoundException(from);
    }

    const toFull = this.resolve(to);
    await fs.mkdir(pathModule.dirname(toFull), { recursive: true });
    await this.resolveReal(to);
    await fs.rename(fromFull, toFull);
  }

  async deleteDirectory(directory: string): Promise<void> {
    await fs.rm(await this.resolveReal(directory), { recursive: true, force: true });
  }

  async makeDirectory(directory: string): Promise<void> {
    const full = this.resolve(directory);
    await fs.mkdir(full, { recursive: true });
    await this.resolveReal(directory);
  }

  /** `stat` the target as a file, mapping "not a file"/ENOENT to a typed error. */
  private async statFile(path: string): Promise<import("node:fs").Stats> {
    const full = await this.resolveReal(path);
    const stat = await fs.stat(full).catch(() => null);

    if (stat === null || !stat.isFile()) {
      throw new FileNotFoundException(path);
    }

    return stat;
  }
}

/**
 * Normalize any accepted stream source into a Node `Readable`. A Node
 * `Readable` passes through; a web `ReadableStream` is adapted via
 * `Readable.fromWeb`; anything else async-iterable goes through
 * `Readable.from`.
 */
function toNodeReadable(source: StreamSource): Readable {
  if (source instanceof Readable) {
    return source;
  }

  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    // `Readable.fromWeb` wants node:stream/web's ReadableStream; the global
    // (DOM) one is structurally identical at runtime.
    return Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
  }

  return Readable.from(source as AsyncIterable<Uint8Array>);
}
