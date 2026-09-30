import { Writable } from "node:stream";

export interface CommittingWriteStreamOptions {
  /** The already-open stream to the temporary location. */
  target: Writable;
  /** Publish the finished temp file at its final path (a rename). */
  commit(): Promise<void>;
  /** Remove the temp file after a failed or abandoned write. */
  discard(): Promise<void>;
}

/**
 * A `Writable` that writes to a temporary location and only publishes it
 * at the final path once the caller has finished, the "write to a temp
 * sibling and rename into place" half of the `StorageDriver` streaming
 * contract, factored out so every driver gets the same guarantee.
 *
 * The subtlety is *when* `finish` fires. Doing the rename inside a
 * `finish` listener is racy: the driver's listener is attached first, so
 * it starts the rename, but the caller's listener, and anything awaiting
 * the stream, runs before that rename resolves. `await finished(stream)`
 * followed by a read of the file is then a coin flip. Renaming in
 * `_final` instead means Node emits `finish` only after the commit has
 * actually completed, so the event means what callers assume it means:
 * the bytes are readable at the final path.
 *
 * The commit waits for the target's `close`, not merely its `finish`,
 * because `finish` only says the writes were accepted, while `close` says
 * the underlying handle is released, which some SFTP servers require
 * before they will rename the file.
 *
 * A destroyed or failed stream discards the temp file before emitting
 * `close`, so a crashed write leaves neither a partial file at the final
 * path nor a stray temp file beside it.
 */
export class CommittingWriteStream extends Writable {
  private readonly target: Writable;
  private readonly commitFn: () => Promise<void>;
  private readonly discardFn: () => Promise<void>;
  private committed = false;

  constructor(options: CommittingWriteStreamOptions) {
    super();
    this.target = options.target;
    this.commitFn = options.commit;
    this.discardFn = options.discard;

    // A failure on the way to the temp location is the caller's failure
    // too; surfacing it here also triggers `_destroy`, and so the
    // cleanup.
    this.target.on("error", (error: Error) => {
      this.destroy(error);
    });

    // Aborting a write is `stream.destroy(error)`, and Node turns an
    // `error` event with no listener into an uncaught exception, which
    // would make "cancel this upload" a way to kill the process. A
    // listener here is what keeps the abort path survivable; callers that
    // attach their own still receive the error, because this adds a
    // listener rather than replacing one.
    this.on("error", () => {});
  }

  _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.target.write(chunk, encoding)) {
      callback();

      return;
    }

    // Respect the target's backpressure rather than buffering an entire
    // upload in this stream.
    this.target.once("drain", () => callback());
  }

  _final(callback: (error?: Error | null) => void): void {
    const closed = new Promise<void>((resolve, reject) => {
      this.target.once("error", reject);
      this.target.once("close", () => resolve());
      this.target.end();
    });

    closed.then(
      () =>
        this.commitFn().then(
          () => {
            this.committed = true;
            callback();
          },
          (error: unknown) => callback(error as Error),
        ),
      (error: unknown) => callback(error as Error),
    );
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.committed) {
      callback(error);

      return;
    }

    // Cleanup failures must not mask the original error, nor invent one:
    // the temp file is the driver's mess, not the caller's problem.
    const done = (): void => callback(error);

    // Wait for the target to actually be closed before removing the temp
    // file. Both `fs.createWriteStream` and ssh2's open the underlying
    // handle lazily, so a stream destroyed while that open is still in
    // flight will *create* the file afterwards, and a delete issued now
    // would run first and leave the temp file behind for good.
    this.closeTarget().then(this.discardFn, this.discardFn).then(done, done);
  }

  /** Destroy the target and resolve once it has emitted `close` (or already had). */
  private closeTarget(): Promise<void> {
    if (this.target.destroyed || this.target.closed) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.target.once("close", finish);
      this.target.once("error", finish);
      this.target.destroy();

      // A target that never reports closing must not strand the cleanup.
      const timer = setTimeout(finish, 5_000);
      timer.unref();
    });
  }
}
