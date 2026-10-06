import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Connectable } from "@mahiframework/core";
import {
  CommittingWriteStream,
  FileNotFoundException,
  guessMimeType,
  joinPublicUrl,
  toNodeReadable,
  UnsupportedDriverFeatureException,
  type StorageDriver,
  type StreamSource,
  type TemporaryUrlBuilder,
} from "@mahiframework/storage";
import {
  FtpConnection,
  isMissing,
  type FtpConnectionConfig,
  type FileInfo,
} from "./ftp-connection.js";

/** `basic-ftp`'s `FileType` values; imported as data would pull the SDK in eagerly. */
const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;

export interface FtpDiskConfig extends FtpConnectionConfig {
  driver: "ftp";
  /**
   * Public URL prefix, if some *other* server publishes these same files
   * over HTTP. FTP serves no HTTP, so without this `url()` throws.
   */
  url?: string;
  /**
   * Allow `temporaryUrl()` on this disk, served by the stock
   * temporary-URL route. FTP cannot sign a link itself, so this is the
   * only way to get one — and the bytes are proxied through this process,
   * serialised behind any other operation on the connection. Requires
   * `serveTemporaryDiskFile()` to be mounted.
   */
  temporaryUrls?: boolean;
}

/**
 * `StorageDriver` over FTP, for hosts that speak nothing else: NAS boxes,
 * cheap shared hosting, appliances.
 *
 * The same 25 methods and the same contract suite as every other driver,
 * but FTP is the weakest backend of the three and the driver is explicit
 * about where, rather than papering over it:
 *
 * - **Every operation is serialised.** FTP's control connection carries
 *   one command at a time, so there is no concurrency to tune — a
 *   recursive `allFiles()` is sequential round trips. See `FtpConnection`.
 * - **`readStream({ end })` truncates client-side.** `REST` gives a start
 *   offset and FTP has no end offset, so the bytes past `end` cross the
 *   wire and are discarded. The data connection is closed as soon as the
 *   range is satisfied, which matters because `serveStoredFile()` issues
 *   exactly this call for an HTTP `Range` request.
 * - **`lastModified()` costs a round trip per file.** Without `MLSD` a
 *   `LIST` response carries no year and no timezone, and `basic-ftp`
 *   rightly refuses to guess, so the time comes from `MDTM` per file
 *   rather than from the listing.
 * - **Writes create their parent directories first.** FTP's `STOR` fails
 *   with 553 rather than creating them.
 * - **Atomic replace depends on the server.** See `move()`.
 * - **`url()` throws** without a configured prefix, and **`path()` always
 *   throws** — the bytes are on another machine.
 *
 * Plain FTP is **cleartext**, credentials included. Set `secure: true` for
 * FTPS wherever the server supports it.
 */
export class FtpStorageDriver implements StorageDriver, Connectable {
  private readonly connection: FtpConnection;
  private readonly temporaryUrlBuilder?: TemporaryUrlBuilder;

  constructor(
    config: FtpConnectionConfig,
    private readonly urlPrefix?: string,
    options: { temporaryUrl?: TemporaryUrlBuilder } = {},
  ) {
    this.connection = new FtpConnection(config);
    this.temporaryUrlBuilder = options.temporaryUrl;
  }

  /** Open the control connection up front, from a provider's `boot()`. */
  async connect(): Promise<void> {
    await this.connection.connect();
  }

