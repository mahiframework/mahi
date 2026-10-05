import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { TempFile } from "@mahiframework/core";
import { UnreadableMediaSourceError } from "./errors.js";

/**
 * Anything that can become a media file.
 *
 * A web `File` is what `request.file()` hands back, a `Buffer` is the
 * in-memory case, a string is a path on the local filesystem, and the
 * stream shapes cover a remote download or a disk-to-disk copy.
 *
 * `{ stream, filename }` exists because a bare stream carries no name,
 * and `original_filename` has to come from somewhere. A `File` already
 * has one.
 */
export type MediaSource =
  | File
  | Buffer
  | string
  | Readable
  | ReadableStream<Uint8Array>
  | { stream: Readable | ReadableStream<Uint8Array>; filename: string };

/**
 * A source resolved to something the upload path can work with.
 *
 * `bytes` is present when the whole file is already in memory and can be
 * written in one call. `temp` is present when it was streamed to a local
 * scratch file instead — large uploads and remote sources — and the
 * caller is responsible for deleting it.
 *
 * Exactly one of the two is set. Sniffing needs a prefix either way, so
 * `head` is always populated.
 */
export interface ResolvedSource {
  /** The leading bytes, for sniffing. */
  head: Uint8Array;
  /**
   * The whole file, when it was small enough to hold in memory.
   *
   * Mutually exclusive with `path`: exactly one of the two is set, which
   * is what the upload path branches on to choose `put()` or
   * `putStream()`.
   */
  bytes: Uint8Array | undefined;
  /** A local filesystem path to the bytes, when they were not buffered. */
  path: string | undefined;
  size: number;
  /** The name the file arrived with, if it had one. */
  filename: string | undefined;
  /**
   * Release anything this resolution allocated.
   *
   * A no-op for a buffered source and for a caller-supplied path, and a
   * `TempFile.delete()` for a drained stream. Always called, so the
   * upload path does not have to know which case it got.
   */
  release(): Promise<void>;
}

/**
 * Files at or below this size are read into memory; larger ones are
 * streamed to a temp file.
 *
 * The threshold exists because the two paths have opposite costs. An
 * avatar is a single `put()` and a temp file would be pure overhead; a
 * 2GB video would exhaust the heap. 8 MiB covers essentially every
 * image and document upload while keeping concurrent requests bounded.
 */
const IN_MEMORY_LIMIT = 8 * 1024 * 1024;

/** How many leading bytes are kept for sniffing. */
const HEAD_BYTES = 64;

/**
 * Resolve a source to bytes or a local scratch file.
 *
 * Streams are drained to a `TempFile` rather than buffered, which is
 * what lets this package accept a 5GB upload on a small container. The
 * caller must delete `temp` when it is done; `MediaManager.add()` does
 * that in a `finally`.
 */
export async function resolveSource(source: MediaSource): Promise<ResolvedSource> {
  if (typeof source === "string") {
    return fromPath(source);
  }

  if (Buffer.isBuffer(source)) {
    return fromBytes(source, undefined);
  }

  if (source instanceof Readable) {
    return fromStream(source, undefined);
  }

  if (isWebFile(source)) {
    // A `File` knows its size up front, so the in-memory decision does
    // not need to drain it first.
    if (source.size <= IN_MEMORY_LIMIT) {
      return fromBytes(new Uint8Array(await source.arrayBuffer()), source.name);
    }

    return fromStream(source.stream(), source.name);
  }

  if (isWebStream(source)) {
    return fromStream(source, undefined);
  }

  if (isNamedStream(source)) {
    return fromStream(source.stream, source.filename);
  }

  throw new UnreadableMediaSourceError(
    "expected a File, Buffer, path, stream, or { stream, filename }",
  );
}

async function fromPath(path: string): Promise<ResolvedSource> {
  let size: number;

  try {
    const stats = await stat(path);

    if (!stats.isFile()) {
      throw new UnreadableMediaSourceError(`${path} is not a file`);
    }

    size = stats.size;
  } catch (error) {
    if (error instanceof UnreadableMediaSourceError) {
      throw error;
    }

    throw new UnreadableMediaSourceError(`${path} could not be read`, { cause: error });
  }

  const filename = basename(path);

  if (size <= IN_MEMORY_LIMIT) {
    return fromBytes(await readFile(path), filename);
  }

  // A local path large enough to stream needs no temp copy: the bytes
  // are already on this filesystem, so the disk reads straight from
  // them. Nothing to release, and emphatically nothing to delete — the
  // file belongs to the caller.
  return {
    head: await readHead(path),
    bytes: undefined,
    path,
    size,
    filename,
    release: async () => {},
  };
}

function fromBytes(bytes: Uint8Array, filename: string | undefined): ResolvedSource {
  return {
    head: bytes.subarray(0, HEAD_BYTES),
    bytes,
    path: undefined,
    size: bytes.byteLength,
    filename,
    release: async () => {},
  };
}

async function fromStream(
  stream: Readable | ReadableStream<Uint8Array>,
  filename: string | undefined,
): Promise<ResolvedSource> {
  const temp = await TempFile.fromStream(stream);

  try {
    const stats = await stat(temp.path);

    return {
      head: await readHead(temp.path),
      bytes: undefined,
      path: temp.path,
      size: stats.size,
      filename,
      release: () => temp.delete(),
    };
  } catch (error) {
    await temp.delete();

    throw new UnreadableMediaSourceError("the streamed source could not be read", {
      cause: error,
    });
  }
}

/** The first `HEAD_BYTES` of a file, for sniffing, without reading it all. */
async function readHead(path: string): Promise<Uint8Array> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isWebFile(source: unknown): source is File {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as File).arrayBuffer === "function" &&
    typeof (source as File).name === "string" &&
    typeof (source as File).size === "number"
  );
}

function isWebStream(source: unknown): source is ReadableStream<Uint8Array> {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as ReadableStream<Uint8Array>).getReader === "function"
  );
}

function isNamedStream(
  source: unknown,
): source is { stream: Readable | ReadableStream<Uint8Array>; filename: string } {
  if (typeof source !== "object" || source === null) {
    return false;
  }

  const candidate = source as { stream?: unknown; filename?: unknown };

  return (
    typeof candidate.filename === "string" &&
    (candidate.stream instanceof Readable || isWebStream(candidate.stream))
  );
}
