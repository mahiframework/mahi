import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The one directory every temp file goes in, created on first use. */
const TEMP_DIRECTORY = join(tmpdir(), "mahi");

/**
 * A scratch file on the local filesystem, for work that cannot happen in
 * memory or cannot happen remotely.
 *
 * The motivating cases are an external binary that only takes a path
 * (`ffmpeg -i`, `jpegoptim`), and a file on a remote disk that a
 * local-only tool has to read — you cannot hand an S3 key to something
 * expecting `open(2)`. Both want "give me real bytes at a real path, and
 * clean up after".
 *
 * SCOPE IT, one of two ways. A `TempFile` does not clean itself up:
 * there is no finalizer, because a `FinalizationRegistry` callback is not
 * guaranteed to run at all and "deletes your file, eventually, maybe" is
 * a worse contract than "deletes it when the scope ends".
 *
 *   await withTemporaryFile(async (file) => { ... });   // empty file
 *   await using file = await TempFile.fromStream(body);  // file with bytes
 *
 * Both delete on the way out, including on a throw. A bare
 * `create`/`fromContents`/`fromStream` hands the caller a `delete()`
 * obligation instead, and every path that forgets it leaks a file into
 * `os.tmpdir()` until the OS reclaims it.
 *
 * Names come from `randomBytes`, not a counter or a timestamp: two
 * processes sharing a tmpdir must not collide, and the path of a
 * half-written temp file should not be guessable by another user on the
 * machine.
 */
export class TempFile {
  private deleted = false;

  private constructor(readonly path: string) {}

  /**
   * An empty temp file, for a tool that writes to a path you name.
   *
   * The file is created, not merely named, so a consumer that opens it
   * for append or stats it before writing does not have to special-case
   * the first run.
   */
  static async create(extension?: string): Promise<TempFile> {
    const path = await reserve(extension);
    await writeFile(path, "");

    return new TempFile(path);
  }

  /** A temp file holding `contents`. */
  static async fromContents(contents: Buffer | string, extension?: string): Promise<TempFile> {
    const path = await reserve(extension);
    await writeFile(path, contents);

    return new TempFile(path);
  }

  /**
   * A temp file drained from a stream.
   *
   * Takes a Node `Readable`, a web `ReadableStream` or any async iterable
   * of chunks — the same three shapes `@mahiframework/storage`'s
   * `putStream()` accepts, so a disk's `readStream()` and a `fetch` body
   * both work without the caller adapting either.
   *
   * Streamed through `pipeline()` rather than buffered, which is the
   * whole point: a temp file exists precisely for things too big or too
   * remote to hold in memory, so reading one into a `Buffer` first would
   * defeat it.
   */
  static async fromStream(
    source: Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    extension?: string,
  ): Promise<TempFile> {
    const path = await reserve(extension);

    try {
      await pipeline(toReadable(source), createWriteStream(path));
    } catch (error) {
      // A failed drain leaves a partial file at a path the caller never
      // receives, so nothing else can clean it up. Remove it before
      // rethrowing rather than leaking one temp file per failure.
      await rm(path, { force: true });

      throw error;
    }

    return new TempFile(path);
  }

  /**
   * Remove the file.
   *
   * Idempotent, and tolerant of a file that is already gone: a caller
   * that deletes in both a `finally` and an explicit success path should
   * not have to track which ran.
   */
  async delete(): Promise<void> {
    if (this.deleted) {
      return;
    }

    this.deleted = true;
    await rm(this.path, { force: true });
  }

  /**
   * `await using file = await TempFile.create()` deletes on scope exit,
   * including on a throw.
   *
   * The declaration form, for a caller who wants bytes in the file up
   * front — `withTemporaryFile()` hands over an empty one. Both are
   * scope-bound; this is the one that composes with
   * `TempFile.fromStream()`.
   *
   * Naming `Symbol.asyncDispose` in a type position is what
   * `ESNext.Disposable` is in `tsconfig.base.json` for.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.delete();
  }
}

/**
 * Run `callback` with a temp file, deleting it afterwards.
 *
 * Cleanup is in a `finally`, so a throwing callback still removes the
 * file — the case that leaks in practice, and the one a caller is least
 * likely to have written a handler for.
 *
 *   const text = await withTemporaryFile(async (file) => {
 *     await Process.run(["pdftotext", file.path, "-"]);
 *   }, "pdf");
 *
 * The file is empty on entry, which suits a tool that writes to a path
 * you name. To start from bytes, `await using` one of the other
 * constructors instead.
 */
export async function withTemporaryFile<T>(
  callback: (file: TempFile) => Promise<T> | T,
  extension?: string,
): Promise<T> {
  const file = await TempFile.create(extension);

  try {
    return await callback(file);
  } finally {
    await file.delete();
  }
}

/**
 * Reserve a path for a new temp file.
 *
 * Returns a path, not a file: the callers above each create it their own
 * way (empty, from bytes, from a stream), and a reserve-then-write split
 * keeps the naming and directory rules in one place.
 *
 * `mkdir` is called every time rather than once at module load.
 * `recursive: true` makes it a cheap no-op when the directory is already
 * there, and it means a tmpdir reaper that deletes `mahi/` mid-process
 * does not break every subsequent call.
 */
async function reserve(extension?: string): Promise<string> {
  await mkdir(TEMP_DIRECTORY, { recursive: true });

  const suffix = normaliseExtension(extension);

  return join(TEMP_DIRECTORY, `${randomBytes(16).toString("hex")}${suffix}`);
}

/**
 * Normalise an extension to `".ext"`, or `""` when there is none.
 *
 * Accepts it with or without the leading dot, because both read
 * naturally at a call site (`"pdf"` from a config value, `".pdf"` from
 * `path.extname()`) and the difference is never what the caller meant.
 */
function normaliseExtension(extension: string | undefined): string {
  if (extension === undefined) {
    return "";
  }

  const trimmed = extension.replace(/^\.+/, "");

  return trimmed === "" ? "" : `.${trimmed}`;
}

/** Normalise the three accepted stream shapes into a Node `Readable`. */
function toReadable(
  source: Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Readable {
  if (source instanceof Readable) {
    return source;
  }

  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    // `Readable.fromWeb` wants node:stream/web's ReadableStream; the
    // global (DOM) one is structurally identical at runtime.
    return Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
  }

  return Readable.from(source as AsyncIterable<Uint8Array>);
}
