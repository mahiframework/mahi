import { randomBytes } from "node:crypto";
import { createWriteStream, readdirSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The one directory every temp file goes in, created on first use. */
const TEMP_DIRECTORY = join(tmpdir(), "mahi-temp");

/**
 * Live temp files owned by THIS process, swept on exit.
 *
 * A `Set` of paths rather than of `TempFile`s, and deliberately a strong
 * reference: a `WeakRef`/`FinalizationRegistry` pair would let the GC
 * drop an unreferenced file's entry before the sweeper ran, which is the
 * "deletes your file, eventually, maybe" contract this design rejects.
 * Holding a string per live file is a few dozen bytes and makes cleanup
 * deterministic.
 */
const live = new Set<string>();

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
 * NOTHING LEAKS. Cleanup is layered, so forgetting the polite form is
 * untidy rather than a disk-filling bug:
 *
 *   await withTemporaryFile(async (file) => { ... });    // deleted at scope end
 *   await using file = await TempFile.fromStream(body);  // deleted at scope end
 *   const file = await TempFile.create();                // deleted at process exit
 *
 * The first two delete immediately on the way out, including on a throw,
 * and are what you should reach for. The third is still swept by an
 * `exit` handler, which Node runs on a normal end, an explicit
 * `process.exit()`, and an uncaught throw.
 *
 * The one case no in-process handler can cover is `SIGKILL`, a power cut,
 * or a container OOM-kill. For those, every filename carries the owning
 * pid and `sweepOrphans()` reclaims files whose process is gone — called
 * once per process on first use, so a long-lived app cleans up after
 * whatever died before it. That makes the worst case "a file survives
 * until the next run", never "until the OS reclaims it".
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
      // receives, so nothing else can clean it up by hand. Remove it
      // before rethrowing rather than leaving it to the exit sweeper.
      live.delete(path);
      await rm(path, { force: true });

      throw error;
    }

    return new TempFile(path);
  }

  /**
   * How many files this process is still holding.
   *
   * For diagnostics and for tests asserting a path does not leak. A
   * steadily climbing count in a long-lived worker means something is
   * creating temp files without scoping them.
   */
  static liveCount(): number {
    return live.size;
  }

  /**
   * Delete every temp file this process still owns, synchronously.
   *
   * Registered as the `exit` handler and safe to call directly, which is
   * what a long-running worker should do between units of work if it
   * creates unscoped files. Synchronous because an `exit` handler cannot
   * await: a pending promise simply never settles as the process tears
   * down.
   */
  static sweep(): void {
    for (const path of live) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best effort. A file we cannot remove (a permission change, a
        // vanished mount) must not stop us removing the rest, and
        // throwing from an `exit` handler would mask the real exit code.
      }
    }

    live.clear();
  }

  /**
   * Opt this file out of the exit sweeper, keeping it after the process
   * ends.
   *
   * For the deliberate "write a diagnostic dump and tell the user where
   * it is" case — a crash report or a failed-import artifact that exists
   * precisely to outlive the run. Returns the path, so it reads as
   * `const path = file.keep()`.
   *
   * The file is now the caller's to remove. `sweepOrphans()` will not
   * take it either, because keeping it rewrites the name to drop the pid
   * stamp.
   */
  async keep(): Promise<string> {
    live.delete(this.path);
    this.deleted = true;

    const kept = this.path.replace(`${KEPT_PREFIX}${process.pid}-`, "");

    await rename(this.path, kept);

    return kept;
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
    live.delete(this.path);
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
 * Delete temp files left behind by processes that are no longer running.
 *
 * The answer to `SIGKILL`, a power cut and a container OOM-kill, none of
 * which run an `exit` handler. Every name carries the pid that created
 * it, so a file is an orphan when `kill(pid, 0)` says that process is
 * gone — which is also why names are not purely random.
 *
 * Called once per process, lazily, on the first temp file created. A
 * long-lived app therefore cleans up after whatever died before it, and
 * the worst case for a killed process is "its files survive until
 * something else runs", never "until the OS reclaims them".
 *
 * Safe to run concurrently with other processes doing the same thing: a
 * file another sweeper removed first simply fails its `rm` and is
 * ignored. Exported for a worker that wants to sweep on a schedule.
 */
export function sweepOrphans(): void {
  let entries: string[];

  try {
    entries = readdirSync(TEMP_DIRECTORY);
  } catch {
    // No directory yet, which is the common case on a first run.
    return;
  }

  for (const entry of entries) {
    const pid = ownerPid(entry);

    if (pid === null || pid === process.pid || isRunning(pid)) {
      continue;
    }

    try {
      rmSync(join(TEMP_DIRECTORY, entry), { force: true, recursive: true });
    } catch {
      // Another sweeper won the race, or the file is not ours to remove.
    }
  }
}

/** The filename prefix carrying the owning pid, e.g. `mahi-4123-`. */
const KEPT_PREFIX = "mahi-";

/** Whether a process is still alive, for orphan detection. */
function isRunning(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without
    // delivering anything.
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // `EPERM` means the process exists but belongs to another user, so
    // it is alive and also not ours to clean up after.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid encoded in a temp filename, or null if it carries none. */
function ownerPid(entry: string): number | null {
  if (!entry.startsWith(KEPT_PREFIX)) {
    return null;
  }

  const pid = Number.parseInt(entry.slice(KEPT_PREFIX.length).split("-")[0] ?? "", 10);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether this process has installed its exit handler and swept orphans. */
let initialised = false;

/**
 * Install the exit sweeper and reclaim other processes' orphans, once.
 *
 * Lazy rather than at module load, because importing `@mahiframework/core`
 * must not register a process-wide handler or touch the filesystem in a
 * program that never creates a temp file — a short CLI, or a test file
 * importing `Str`.
 *
 * Only `exit` is hooked, deliberately. It covers a normal end, an
 * explicit `process.exit()` and an uncaught throw. Hooking `SIGINT`/
 * `SIGTERM` would also work, but a library installing signal handlers
 * overrides the application's own shutdown semantics — a worker draining
 * its current job on `SIGTERM`, for one — and a signal that kills the
 * process leaves files the next run's `sweepOrphans()` reclaims anyway.
 */
function initialise(): void {
  if (initialised) {
    return;
  }

  initialised = true;
  process.on("exit", TempFile.sweep);
  sweepOrphans();
}

/**
 * Reserve a path for a new temp file, and register it for cleanup.
 *
 * Returns a path, not a file: the callers above each create it their own
 * way (empty, from bytes, from a stream), and a reserve-then-write split
 * keeps the naming and directory rules in one place.
 *
 * Registered in `live` BEFORE the file is written, so a process killed
 * mid-write still has the partial file swept rather than orphaned.
 *
 * `mkdir` is called every time rather than once at module load.
 * `recursive: true` makes it a cheap no-op when the directory is already
 * there, and it means a tmpdir reaper that deletes the directory
 * mid-process does not break every subsequent call.
 */
async function reserve(extension?: string): Promise<string> {
  initialise();
  await mkdir(TEMP_DIRECTORY, { recursive: true });

  const suffix = normaliseExtension(extension);
  const name = `${KEPT_PREFIX}${process.pid}-${randomBytes(12).toString("hex")}${suffix}`;
  const path = join(TEMP_DIRECTORY, name);

  live.add(path);

  return path;
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
