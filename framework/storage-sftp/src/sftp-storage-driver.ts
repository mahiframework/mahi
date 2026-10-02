import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Connectable } from "@mahiframework/core";
import {
  CommittingWriteStream,
  FileNotFoundException,
  guessMimeType,
  joinPublicUrl,
  toNodeReadable,
  type StorageDriver,
  type StreamSource,
} from "@mahiframework/storage";
import type { SFTPWrapper, Stats } from "ssh2";
import {
  SftpConnection,
  isNoSuchFile,
  promisify,
  type SftpConnectionConfig,
} from "./sftp-connection.js";

export interface SftpDiskConfig extends SftpConnectionConfig {
  driver: "sftp";
  /**
   * Public URL prefix, if some *other* server publishes these same files
   * over HTTP (a media server in front of the same directory, a CDN).
   * There is no way to derive one from SFTP itself, so without this
   * `url()` throws.
   */
  url?: string;
}

/**
 * `StorageDriver` over SFTP, for files that live on another machine: a
 * NAS, a seedbox, a media server that isn't mounted locally.
 *
 * The same 21 methods as the local driver and the same contract suite,
 * but three of its guarantees cost real work over a network, and two of
 * them can't be met at all:
 *
 * - **`readStream` stats before opening.** A missing file rejects with
 *   `FileNotFoundException` up front, never as a late error on the
 *   stream, which is one extra round trip per read and the reason the
 *   contract holds.
 * - **`writeStream`/`putStream` write to a temp sibling and rename.** On
 *   a server offering `posix-rename@openssh.com` (OpenSSH, so almost
 *   all of them) that rename is an atomic replace. Elsewhere it degrades
 *   to unlink-then-rename, which has a window where the path is absent.
 *   See `SftpConnection.rename`.
 * - **Recursive listing is concurrency-bounded.** `allFiles()` is one
 *   `readdir` per directory; they all share one SSH channel, so the
 *   bound caps in-flight promises rather than throughput.
 * - **`url()` throws** unless a `url` prefix is configured, because SFTP
 *   has no public URLs. A prefix only makes sense when something else
 *   serves the same bytes over HTTP.
 * - **`path()` throws.** The bytes are on another machine; returning a
 *   remote path that `node:fs` would then fail to open is worse than
 *   refusing.
 *
 * **`copy()` is a download and re-upload through this client.** SFTP has
 * no server-side copy, so copying a 40 GB file moves 80 GB over the
 * wire. It is streamed, so it costs no memory, but it is not the cheap
 * metadata operation the local driver's `copyFile` is. `move()` is a
 * real server-side rename and *is* cheap.
 */
export class SftpStorageDriver implements StorageDriver, Connectable {
  private readonly connection: SftpConnection;

  constructor(
    config: SftpConnectionConfig,
    private readonly urlPrefix?: string,
  ) {
    this.connection = new SftpConnection(config);
  }

  /** Open the SSH session up front, from a provider's `boot()`. */
  async connect(): Promise<void> {
    await this.connection.connect();
  }

