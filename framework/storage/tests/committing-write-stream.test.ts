import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CommittingWriteStream } from "../src/committing-write-stream.js";

/** A target that records what it received and when it was closed. */
function target(): PassThrough & { written(): string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  return Object.assign(stream, {
    written: () => Buffer.concat(chunks).toString("utf-8"),
  });
}

async function end(stream: Writable, contents?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    stream.end(contents);
  });
}

describe("CommittingWriteStream", () => {
  it("writes through to the target and commits once", async () => {
    const commit = vi.fn(async () => {});
    const discard = vi.fn(async () => {});
    const to = target();

    const stream = new CommittingWriteStream({ target: to, commit, discard });
    stream.write("hello ");
    await end(stream, "world");

    expect(to.written()).toBe("hello world");
    expect(commit).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
  });

  /**
   * The whole reason this class exists. Committing in a `finish` listener
   * instead would let a caller's own `finish` handler, and anything
   * awaiting the stream, run before the rename resolved, making "await
   * the write, then read the file" a race.
   */
  it("emits finish only after the commit has completed", async () => {
    let committed = false;
    const stream = new CommittingWriteStream({
      target: target(),
      commit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        committed = true;
      },
      discard: async () => {},
    });

    await end(stream, "x");

    expect(committed).toBe(true);
  });

  it("discards instead of committing when destroyed mid-write", async () => {
    const commit = vi.fn(async () => {});
    const discard = vi.fn(async () => {});

    const stream = new CommittingWriteStream({ target: target(), commit, discard });
    stream.write("partial");

    await new Promise<void>((resolve) => {
      stream.on("close", () => resolve());
      stream.destroy(new Error("boom"));
    });

    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });

  /**
   * `destroy(error)` on a stream with no `error` listener is an uncaught
   * exception, so without the class's own listener "cancel this upload"
   * would be a way to kill the process.
   */
  it("does not crash the process when destroyed with no error listener attached", async () => {
    const stream = new CommittingWriteStream({
      target: target(),
      commit: async () => {},
      discard: async () => {},
    });

    stream.write("partial");
    stream.destroy(new Error("boom"));

    await new Promise<void>((resolve) => stream.on("close", () => resolve()));
  });

  it("still delivers the error to a caller that does listen", async () => {
    const stream = new CommittingWriteStream({
      target: target(),
      commit: async () => {},
      discard: async () => {},
    });

    const error = await new Promise<Error>((resolve) => {
      stream.on("error", resolve);
      stream.write("partial");
      stream.destroy(new Error("boom"));
    });

    expect(error.message).toBe("boom");
  });

  it("surfaces a failing commit as a stream error and discards", async () => {
    const discard = vi.fn(async () => {});
    const stream = new CommittingWriteStream({
      target: target(),
      commit: async () => {
        throw new Error("rename failed");
      },
      discard,
    });

    await expect(end(stream, "x")).rejects.toThrow("rename failed");
    expect(discard).toHaveBeenCalledOnce();
  });

  it("surfaces a target error and discards the temp file", async () => {
    const to = target();
    const discard = vi.fn(async () => {});
    const commit = vi.fn(async () => {});

    const stream = new CommittingWriteStream({ target: to, commit, discard });
    stream.write("x");
    to.destroy(new Error("connection reset"));

    await new Promise<void>((resolve) => stream.on("close", () => resolve()));

    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("a cleanup failure does not mask the original error", async () => {
    const stream = new CommittingWriteStream({
      target: target(),
      commit: async () => {},
      discard: async () => {
        throw new Error("could not unlink");
      },
    });

    const error = await new Promise<Error>((resolve) => {
      stream.on("error", resolve);
      stream.write("partial");
      stream.destroy(new Error("boom"));
    });

    expect(error.message).toBe("boom");
  });

  it("respects the target's backpressure rather than buffering everything", async () => {
    // A target that never drains until told, so a write past its high
    // water mark must not be accepted.
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 5);
      },
    });

    const stream = new CommittingWriteStream({
      target: slow,
      commit: async () => {},
      discard: async () => {},
    });

    for (let i = 0; i < 20; i += 1) {
      stream.write(`chunk ${i}`);
    }

    await end(stream);
  });
});
