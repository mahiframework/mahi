import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempFile } from "@mahiframework/core";
import { EmptyArchiveError, MediaZip } from "../src/zip/media-zip.js";
import { uniqueName, zipStream, type ZipEntry } from "../src/zip/zip-stream.js";
import * as bytes from "./__fixtures__/bytes.js";
import { captureError, createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

/** Collect a stream into one buffer, for inspection. */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks);
}

/**
 * Read an archive back with Python's `zipfile`.
 *
 * An INDEPENDENT reader on purpose. Verifying a hand-rolled zip with a
 * hand-rolled parser would only prove the two agree with each other; the
 * question is whether real tools accept it. Python ships everywhere CI
 * runs and its `zipfile` is strict about the central directory.
 */
async function readWithPython(
  archive: Buffer,
): Promise<{ names: string[]; contents: Record<string, string>; sizes: Record<string, number> }> {
  await using file = await TempFile.create("zip");
  await writeFile(file.path, archive);

  const script = `
import json, zipfile
z = zipfile.ZipFile(${JSON.stringify(file.path)})
bad = z.testzip()
if bad is not None:
    raise SystemExit("corrupt entry: " + bad)
print(json.dumps({
    "names": z.namelist(),
    "contents": {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()},
    "sizes": {i.filename: i.file_size for i in z.infolist()},
}))
`;

  // A generous buffer: the default is 1MB and a large entry's contents
  // would otherwise fail with ENOBUFS, which looks like a zip bug and is
  // not one.
  const stdout = execFileSync("python3", ["-c", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return JSON.parse(stdout);
}

function entry(name: string, contents: string): ZipEntry {
  return { name, open: async () => Readable.from([Buffer.from(contents)]) };
}

describe("zipStream", () => {
  it("produces an archive real tools accept", async () => {
    const archive = await collectStream(
      zipStream([entry("hello.txt", "Hello, world!"), entry("notes.md", "# Notes")]),
    );

    const read = await readWithPython(archive);

    expect(read.names).toEqual(["hello.txt", "notes.md"]);
    expect(read.contents["hello.txt"]).toBe("Hello, world!");
    expect(read.contents["notes.md"]).toBe("# Notes");
  });

  it("round-trips bytes exactly", async () => {
    const payload = "a".repeat(100_000);
    const archive = await collectStream(zipStream([entry("big.txt", payload)]));
    const read = await readWithPython(archive);

    expect(read.sizes["big.txt"]).toBe(payload.length);
    expect(read.contents["big.txt"]).toBe(payload);
  });

  it("preserves nested paths", async () => {
    const archive = await collectStream(zipStream([entry("a/b/c/deep.txt", "deep")]));
    const read = await readWithPython(archive);

    expect(read.names).toEqual(["a/b/c/deep.txt"]);
  });

  it("handles a file larger than one deflate chunk", async () => {
    const archive = await collectStream(
      zipStream([
        {
          name: "large.bin",
          open: async () => Readable.from([Buffer.alloc(3 * 1024 * 1024, 0x41)]),
        },
      ]),
    );

    const read = await readWithPython(archive);

    expect(read.sizes["large.bin"]).toBe(3 * 1024 * 1024);
  });

  it("handles many entries", async () => {
    const entries = Array.from({ length: 60 }, (_unused, index) =>
      entry(`file-${index}.txt`, `contents ${index}`),
    );

    const read = await readWithPython(await collectStream(zipStream(entries)));

    expect(read.names).toHaveLength(60);
    expect(read.contents["file-59.txt"]).toBe("contents 59");
  });

  it("accepts string and Uint8Array chunks, not just Buffers", async () => {
    // A caller's `Readable.from(["text"])` yields strings, and a disk's
    // `readStream()` is not the only source.
    const archive = await collectStream(
      zipStream([
        { name: "str.txt", open: async () => Readable.from(["from a string"]) },
        {
          name: "u8.txt",
          open: async () => Readable.from([new Uint8Array([0x68, 0x69])]),
        },
      ]),
    );

    const read = await readWithPython(archive);

    expect(read.contents["str.txt"]).toBe("from a string");
    expect(read.contents["u8.txt"]).toBe("hi");
  });

  it("opens each entry only when it is reached", async () => {
    // What keeps memory flat: at most one file is in flight, so a
    // thousand-file archive costs one file's worth of buffers.
    const opened: string[] = [];

    const entries: ZipEntry[] = ["one", "two", "three"].map((name) => ({
      name: `${name}.txt`,
      open: async () => {
        opened.push(name);

        return Readable.from([name]);
      },
    }));

    const stream = zipStream(entries);

    expect(opened).toEqual([]);

    await collectStream(stream);

    expect(opened).toEqual(["one", "two", "three"]);
  });

  it("clamps a pre-1980 date rather than emitting an invalid header", async () => {
    // The DOS date field's epoch is 1980 and cannot represent earlier.
    const archive = await collectStream(
      zipStream([{ ...entry("old.txt", "x"), modified: new Date("1970-01-01") }]),
    );

    await expect(readWithPython(archive)).resolves.toBeDefined();
  });

  it("rejects a stream yielding something that is not bytes", async () => {
    // It must REJECT rather than take the process down. An exception
    // thrown inside a `data` listener surfaces as an uncaught exception
    // on the stream, so the source is destroyed with the error instead —
    // which is what turns this into a failed download.
    //
    // Either this writer's message or zlib's own may win the race to
    // destroy the pipeline; both are honest, so the assertion is that it
    // rejects at all.
    const stream = zipStream([
      { name: "bad.txt", open: async () => Readable.from([{ not: "bytes" }]) },
    ]);

    await expect(collectStream(stream)).rejects.toThrow();
  });
});

describe("uniqueName", () => {
  it("leaves a unique name alone", () => {
    expect(uniqueName("photo.jpg", new Set())).toBe("photo.jpg");
  });

  it("de-duplicates collisions, keeping the extension", () => {
    // Two people uploading `photo.jpg` is ordinary, and a zip with
    // duplicate entries extracts to one file.
    const used = new Set<string>();

    expect(uniqueName("photo.jpg", used)).toBe("photo.jpg");
    expect(uniqueName("photo.jpg", used)).toBe("photo-2.jpg");
    expect(uniqueName("photo.jpg", used)).toBe("photo-3.jpg");
  });

  it("de-duplicates names with no extension", () => {
    const used = new Set<string>();

    uniqueName("README", used);

    expect(uniqueName("README", used)).toBe("README-2");
  });

  it("strips a leading slash and normalises separators", () => {
    expect(uniqueName("/a\\b/c.txt", new Set())).toBe("a/b/c.txt");
  });
});

describe("MediaZip", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("archives a collection's files under their download names", async () => {
    const user = await makeUser();

    await user.photos().add([
      { stream: Readable.from([bytes.PNG]), filename: "first.png" },
      { stream: Readable.from([bytes.JPEG]), filename: "second.jpg" },
    ]);

    const zip = MediaZip.of(await user.photos().get());
    const read = await readWithPython(await collectStream(zip.stream()));

    expect(read.names).toEqual(["first.png", "second.jpg"]);
    expect(read.sizes["first.png"]).toBe(bytes.PNG.byteLength);
  });

  it("de-duplicates repeated download names", async () => {
    const user = await makeUser();

    await user.photos().add([
      { stream: Readable.from([bytes.PNG]), filename: "photo.png" },
      { stream: Readable.from([bytes.JPEG]), filename: "photo.png" },
    ]);

    const read = await readWithPython(
      await collectStream(MediaZip.of(await user.photos().get()).stream()),
    );

    expect(read.names).toEqual(["photo.png", "photo-2.png"]);
  });

  it("lets the caller name entries, for grouping into folders", async () => {
    const user = await makeUser();

    await user.photos().add({ stream: Readable.from([bytes.PNG]), filename: "a.png" });

    const zip = MediaZip.of(await user.photos().get()).nameEntries(
      (media) => `${media.collection}/${media.original_filename}`,
    );

    const read = await readWithPython(await collectStream(zip.stream()));

    expect(read.names).toEqual(["photos/a.png"]);
  });

  it("reads files across different disks", async () => {
    const user = await makeUser();

    await user.photos().add({ stream: Readable.from([bytes.PNG]), filename: "private.png" });
    await user
      .photos()
      .disk("public")
      .add({ stream: Readable.from([bytes.JPEG]), filename: "public.jpg" });

    const read = await readWithPython(
      await collectStream(MediaZip.of(await user.photos().get()).stream()),
    );

    expect(read.names.sort()).toEqual(["private.png", "public.jpg"]);
  });

  it("throws rather than streaming an empty archive", async () => {
    // Almost certainly a bug at the call site: an empty zip is a
    // confusing download, not a useful one.
    const error = await captureError(Promise.resolve().then(() => MediaZip.of([]).stream()));

    expect(error).toBeInstanceOf(EmptyArchiveError);
  });

  it("appends .zip to the archive name", () => {
    expect(MediaZip.of([]).filename("photos").name()).toBe("photos.zip");
    expect(MediaZip.of([]).filename("photos.zip").name()).toBe("photos.zip");
  });

  it("defaults the archive name", () => {
    expect(MediaZip.of([]).name()).toBe("download.zip");
  });

  it("reports how many files it will contain", async () => {
    const user = await makeUser();

    await user.photos().add([bytes.PNG, bytes.JPEG]);

    expect(MediaZip.of(await user.photos().get()).count()).toBe(2);
  });

  it("exposes a web stream for a Response body", async () => {
    const user = await makeUser();

    await user.photos().add({ stream: Readable.from([bytes.PNG]), filename: "a.png" });

    const response = new Response(MediaZip.of(await user.photos().get()).webStream());
    const archive = Buffer.from(await response.arrayBuffer());

    const read = await readWithPython(archive);

    expect(read.names).toEqual(["a.png"]);
  });
});