  /** Close the SSH session. Called by `StorageManager.disconnectAll()`/`forget()`. */
  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }

  /** The underlying connection, for capability checks (`replacesAtomically()`) and lifecycle. */
  sftp(): SftpConnection {
    return this.connection;
  }

  // ── Core ─────────────────────────────────────────────────────────────

  async put(remotePath: string, contents: Buffer | string): Promise<void> {
    const relative = this.guard(remotePath);
    await this.putStream(relative, Readable.from([Buffer.from(contents as string | Buffer)]));
  }

  async get(remotePath: string): Promise<Buffer> {
    const stream = await this.readStream(remotePath);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }

    return Buffer.concat(chunks);
  }

  async exists(remotePath: string): Promise<boolean> {
    let full: string;

    try {
      full = await this.absolute(remotePath);
    } catch {
      // A traversal attempt is "not a file on this disk", same as the
      // local driver, whose `exists()` also refuses to leak it.
      return false;
    }

    return (await this.connection.stat(full)) !== undefined;
  }

  async delete(remotePath: string): Promise<void> {
    const full = await this.absolute(remotePath);

    await this.connection.run(async (sftp) => {
      try {
        await promisify<void>((cb) => sftp.unlink(full, cb));
      } catch (error) {
        // Deleting what isn't there is a no-op, matching `force: true`.
        if (!isNoSuchFile(error)) {
          throw error;
        }
      }
    });
  }

  url(remotePath: string): string {
    if (this.urlPrefix === undefined || this.urlPrefix === "") {
      throw new Error(
        "This disk has no public URL — it is an sftp disk with no `url` prefix configured. " +
          "SFTP serves no HTTP, so a URL only exists if something else publishes the same files; " +
          "configure `url` when that is the case, or stream the file through a route.",
      );
    }

    this.guard(remotePath);

    return joinPublicUrl(this.urlPrefix, remotePath);
  }

  /**
   * Always throws. The bytes are on another machine, so there is no local
   * path, and a remote one handed to `node:fs` fails somewhere far from
   * the cause. Use `readStream()`/`get()`, or `serveStoredFile()` to put
   * a route in front of the file.
   */
  path(remotePath: string): string {
    throw new Error(
      `The sftp driver has no on-disk path for [${remotePath}] — the file is on another machine. ` +
        "Use readStream()/get() to read it, or serveStoredFile() to serve it.",
    );
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async files(directory = ""): Promise<string[]> {
    return (await this.listOneLevel(directory)).files;
  }

  async directories(directory = ""): Promise<string[]> {
    return (await this.listOneLevel(directory)).directories;
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
   * One directory level, sorted, disk-relative and POSIX-separated. A
   * missing directory is `[]` rather than an error, like every other
   * driver.
   */
  private async listOneLevel(
    directory: string,
  ): Promise<{ files: string[]; directories: string[] }> {
    const relative = this.guard(directory);
    const full = await this.absolute(directory);

    const entries = await this.connection.run(async (sftp) => {
      try {
        return await promisify<import("ssh2").FileEntryWithStats[]>((cb) => sftp.readdir(full, cb));
      } catch (error) {
        if (isNoSuchFile(error)) {
          return undefined;
        }

        throw error;
      }
    });

    if (entries === undefined) {
      return { files: [], directories: [] };
    }

    const files: string[] = [];
    const directories: string[] = [];

    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") {
        continue;
      }

      const child = relative === "" ? entry.filename : `${relative}/${entry.filename}`;

      if (entry.attrs.isDirectory()) {
        directories.push(child);
      } else if (entry.attrs.isFile()) {
        files.push(child);
      }
    }

    files.sort();
    directories.sort();

    return { files, directories };
  }

  /**
   * Recursive listing with a bounded number of `readdir`s in flight.
   *
   * Breadth-first with a worker pool rather than a recursive descent: the
   * depth of the tree then costs nothing (no nested awaits held open per
   * level), and the bound is on requests rather than on recursion. The
   * results are sorted at the end, so the traversal order is free to be
   * whatever is fastest.
   */
  private async walk(directory: string): Promise<{ files: string[]; directories: string[] }> {
    const files: string[] = [];
    const directories: string[] = [];
    const queue: string[] = [directory];
    const workers = Math.min(this.connection.concurrency(), 32);

    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift();

        if (next === undefined) {
          return;
        }

        const level = await this.listOneLevel(next);
        files.push(...level.files);
        directories.push(...level.directories);
        queue.push(...level.directories);
      }
    };

    // The pool drains a shared queue that the workers themselves extend,
    // so a worker that runs out of work while another is still
    // discovering subdirectories has to come back. Looping until the
    // queue is empty is what makes a tree deeper than the bound complete.
    while (queue.length > 0) {
      await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, () => worker()));
    }

    files.sort();
    directories.sort();

    return { files, directories };
  }

  // ── Streaming ────────────────────────────────────────────────────────

  async readStream(
    remotePath: string,
    options?: { start?: number; end?: number },
  ): Promise<Readable> {
    const full = await this.absolute(remotePath);
    // One extra round trip, deliberately: the contract is that a missing
    // file rejects before the first chunk rather than emitting a late
    // error at a caller who has already started piping.
    const stats = await this.connection.stat(full);

    if (stats === undefined || !stats.isFile()) {
      throw new FileNotFoundException(remotePath);
    }

    return this.connection.run(
      async (sftp) => sftp.createReadStream(full, { ...options, autoClose: true }) as Readable,
    );
  }

  async writeStream(remotePath: string, options?: { flags?: "w" | "a" }): Promise<Writable> {
    const full = await this.absolute(remotePath);
    await this.makeDirectory(path.posix.dirname(this.guard(remotePath)));

    if (options?.flags === "a") {
      // Appending has no atomic-temp story (it would mean copying the
      // existing file first, over the wire), so it writes in place. Same
      // trade-off the local driver makes.
      return this.connection.run(async (sftp) =>
        finishOnClose(sftp.createWriteStream(full, { flags: "a" }) as Writable),
      );
    }

    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`;

    return this.connection.run(async (sftp) => {
      return new CommittingWriteStream({
        target: sftp.createWriteStream(temp, { flags: "w" }) as Writable,
        commit: () => this.connection.rename(temp, full),
        discard: () =>
          promisify<void>((cb) => sftp.unlink(temp, () => cb(undefined))).catch(() => {}),
      });
    });
  }

  async putStream(remotePath: string, source: StreamSource): Promise<void> {
    const writable = await this.writeStream(remotePath);
    await pipeline(toNodeReadable(source), writable);
  }

  // ── Metadata / manipulation ──────────────────────────────────────────

  async size(remotePath: string): Promise<number> {
    return (await this.statFile(remotePath)).size;
  }

  async lastModified(remotePath: string): Promise<Date> {
    // SFTP reports mtime in whole seconds.
    return new Date((await this.statFile(remotePath)).mtime * 1000);
  }

  async mimeType(remotePath: string): Promise<string | undefined> {
    this.guard(remotePath);

    return guessMimeType(remotePath);
  }

  /**
   * Download and re-upload, streamed through this client. SFTP has no
   * server-side copy primitive, so the bytes make a round trip: a 40 GB
   * copy is 80 GB over the wire. Memory is flat regardless of size.
   */
  async copy(from: string, to: string): Promise<void> {
    const source = await this.readStream(from);
    await this.putStream(to, source);
  }

  /** A server-side rename, and therefore cheap regardless of file size. */
  async move(from: string, to: string): Promise<void> {
    const fromFull = await this.absolute(from);
    const stats = await this.connection.stat(fromFull);

    if (stats === undefined || !stats.isFile()) {
      throw new FileNotFoundException(from);
    }

    await this.makeDirectory(path.posix.dirname(this.guard(to)));
    await this.connection.rename(fromFull, await this.absolute(to));
  }

  /**
   * Recursive removal. SFTP's `rmdir` only unlinks an empty directory, so
   * the tree is listed and deleted bottom-up. A missing directory is a
   * no-op.
   */
  async deleteDirectory(directory: string): Promise<void> {
    const relative = this.guard(directory);
    const tree = await this.walk(directory);

    for (const file of tree.files) {
      await this.delete(file);
    }

    // Deepest first: a directory can only be removed once empty, and a
    // sorted list has every child after its parent.
    for (const child of [...tree.directories].reverse()) {
      await this.removeEmptyDirectory(await this.absolute(child));
    }

    if (relative !== "") {
      await this.removeEmptyDirectory(await this.absolute(directory));
    }
  }

  /**
   * Create a directory and its parents. SFTP has no recursive `mkdir`, so
   * this walks down from the root, and treats "already exists" as
   * success, which is also what makes it safe to call concurrently.
   */
  async makeDirectory(directory: string): Promise<void> {
    const relative = this.guard(directory);

    if (relative === "" || relative === ".") {
      // The root itself, which still has to exist before anything can be
      // written into it.
      await this.makeDirectoryPath(await this.connection.remoteRoot());

      return;
    }

    const root = await this.connection.remoteRoot();
    let current = root;

    for (const segment of relative.split("/")) {
      current = `${current}/${segment}`;
      await this.makeDirectoryPath(current);
    }
  }

  /** `mkdir` one level, tolerating "already exists". */
  private async makeDirectoryPath(full: string): Promise<void> {
    await this.connection.run(async (sftp) => {
      try {
        await promisify<void>((cb) => sftp.mkdir(full, cb));
      } catch (error) {
        // SFTP reports an existing directory as a generic FAILURE, which
        // is indistinguishable from other failures by code alone, so a
        // `stat` decides whether this was actually a problem.
        const stats = await this.connection.stat(full).catch(() => undefined);

        if (stats?.isDirectory()) {
          return;
        }

        throw error;
      }
    });
  }

  private async removeEmptyDirectory(full: string): Promise<void> {
    await this.connection.run(async (sftp) => {
      try {
        await promisify<void>((cb) => sftp.rmdir(full, cb));
      } catch (error) {
        if (!isNoSuchFile(error)) {
          throw error;
        }
      }
    });
  }

  private async statFile(remotePath: string): Promise<Stats> {
    const stats = await this.connection.stat(await this.absolute(remotePath));

    if (stats === undefined || !stats.isFile()) {
      throw new FileNotFoundException(remotePath);
    }

    return stats;
  }

  /**
   * Normalize a disk-relative path and reject anything escaping the root.
   *
   * Purely lexical, and that is the whole guard here. The local driver
   * additionally `realpath`s every target because a symlink inside its
   * root can point outside it; over SFTP the server resolves symlinks and
   * enforces its own permissions, and the honest way to confine a remote
   * user is on the server (a chrooted SFTP account), not by a client-side
   * check it can't back up. The lexical check still catches the case that
   * matters in application code: a `../` arriving in a user-supplied
   * path.
   */
  private guard(remotePath: string): string {
    const normalized = path.posix
      .normalize(remotePath.split("\\").join("/"))
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    if (normalized === "." || normalized === "") {
      return "";
    }

    if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(remotePath)) {
      throw new Error(`Path [${remotePath}] escapes the storage root.`);
    }

    return normalized;
  }

  /** The absolute remote path for a disk-relative one, after the guard. */
  private async absolute(remotePath: string): Promise<string> {
    const relative = this.guard(remotePath);
    const root = await this.connection.remoteRoot();

    return relative === "" ? root : `${root}/${relative}`;
  }
}

/**
 * Make an ssh2 SFTP `WriteStream` emit `finish`.
 *
 * ssh2 constructs its write streams with `emitClose: false` and
 * `autoDestroy: false`, and its `_final` calls `destroy()` before
 * invoking the callback, so the stream emits `close` and **never**
 * `finish`. Every caller of `writeStream()` waits on `finish` (as does
 * `stream.pipeline`, and so `putStream`), which against a raw ssh2 stream
 * means waiting forever.
 *
 * `close` is the point at which ssh2 has closed the remote handle, which
 * is what `finish` is supposed to mean here, so it is re-emitted under
 * the name the contract uses. Only the non-atomic append path needs this;
 * the default path is wrapped in a `CommittingWriteStream`, which is a
 * real Node `Writable` and emits `finish` itself.
 */
function finishOnClose(stream: Writable): Writable {
  stream.once("close", () => {
    if (!stream.destroyed || stream.writableEnded) {
      stream.emit("finish");
    }
  });

  return stream;
}

/** Type-only re-export so `SFTPWrapper` stays internal to this module's signatures. */
export type { SFTPWrapper };
