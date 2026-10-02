import path from "node:path";
import { PassThrough, Readable, type Writable } from "node:stream";
import {
  FileNotFoundException,
  guessMimeType,
  joinPublicUrl,
  toNodeReadable,
  type StorageDriver,
  type StreamSource,
} from "@mahiframework/storage";
import {
  S3Connection,
  loadPresigner,
  loadUpload,
  type S3ConnectionConfig,
} from "./s3-connection.js";

export interface S3DiskConfig extends S3ConnectionConfig {
  driver: "s3";
  /**
   * Public URL prefix — a CDN, or the bucket's own public endpoint. S3
   * URLs depend on the bucket's policy, which this driver cannot read, so
   * nothing is derived automatically: without a prefix `url()` throws.
   */
  url?: string;
}

/**
 * `StorageDriver` over S3 and anything speaking its protocol: AWS,
 * Cloudflare R2, DigitalOcean Spaces, MinIO, Supabase, Backblaze.
 *
 * The same 21 methods and the same contract suite as the local driver,
 * but a bucket is a flat key/value store rather than a filesystem, and
 * four of the contract's guarantees need deliberate work because of it:
 *
 * - **Atomic writes are free, so there is no temp-and-rename.** A
 *   multipart upload is invisible until `CompleteMultipartUpload`, and
 *   aborting leaves no object at the key and no dangling upload. The
 *   `CommittingWriteStream` dance the local and SFTP drivers need exists
 *   to fake exactly this guarantee, so copying it here would be pure
 *   cost.
 * - **Directories do not exist, so `makeDirectory()` writes a marker.** A
 *   zero-byte object at `prefix/` is what makes an empty directory
 *   visible to `directories()`, and every listing filters keys ending in
 *   `/` so the marker never surfaces as a file.
 * - **Listings are paginated.** One request returns at most 1000 keys, so
 *   both the one-level and recursive listings loop the continuation
 *   token. `allFiles()` on a large bucket is therefore many round trips.
 * - **`copy()` is server-side**, unlike SFTP's download-and-re-upload.
 *   Copying a 40 GB object costs no client bandwidth.
 *
 * **`url()` throws** without a configured `url` prefix: whether a bucket
 * is publicly readable is a property of its policy, not of this config.
 * **`path()` always throws** — the bytes are not on this machine.
 * `temporaryUrl()` is the honest answer for private buckets.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly connection: S3Connection;

  constructor(
    config: S3ConnectionConfig,
    private readonly urlPrefix?: string,
  ) {
    this.connection = new S3Connection(config);
  }

  /**
   * Release the client's pooled sockets. Called by
   * `StorageManager.disconnectAll()`/`forget()`, which narrow on
   * `isDisconnectable()` separately from `isConnectable()`.
   *
   * There is deliberately no `connect()`: an `S3Client` has no session to
   * open, so a `connect()` here would be a method that exists only to
   * give a lifecycle hook something to call.
   */
  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }

  /** The underlying bucket handle, for lifecycle and key arithmetic. */
  s3(): S3Connection {
    return this.connection;
  }

  // ── Core ─────────────────────────────────────────────────────────────

  async put(objectPath: string, contents: Buffer | string): Promise<void> {
    await this.putStream(objectPath, Readable.from([Buffer.from(contents as string | Buffer)]));
  }

  async get(objectPath: string): Promise<Buffer> {
    const stream = await this.readStream(objectPath);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }

    return Buffer.concat(chunks);
  }

  async exists(objectPath: string): Promise<boolean> {
    let key: string;

    try {
      key = this.key(objectPath);
    } catch {
      // A traversal attempt is "not a file on this disk", matching the
      // local and SFTP drivers rather than leaking the distinction.
      return false;
    }

    return (await this.connection.head(key)) !== undefined;
  }

  async delete(objectPath: string): Promise<void> {
    const key = this.key(objectPath);
    const sdk = await this.connection.commands();

    // `DeleteObject` on a missing key already succeeds, so the contract's
    // "deleting what isn't there is a no-op" needs nothing here.
    await this.connection.run((client) =>
      client.send(new sdk.DeleteObjectCommand({ Bucket: this.connection.bucket(), Key: key })),
    );
  }

  url(objectPath: string): string {
    if (this.urlPrefix === undefined || this.urlPrefix === "") {
      throw new Error(
        "This disk has no public URL — it is an s3 disk with no `url` prefix configured. " +
          "Whether a bucket is publicly readable depends on its policy, which this driver cannot " +
          "know, so configure `url` with the CDN or public endpoint in front of it, or use " +
          "temporaryUrl() for a signed link to a private object.",
      );
    }

    this.guard(objectPath);

    return joinPublicUrl(this.urlPrefix, objectPath);
  }

  /**
   * Always throws. The bytes are in a bucket, so there is no local path,
   * and inventing one that `node:fs` would then fail to open moves the
   * error far from its cause.
   */
  path(objectPath: string): string {
    throw new Error(
      `The s3 driver has no on-disk path for [${objectPath}] — the file is in object storage. ` +
        "Use readStream()/get() to read it, or serveStoredFile() to serve it.",
    );
  }

  /**
   * A presigned URL granting time-limited read access to a private object.
   *
   * Not part of `StorageDriver`: a local disk and an SFTP disk cannot
   * honour it, and putting it on the interface would mean three drivers
   * implementing a method only to throw. Reach for the concrete class, the
   * way `LocalStorageDriver.path()` is reached for.
   *
   * @param expiresIn Lifetime in seconds. Defaults to 5 minutes.
   */
  async temporaryUrl(objectPath: string, expiresIn = 300): Promise<string> {
    const key = this.key(objectPath);
    const sdk = await this.connection.commands();
    const { getSignedUrl } = await loadPresigner();

    return this.connection.run((client) =>
      getSignedUrl(
        client,
        new sdk.GetObjectCommand({ Bucket: this.connection.bucket(), Key: key }),
        { expiresIn },
      ),
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
   * One level, via a delimited listing: `Contents` is the files and
   * `CommonPrefixes` is the subdirectories, both from one request. A
   * missing prefix simply returns nothing, so the contract's "a
   * non-existent directory is `[]`" holds for free.
   */
  private async listOneLevel(
    directory: string,
  ): Promise<{ files: string[]; directories: string[] }> {
    const relative = this.guard(directory);
    const prefix = this.prefix(relative);
    const sdk = await this.connection.commands();

    const files: string[] = [];
    const directories: string[] = [];
    let token: string | undefined;

    do {
      const page = await this.connection.run((client) =>
        client.send(
          new sdk.ListObjectsV2Command({
            Bucket: this.connection.bucket(),
            Prefix: prefix,
            Delimiter: "/",
            MaxKeys: this.connection.pageSize(),
            ContinuationToken: token,
          }),
        ),
      );

      for (const object of page.Contents ?? []) {
        const name = this.nameFrom(object.Key, prefix);

        // A key ending in `/` is a directory marker, not a file. Without
        // this it would surface as a zero-byte file with an empty name.
        if (name !== undefined && !name.endsWith("/")) {
          files.push(relative === "" ? name : `${relative}/${name}`);
        }
      }

      for (const common of page.CommonPrefixes ?? []) {
        const name = this.nameFrom(common.Prefix, prefix)?.replace(/\/$/, "");

        if (name !== undefined && name !== "") {
          directories.push(relative === "" ? name : `${relative}/${name}`);
        }
      }

      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    files.sort();
    directories.sort();

    return { files, directories };
  }

  /**
   * Recursive listing: one undelimited prefix scan, paginated.
   *
   * No tree walk and no concurrency bound, unlike SFTP — a bucket is flat,
   * so every descendant key arrives from the same scan. Directories are
   * inferred from the key paths, plus any explicit markers, so an empty
   * directory created with `makeDirectory()` still appears.
   */
  private async walk(directory: string): Promise<{ files: string[]; directories: string[] }> {
    const relative = this.guard(directory);
    const prefix = this.prefix(relative);
    const sdk = await this.connection.commands();

    const files: string[] = [];
    const directories = new Set<string>();
    let token: string | undefined;

    do {
      const page = await this.connection.run((client) =>
        client.send(
          new sdk.ListObjectsV2Command({
            Bucket: this.connection.bucket(),
            Prefix: prefix,
            MaxKeys: this.connection.pageSize(),
            ContinuationToken: token,
          }),
        ),
      );

      for (const object of page.Contents ?? []) {
        const name = this.nameFrom(object.Key, prefix);

        if (name === undefined || name === "") {
          continue;
        }

        const full = relative === "" ? name : `${relative}/${name}`;

        if (name.endsWith("/")) {
          // An explicit directory marker: the directory itself, with no
          // file to imply it.
          directories.add(full.replace(/\/$/, ""));
        } else {
          files.push(full);
        }

        // Every parent of the key is a directory, whether or not a marker
        // was ever written for it.
        let parent = path.posix.dirname(full.replace(/\/$/, ""));

        while (parent !== "." && parent !== "/" && parent !== relative) {
          directories.add(parent);
          parent = path.posix.dirname(parent);
        }
      }

      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    files.sort();

    return { files, directories: [...directories].sort() };
  }

  // ── Streaming ────────────────────────────────────────────────────────

  async readStream(
    objectPath: string,
    options?: { start?: number; end?: number },
  ): Promise<Readable> {
    const key = this.key(objectPath);
    const range = rangeHeader(options);
    const response = await this.connection.getObject(key, range);

    // The 404 arrives from `GetObject` itself, before any body, so the
    // contract's "rejects before the first chunk" needs no extra probe —
    // unlike SFTP, which stats first.
    if (response?.Body === undefined) {
      throw new FileNotFoundException(objectPath);
    }

    return response.Body as Readable;
  }

  /**
   * A `PassThrough` whose other end is a multipart upload.
   *
   * `finish` is held back until the upload completes, so that — as the
   * contract requires — a caller awaiting `finish` can immediately read
   * the file back. Nothing is visible at the key until then, which is
   * where the atomicity comes from.
   */
  async writeStream(objectPath: string, options?: { flags?: "w" | "a" }): Promise<Writable> {
    const key = this.key(objectPath);

    if (options?.flags === "a") {
      // S3 objects are immutable; there is no append. Read-modify-write is
      // the only option, and doing it silently would turn an append on a
      // large object into an invisible full download and re-upload.
      const existing = await this.connection.getObject(key);
      const prefix =
        existing?.Body === undefined ? Buffer.alloc(0) : await collect(existing.Body as Readable);

      return this.uploadStream(key, objectPath, prefix);
    }

    return this.uploadStream(key, objectPath);
  }

  async putStream(objectPath: string, source: StreamSource): Promise<void> {
    const key = this.key(objectPath);
    const { Upload } = await loadUpload();

    const upload = new Upload({
      client: await this.connection.connect(),
      params: {
        Bucket: this.connection.bucket(),
        Key: key,
        // `lib-storage` rejects a bare AsyncIterable, so normalizing is
        // required here rather than merely tidy.
        Body: toNodeReadable(source),
        ContentType: guessMimeType(objectPath),
      },
      partSize: this.connection.partSize(),
      queueSize: this.connection.queueSize(),
    });

    await upload.done();
  }

  /**
   * Build a writable whose bytes become one multipart upload, optionally
   * prefixed by bytes already in the object (the append path).
   */
  private async uploadStream(key: string, objectPath: string, prefix?: Buffer): Promise<Writable> {
    const { Upload } = await loadUpload();
    const body = new PassThrough();

    const upload = new Upload({
      client: await this.connection.connect(),
      params: {
        Bucket: this.connection.bucket(),
        Key: key,
        Body: body,
        ContentType: guessMimeType(objectPath),
      },
      partSize: this.connection.partSize(),
      queueSize: this.connection.queueSize(),
    });

    // An upload that fails while the caller is still writing would
    // otherwise be an unhandled rejection; the error is re-surfaced on the
    // stream instead, in `_final`.
    const settled = upload.done().then(
      () => undefined,
      (error: unknown) => error,
    );

    if (prefix !== undefined && prefix.length > 0) {
      body.write(prefix);
    }

    return new UploadWriteStream(body, settled, () => upload.abort());
  }

  // ── Metadata / manipulation ──────────────────────────────────────────

  async size(objectPath: string): Promise<number> {
    return (await this.headFile(objectPath)).ContentLength ?? 0;
  }

  async lastModified(objectPath: string): Promise<Date> {
    return (await this.headFile(objectPath)).LastModified ?? new Date(0);
  }

  async mimeType(objectPath: string): Promise<string | undefined> {
    this.guard(objectPath);

    return guessMimeType(objectPath);
  }

  /**
   * `CopyObject`, which is server-side: the bytes never reach this
   * process. Cheap at any size, unlike the SFTP driver's
   * download-and-re-upload.
   */
  async copy(from: string, to: string): Promise<void> {
    const fromKey = this.key(from);

    if ((await this.connection.head(fromKey)) === undefined) {
      throw new FileNotFoundException(from);
    }

    const sdk = await this.connection.commands();
    const bucket = this.connection.bucket();

    await this.connection.run((client) =>
      client.send(
        new sdk.CopyObjectCommand({
          Bucket: bucket,
          Key: this.key(to),
          // The source is bucket-qualified and must be URI-encoded, or a
          // key containing a space or a `+` copies the wrong object.
          CopySource: `${bucket}/${fromKey}`.split("/").map(encodeURIComponent).join("/"),
        }),
      ),
    );
  }

  /** Copy then delete: S3 has no rename. */
  async move(from: string, to: string): Promise<void> {
    await this.copy(from, to);
    await this.delete(from);
  }

  /**
   * Delete every key under the prefix, markers included. A missing
   * directory is a no-op.
   */
  async deleteDirectory(directory: string): Promise<void> {
    const relative = this.guard(directory);
    const prefix = this.prefix(relative);
    const sdk = await this.connection.commands();
    const bucket = this.connection.bucket();
    let token: string | undefined;

    do {
      const page = await this.connection.run((client) =>
        client.send(
          new sdk.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: this.connection.pageSize(),
            ContinuationToken: token,
          }),
        ),
      );

      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key !== undefined);

      if (keys.length > 0) {
        // `DeleteObjects` takes up to 1000 keys per call, which is also
        // the listing page size, so one page is always one request.
        await this.connection.run((client) =>
          client.send(
            new sdk.DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          ),
        );
      }

      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  /**
   * Write a zero-byte marker at `prefix/`.
   *
   * A bucket has no directories, so an empty one is only visible if
   * something stands in for it. The marker appears in `CommonPrefixes`
   * under a delimited listing, which is what makes `directories()` report
   * a directory holding no files. Idempotent, since writing the same key
   * twice is the same object.
   */
  async makeDirectory(directory: string): Promise<void> {
    const relative = this.guard(directory);

    if (relative === "") {
      // The bucket root always exists; there is nothing to create.
      return;
    }

    const sdk = await this.connection.commands();

    await this.connection.run((client) =>
      client.send(
        new sdk.PutObjectCommand({
          Bucket: this.connection.bucket(),
          Key: `${this.connection.key(relative)}/`,
          Body: "",
        }),
      ),
    );
  }

  private async headFile(objectPath: string): Promise<{
    ContentLength?: number;
    LastModified?: Date;
  }> {
    const head = await this.connection.head(this.key(objectPath));

    if (head === undefined) {
      throw new FileNotFoundException(objectPath);
    }

    return head;
  }

  /** The listing prefix for a disk-relative directory: `""` or `"dir/"`. */
  private prefix(relative: string): string | undefined {
    const key = this.connection.key(relative === "" ? "" : `${relative}/`);

    return key === "" ? undefined : key;
  }

  /** The name of a key relative to the listing prefix it came from. */
  private nameFrom(key: string | undefined, prefix: string | undefined): string | undefined {
    if (key === undefined) {
      return undefined;
    }

    const base = prefix ?? "";

    if (!key.startsWith(base)) {
      return undefined;
    }

    const name = key.slice(base.length);

    return name === "" ? undefined : name;
  }

  /**
   * Normalize a disk-relative path and reject anything escaping the root.
   *
   * Lexical only, like the SFTP driver's guard. There are no symlinks in a
   * bucket, so unlike the local driver there is nothing a `realpath`
   * equivalent could add: a key is exactly the bytes in the key. What this
   * catches is a `../` arriving from application code, which would
   * otherwise address an object outside the configured root.
   */
  private guard(objectPath: string): string {
    const normalized = path.posix
      .normalize(objectPath.split("\\").join("/"))
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    if (normalized === "." || normalized === "") {
      return "";
    }

    if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(objectPath)) {
      throw new Error(`Path [${objectPath}] escapes the storage root.`);
    }

    return normalized;
  }

  /** The absolute object key for a disk-relative path, after the guard. */
  private key(objectPath: string): string {
    return this.connection.key(this.guard(objectPath));
  }
}

/**
 * A `Writable` front end for a multipart upload.
 *
 * Writes pass through to the upload's body, and `_final` waits for
 * `Upload.done()` before completing, so `finish` means "the object exists
 * at its final key" rather than "the bytes have left this process". That
 * is the guarantee the contract tests for, and the reason an aborted
 * stream leaves nothing behind: nothing is visible until completion.
 */
class UploadWriteStream extends PassThrough {
  private aborted = false;

  constructor(
    private readonly body: PassThrough,
    private readonly settled: Promise<unknown>,
    private readonly abort: () => Promise<void>,
  ) {
    super();

    // Aborting a write is `stream.destroy(error)`, and Node turns an
    // `error` event with no listener into an uncaught exception, which
    // would make "cancel this upload" a way to kill the process. Callers
    // attaching their own listener still get the error, since this adds one
    // rather than replacing it. Same reasoning as `CommittingWriteStream`.
    this.on("error", () => {});
    this.body.on("error", () => {});
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.body.write(chunk as Buffer)) {
      // Respect the upload's backpressure rather than buffering the whole
      // object in this process.
      this.body.once("drain", () => callback());

      return;
    }

    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.body.end();

    void this.settled.then((error) => {
      callback(error === undefined ? null : (error as Error));
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (error === null || this.aborted) {
      callback(error);

      return;
    }

    this.aborted = true;
    // Abort rather than complete, so no object appears at the final key and
    // no dangling multipart upload is left in the bucket.
    this.body.destroy(error);

    // `close` must not fire until the abort has actually landed: callers
    // (and the contract) check `exists()` straight after `close`, and an
    // abort still in flight would let a completed upload win that race.
    // Cleanup failures must not mask the caller's original error.
    const done = (): void => callback(error);

    this.abort().then(
      () => this.settled.then(done, done),
      () => this.settled.then(done, done),
    );
  }
}

/** Collect a readable into one buffer. Only used by the append path. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks);
}

/** The `Range` header for a read, or `undefined` for the whole object. */
function rangeHeader(options?: { start?: number; end?: number }): string | undefined {
  if (options?.start === undefined && options?.end === undefined) {
    return undefined;
  }

  const start = options.start ?? 0;

  // S3's range is inclusive at both ends, the same as `fs`'s, so the
  // contract's offsets pass straight through.
  return options.end === undefined ? `bytes=${start}-` : `bytes=${start}-${options.end}`;
}
