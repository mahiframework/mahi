import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TempFile, withTemporaryFile } from "../src/temp-file.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

describe("TempFile.create", () => {
  it("creates the file, not just a name", async () => {
    // A consumer that opens for append or stats before writing should
    // not have to special-case the first run.
    const file = await TempFile.create();

    expect(await exists(file.path)).toBe(true);
    expect(await readFile(file.path, "utf8")).toBe("");

    await file.delete();
  });

  it("places files under one directory in the system tmpdir", async () => {
    const file = await TempFile.create();

    expect(dirname(file.path)).toBe(join(tmpdir(), "mahi"));

    await file.delete();
  });

  it("recreates the directory if it was reaped mid-process", async () => {
    // `mkdir` runs per call rather than once at module load, so a tmpdir
    // reaper deleting `mahi/` does not break every subsequent call.
    const first = await TempFile.create();
    await first.delete();

    const { rm } = await import("node:fs/promises");
    await rm(join(tmpdir(), "mahi"), { recursive: true, force: true });

    const second = await TempFile.create();

    expect(await exists(second.path)).toBe(true);

    await second.delete();
  });

  it("does not collide across many files", async () => {
    const files = await Promise.all(Array.from({ length: 50 }, () => TempFile.create()));
    const paths = new Set(files.map((file) => file.path));

    expect(paths.size).toBe(50);

    await Promise.all(files.map((file) => file.delete()));
  });

  it.each([
    ["pdf", ".pdf"],
    [".pdf", ".pdf"],
    ["..pdf", ".pdf"],
    ["", ""],
    [undefined, ""],
  ])("normalises the extension %j to %j", async (given, expected) => {
    const file = await TempFile.create(given);

    expect(extname(file.path)).toBe(expected);

    await file.delete();
  });
});

describe("TempFile.fromContents", () => {
  it("writes a string", async () => {
    const file = await TempFile.fromContents("hello", "txt");

    expect(await readFile(file.path, "utf8")).toBe("hello");

    await file.delete();
  });

  it("writes a buffer verbatim", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const file = await TempFile.fromContents(bytes, "png");

    expect(await readFile(file.path)).toEqual(bytes);

    await file.delete();
  });
});

describe("TempFile.fromStream", () => {
  it("drains a Node Readable", async () => {
    const file = await TempFile.fromStream(Readable.from(["one ", "two"]));

    expect(await readFile(file.path, "utf8")).toBe("one two");

    await file.delete();
  });

  it("drains a web ReadableStream", async () => {
    // The shape a `fetch` body and `Response.body` have, so a remote
    // download lands in a temp file without the caller adapting it.
    const body = new Response("from the web").body;
    const file = await TempFile.fromStream(body as ReadableStream<Uint8Array>);

    expect(await readFile(file.path, "utf8")).toBe("from the web");

    await file.delete();
  });

  it("drains an async iterable", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }

    const file = await TempFile.fromStream(chunks());

    expect(await readFile(file.path)).toEqual(Buffer.from([1, 2, 3]));

    await file.delete();
  });

  it("handles a payload larger than one chunk", async () => {
    const payload = "x".repeat(5 * 1024 * 1024);
    const file = await TempFile.fromStream(Readable.from([payload]));

    expect((await stat(file.path)).size).toBe(payload.length);

    await file.delete();
  });

  it("leaves no partial file behind when the stream fails", async () => {
    // The caller never receives the TempFile, so nothing else could
    // clean it up — a leak of one temp file per failure otherwise.
    const before = await listTempFiles();

    const failing = new Readable({
      read() {
        this.destroy(new Error("stream broke"));
      },
    });

    await expect(TempFile.fromStream(failing)).rejects.toThrow("stream broke");

    expect(await listTempFiles()).toEqual(before);
  });
});

describe("delete", () => {
  it("removes the file", async () => {
    const file = await TempFile.create();
    await file.delete();

    expect(await exists(file.path)).toBe(false);
  });

  it("is idempotent", async () => {
    // A caller deleting in both a `finally` and a success path should
    // not have to track which ran first.
    const file = await TempFile.create();

    await file.delete();
    await expect(file.delete()).resolves.toBeUndefined();
  });

  it("tolerates a file already removed out of band", async () => {
    const { rm } = await import("node:fs/promises");
    const file = await TempFile.create();
    await rm(file.path);

    await expect(file.delete()).resolves.toBeUndefined();
  });
});

describe("withTemporaryFile", () => {
  it("returns the callback's value", async () => {
    expect(await withTemporaryFile(async () => 42)).toBe(42);
  });

  it("accepts a synchronous callback", async () => {
    expect(await withTemporaryFile(() => "sync")).toBe("sync");
  });

  it("deletes the file afterwards", async () => {
    let path = "";

    await withTemporaryFile(async (file) => {
      path = file.path;
      expect(await exists(path)).toBe(true);
    });

    expect(await exists(path)).toBe(false);
  });

  it("deletes the file when the callback throws", async () => {
    // The case that leaks in practice, and the one a caller is least
    // likely to have written a handler for.
    let path = "";

    await expect(
      withTemporaryFile(async (file) => {
        path = file.path;

        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(path).not.toBe("");
    expect(await exists(path)).toBe(false);
  });

  it("passes the extension through", async () => {
    await withTemporaryFile(async (file) => {
      expect(extname(file.path)).toBe(".pdf");
    }, "pdf");
  });
});

describe("await using", () => {
  it("deletes on scope exit", async () => {
    // The declaration form, for a caller that wants bytes in the file up
    // front. Naming `Symbol.asyncDispose` in a type position is what
    // `ESNext.Disposable` is in `tsconfig.base.json` for, so this is as
    // much a test of that as of the method.
    let path = "";

    {
      await using file = await TempFile.create();
      path = file.path;
      expect(await exists(path)).toBe(true);
    }

    expect(await exists(path)).toBe(false);
  });

  it("deletes when the scope throws", async () => {
    let path = "";

    await expect(
      (async () => {
        await using file = await TempFile.create();
        path = file.path;

        throw new Error("boom");
      })(),
    ).rejects.toThrow("boom");

    expect(await exists(path)).toBe(false);
  });

  it("composes with a constructor that takes bytes", async () => {
    // The reason both forms exist: `withTemporaryFile()` hands over an
    // empty file, so starting from a stream needs the declaration form.
    let path = "";

    {
      await using file = await TempFile.fromStream(Readable.from(["remote bytes"]));
      path = file.path;
      expect(await readFile(path, "utf8")).toBe("remote bytes");
    }

    expect(await exists(path)).toBe(false);
  });
});

/** The temp directory's current contents, for leak assertions. */
async function listTempFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");

  try {
    return (await readdir(join(tmpdir(), "mahi"))).sort();
  } catch {
    return [];
  }
}