  /** Close the control connection. Called by `disconnectAll()`/`forget()`. */
  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }

  /** The underlying connection, for capability checks and lifecycle. */
  ftp(): FtpConnection {
    return this.connection;
  }

  // ── Core ─────────────────────────────────────────────────────────────

  async put(remotePath: string, contents: Buffer | string): Promise<void> {
    await this.putStream(remotePath, Readable.from([Buffer.from(contents as string | Buffer)]));
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
    try {
      return (await this.statFile(remotePath)) !== undefined;
    } catch {
      // A traversal attempt is "not a file on this disk", matching the
      // local and SFTP drivers rather than leaking the distinction.
      return false;
    }
  }

  async delete(remotePath: string): Promise<void> {
    const full = await this.absolute(remotePath);

    await this.connection.run(async (client) => {
      try {
        await client.remove(full);
      } catch (error) {
        // FTP answers 550 for a missing file; deleting what isn't there is
        // a no-op, matching `force: true`.
        if (!isMissing(error)) {
          throw error;
        }
      }
    });
  }

  url(remotePath: string): string {
    if (this.urlPrefix === undefined || this.urlPrefix === "") {
      throw new Error(
        "This disk has no public URL — it is an ftp disk with no `url` prefix configured. " +
          "FTP serves no HTTP, so a URL only exists if something else publishes the same files; " +
          "configure `url` when that is the case, or stream the file through a route.",
      );
    }

    this.guard(remotePath);

    return joinPublicUrl(this.urlPrefix, remotePath);
  }

  /**
   * Always throws. The bytes are on another machine, so there is no local
   * path, and a remote one handed to `node:fs` fails somewhere far from
   * the cause.
   */
  path(remotePath: string): string {
    throw new Error(
      `The ftp driver has no on-disk path for [${remotePath}] — the file is on another machine. ` +
        "Use readStream()/get() to read it, or serveStoredFile() to serve it.",
    );
  }

  /**
   * A signed, time-limited link at the application's temporary-URL route,
   * which streams the file back over this connection.
   *
   * FTP has no signing of its own, so this needs the fallback wired:
   * `temporaryUrls: true` on the disk, and the route mounted. The bytes
   * are proxied through this process, and because the connection is
   * serialised, concurrent downloads queue behind one another.
   */
  async temporaryUrl(remotePath: string, expiresIn = 300): Promise<string> {
    if (this.temporaryUrlBuilder === undefined) {
      throw new Error(
        `This disk cannot make temporary URLs for [${remotePath}] — FTP has no signed-link ` +
          "mechanism of its own. Set `temporaryUrls: true` on the disk in `config/storage.ts` " +
          'and mount the route (`router.get("/storage/temporary/*", serveTemporaryDiskFile())`).',
      );
    }

    return this.temporaryUrlBuilder(this.guard(remotePath), expiresIn);
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
   * missing directory is `[]` rather than an error.
   */
  private async listOneLevel(
    directory: string,
  ): Promise<{ files: string[]; directories: string[] }> {
    const relative = this.guard(directory);
    const entries = await this.connection.list(await this.absolute(directory));

    const files: string[] = [];
    const directories: string[] = [];

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }

      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.type === FILE_TYPE_DIRECTORY) {
        directories.push(child);
      } else if (entry.type === FILE_TYPE_FILE) {
        files.push(child);
      }
    }

    files.sort();
    directories.sort();

    return { files, directories };
  }

  /**
   * Recursive listing, breadth-first and strictly sequential.
   *
   * No worker pool, unlike the SFTP driver: the control connection takes
   * one command at a time, so concurrent `LIST`s are an error rather than
   * a speed-up. This is the single biggest performance difference between
   * the two drivers, and it is the protocol's, not the implementation's.
   */
  private async walk(directory: string): Promise<{ files: string[]; directories: string[] }> {
    const files: string[] = [];
    const directories: string[] = [];
    const queue: string[] = [directory];

    while (queue.length > 0) {
      const next = queue.shift() as string;
      const level = await this.listOneLevel(next);

      files.push(...level.files);
      directories.push(...level.directories);
      queue.push(...level.directories);
    }

    files.sort();
    directories.sort();

    return { files, directories };
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * A readable for the file's bytes, optionally from a byte offset.
   *
   * `basic-ftp` has no `createReadStream`; it drains a transfer *into* a
   * writable. So a `PassThrough` is handed to `downloadTo` and returned to
   * the caller.
   *
   * `start` maps to FTP's `REST`. `end` has **no** protocol equivalent, so
   * it is enforced here: once enough bytes have arrived the stream ends and
   * the data connection is closed. The remainder of the file is not
   * transferred, but the server has already begun sending it, so a tiny
   * range out of a huge file is not as cheap as it looks.
   */
  async readStream(
    remotePath: string,
    options?: { start?: number; end?: number },
  ): Promise<Readable> {
    const full = await this.absolute(remotePath);

    // One extra round trip, deliberately: the contract is that a missing
    // file rejects before the first chunk rather than emitting a late error
    // at a caller who has already started piping.
    if ((await this.statFile(remotePath)) === undefined) {
      throw new FileNotFoundException(remotePath);
    }

    const start = options?.start ?? 0;
    const limit = options?.end === undefined ? undefined : options.end - start + 1;
    const output = new PassThrough();
    const sink = limit === undefined ? output : truncateAt(output, limit);

    // Not awaited: the transfer runs while the caller reads. Its failure
    // surfaces on the stream, which is the only place the caller is
    // looking.
    void this.connection
      .run(async (client) => client.downloadTo(sink, full, start))
      .then(
        () => {
          if (!sink.destroyed) {
            sink.end();
          }
        },
        (error: unknown) => {
          // A deliberate early stop isn't a failure.
          if (!output.destroyed && !output.writableEnded) {
            output.destroy(error as Error);
          }
        },
      );

    return output;
  }

  /**
   * A writable that lands at `remotePath` only once closed.
   *
   * Same temp-sibling-and-rename as the SFTP driver, via the shared
   * `CommittingWriteStream`, so a crashed write leaves no partial file at
   * the final path. The rename's atomicity depends on the server; see
   * `move()`.
   */
  async writeStream(remotePath: string, options?: { flags?: "w" | "a" }): Promise<Writable> {
    const full = await this.absolute(remotePath);
    await this.makeDirectory(path.posix.dirname(this.guard(remotePath)));

    if (options?.flags === "a") {
      // Appending has no atomic-temp story (it would mean copying the
      // existing file first, over the wire), so it writes in place. Same
      // trade-off the local and SFTP drivers make.
      return this.uploadInto(full, true);
    }

    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
    const replacing = (await this.statFile(remotePath)) !== undefined;

    return new CommittingWriteStream({
      target: await this.uploadInto(temp, false),
      commit: () => this.rename(temp, full, replacing),
      discard: async () => {
        await this.connection.run(async (client) => client.remove(temp)).catch(() => {});
      },
    });
  }

  async putStream(remotePath: string, source: StreamSource): Promise<void> {
    const writable = await this.writeStream(remotePath);
    await pipeline(toNodeReadable(source), writable);
  }

  /**
   * A writable whose bytes become one FTP upload.
   *
   * `uploadFrom` consumes a readable, so the writable end of a
   * `PassThrough` is handed back and `finish` is withheld until the
   * transfer settles — which is what makes `finish` mean "the bytes are on
   * the server" rather than "the bytes left this process".
   */
  private async uploadInto(absolute: string, append: boolean): Promise<Writable> {
    const body = new PassThrough();

    const settled = this.connection
      .run(async (client) =>
        append ? client.appendFrom(body, absolute) : client.uploadFrom(body, absolute),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    return new UploadWriteStream(body, settled);
  }

  // ── Metadata / manipulation ──────────────────────────────────────────

  async size(remotePath: string): Promise<number> {
    const full = await this.absolute(remotePath);

    return this.connection.run(async (client) => {
      try {
        return await client.size(full);
      } catch (error) {
        if (isMissing(error)) {
          throw new FileNotFoundException(remotePath);
        }

        throw error;
      }
    });
  }

  /**
   * The file's modification time, via `MDTM`.
   *
   * Not from the listing: without `MLSD` a `LIST` line carries a
   * human-formatted date with no year and no timezone, which `basic-ftp`
   * refuses to parse rather than guess at. `MDTM` is UTC and exact, at the
   * cost of a round trip per file.
   */
  async lastModified(remotePath: string): Promise<Date> {
    const full = await this.absolute(remotePath);

    return this.connection.run(async (client) => {
      try {
        return await client.lastMod(full);
      } catch (error) {
        if (isMissing(error)) {
          throw new FileNotFoundException(remotePath);
        }

        throw error;
      }
    });
  }

  async mimeType(remotePath: string): Promise<string | undefined> {
    this.guard(remotePath);

    return guessMimeType(remotePath);
  }

  /**
   * Download to a local temp file, then upload it. FTP has no server-side
   * copy, so copying a 40 GB file moves 80 GB over the wire.
   *
   * Via local disk rather than streamed, which is the one place this driver
   * is forced to differ from the SFTP driver's otherwise-identical
   * `copy()`. Streaming would mean a download and an upload **in flight at
   * the same time**, and FTP's single control connection cannot carry two
   * transfers: the second command is rejected with "User launched a task
   * while another one is still running", and `basic-ftp` then closes the
   * client. Serialising them is the only option, and serialising requires
   * somewhere to put the bytes in between.
   *
   * The temp file is in the OS temp directory and removed afterwards, so
   * the cost is disk rather than memory and a large copy still doesn't grow
   * the heap.
   */
  async copy(from: string, to: string): Promise<void> {
    const temp = path.join(tmpdir(), `mahi-ftp-copy-${randomBytes(8).toString("hex")}`);

    try {
      await pipeline(await this.readStream(from), createWriteStream(temp));
      await this.putStream(to, createReadStream(temp));
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  /**
   * A server-side rename, and therefore cheap at any size.
   *
   * Whether it *replaces* an existing destination is the server's choice:
   * the FTP spec doesn't require `RNFR`/`RNTO` to clobber, and
   * implementations differ. vsftpd allows it; others refuse. So a refused
   * rename falls back to delete-then-rename, which has a brief window
   * where the destination doesn't exist. That is a real downgrade, so
   * `replacesAtomically()` reports which one happened rather than hiding
   * it.
   */
  async move(from: string, to: string): Promise<void> {
    if ((await this.statFile(from)) === undefined) {
      throw new FileNotFoundException(from);
    }

    await this.makeDirectory(path.posix.dirname(this.guard(to)));

    const replacing = (await this.statFile(to)) !== undefined;
    await this.rename(await this.absolute(from), await this.absolute(to), replacing);
  }

  /**
   * Rename, falling back to delete-then-rename where the server refuses.
   *
   * `replacing` says whether the destination was known to exist, which is
   * the only case where the outcome tells us anything about the server's
   * clobber behaviour. A rename onto a free path succeeding says nothing.
   */
  private async rename(fromFull: string, toFull: string, replacing = false): Promise<void> {
    await this.connection.run(async (client) => {
      try {
        await client.rename(fromFull, toFull);

        if (replacing) {
          this.connection.recordReplace(true);
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }

        // The destination exists and this server won't clobber it, so the
        // replace is no longer atomic.
        this.connection.recordReplace(false);
        await client.remove(toFull).catch(() => {});
        await client.rename(fromFull, toFull);
      }
    });
  }

  /**
   * Recursive removal, deepest-first. A missing directory is a no-op.
   *
   * `basic-ftp`'s own `removeDir` is avoided: it cds into the target, which
   * leaves the session's working directory somewhere unexpected if it
   * throws partway through.
   */
  async deleteDirectory(directory: string): Promise<void> {
    const relative = this.guard(directory);
    const tree = await this.walk(directory);

    for (const file of tree.files) {
      await this.delete(file);
    }

    // A sorted list has every child after its parent, so reversing removes
    // the deepest directories first — the only order `RMD` accepts.
    for (const child of [...tree.directories].reverse()) {
      await this.removeEmptyDirectory(await this.absolute(child));
    }

    if (relative !== "") {
      await this.removeEmptyDirectory(await this.absolute(directory));
    }
  }

  /**
   * Create a directory and its parents.
   *
   * Delegated to the connection, which restores the working directory
   * afterwards: `ensureDir()` leaves the client cd'd into whatever it
   * created, and every later relative path would resolve from there.
   */
  async makeDirectory(directory: string): Promise<void> {
    await this.connection.ensureDirectory(await this.absolute(directory));
  }

  // ── Links ────────────────────────────────────────────────────────────

  /**
   * Always throws. FTP has no link command.
   *
   * Some servers expose one through `SITE SYMLINK`, but `SITE` is a
   * per-server extension with no portable syntax and no way to discover
   * support short of trying it and parsing prose out of a 500 reply. A
   * driver that worked against one appliance and failed against the next
   * would be worse than one that is clear it cannot do this at all.
   */
  async symlink(original: string, link: string): Promise<void> {
    throw this.noLinks("symbolic links", original, link);
  }

  /** Always throws. There is no hard-link command in FTP either. */
  async hardlink(original: string, link: string): Promise<void> {
    throw this.noLinks("hard links", original, link);
  }

  /** Neither kind. */
  async supportsLink(_kind: "soft" | "hard"): Promise<boolean> {
    return false;
  }

  private noLinks(feature: string, original: string, link: string): Error {
    return new UnsupportedDriverFeatureException(
      "ftp",
      feature,
      `FTP has no link command, so [${link}] cannot refer to [${original}]. ` +
        "Use copy() for independent bytes, or an sftp disk if the host also speaks SSH.",
    );
  }

  private async removeEmptyDirectory(full: string): Promise<void> {
    await this.connection.run(async (client) => {
      try {
        await client.removeEmptyDir(full);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    });
  }

  /**
   * The listing entry for a path, or `undefined` if it isn't a file.
   *
   * A listing of the parent rather than a `SIZE` on the path, because
   * `SIZE` answers 550 for a directory as well as for a missing file, and
   * the contract needs those distinguished: `exists()` on a directory is
   * false, but so is `exists()` on nothing, while `size()` on a directory
   * has to fail.
   */
  private async statFile(remotePath: string): Promise<FileInfo | undefined> {
    const relative = this.guard(remotePath);

    if (relative === "") {
      return undefined;
    }

    const parent = path.posix.dirname(relative);
    const name = path.posix.basename(relative);
    const entries = await this.connection.list(await this.absolute(parent === "." ? "" : parent));

    return entries.find((entry) => entry.name === name && entry.type === FILE_TYPE_FILE);
  }

  /**
   * Normalize a disk-relative path and reject anything escaping the root.
   *
   * Lexical only, like the SFTP driver's guard: the server resolves its own
   * links and enforces its own permissions, and the honest way to confine
   * an FTP account is on the server. What this catches is the `../` that
   * arrives from application code.
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
 * A `Writable` front end for an FTP upload.
 *
 * Writes pass through to the transfer's body, and `_final` waits for the
 * transfer to settle before completing, so `finish` means the server has
 * the bytes. Callers (and `stream.pipeline`) wait on `finish`, so without
 * this they would race the upload.
 */
class UploadWriteStream extends Writable {
  constructor(
    private readonly body: PassThrough,
    private readonly settled: Promise<unknown>,
  ) {
    super();

    // Aborting a write is `stream.destroy(error)`, and Node turns an
    // `error` event with no listener into an uncaught exception, which would
    // make "cancel this upload" a way to kill the process. Callers
    // attaching their own listener still get the error, since this adds one
    // rather than replacing it.
    this.on("error", () => {});
    this.body.on("error", () => {});
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.body.write(chunk as Buffer, encoding)) {
      callback();

      return;
    }

    // Respect the transfer's backpressure rather than buffering the whole
    // upload in this process.
    this.body.once("drain", () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.body.end();

    void this.settled.then((error) => {
      callback(error === undefined ? null : (error as Error));
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // The body must be torn down on *every* destroy path, error or not.
    // `uploadFrom` is reading from it and will not settle while it stays
    // open, and the connection serialises operations, so an abandoned
    // transfer holds the queue forever — the cleanup that follows an
    // aborted write would then wait on the very upload it is cleaning up
    // after. `CommittingWriteStream.closeTarget()` destroys without an
    // error, which is exactly that case.
    if (!this.body.destroyed) {
      this.body.destroy(error ?? new Error("The FTP upload was abandoned before it completed."));
    }

    // Let the transfer settle before reporting, so a caller that checks for
    // the file straight after `close` doesn't race the server.
    const done = (): void => callback(error);
    void this.settled.then(done, done);
  }
}

/**
 * A writable that forwards at most `limit` bytes to `output`, then ends.
 *
 * This is how `readStream({ end })` is honoured: FTP's `REST` positions the
 * start of a transfer and there is no way to ask for an end, so the
 * truncation has to happen on this side. Destroying the sink closes the
 * data connection, which stops the server sending the rest.
 */
function truncateAt(output: PassThrough, limit: number): Writable {
  let written = 0;

  return new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      if (written >= limit) {
        callback();

        return;
      }

      const take = Math.min(chunk.length, limit - written);
      written += take;
      const slice = take === chunk.length ? chunk : chunk.subarray(0, take);

      const proceed = (): void => {
        if (written >= limit && !output.writableEnded) {
          output.end();
        }

        callback();
      };

      if (output.write(slice)) {
        proceed();

        return;
      }

      output.once("drain", proceed);
    },
    final(callback): void {
      if (!output.writableEnded) {
        output.end();
      }

      callback();
    },
  });
}
