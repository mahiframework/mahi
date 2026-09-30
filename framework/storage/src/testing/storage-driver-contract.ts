import { Readable, Writable } from "node:stream";
import { FileNotFoundException } from "../exceptions.js";
import type { StorageDriver } from "../storage-driver.js";

/**
 * The `StorageDriver` contract, as executable cases.
 *
 * `StorageDriver` is 21 methods, most of them carrying a guarantee that
 * isn't visible in the signature: listings are sorted, a missing
 * directory is `[]` rather than an error, `readStream` rejects before the
 * first chunk, a truncating stream write is atomic. A driver can satisfy
 * the types and miss every one of those. So the contract is shipped as
 * tests, and every driver runs the same ones, which is what stops the
 * local and remote implementations from drifting into two subtly
 * different abstractions behind one interface.
 *
 * Runner-agnostic on purpose: cases are plain objects with a `run()`, and
 * failures are thrown `Error`s rather than matcher calls, so this package
 * keeps its "no test-runner dependency" property (same reasoning as
 * `FakeStorageDriver`'s assertions). A vitest file is three lines:
 *
 * ```ts
 * for (const testCase of storageDriverContract()) {
 *   it(testCase.name, async () => testCase.run(await freshDriver()));
 * }
 * ```
 *
 * Every case is handed a driver over an **empty** disk and may leave
 * whatever it likes behind; the caller supplies isolation.
 */
export interface StorageDriverContractCase {
  name: string;
  run(driver: StorageDriver): Promise<void>;
}

export interface StorageDriverContractOptions {
  /**
   * The public URL prefix the driver under test was constructed with, if
   * any. Given one, the contract asserts `url()` returns prefix + path;
   * omitted, it asserts `url()` **throws**, which is the private-disk
   * contract and the permanent answer for a driver that has no public
   * URLs at all.
   */
  urlPrefix?: string;
  /**
   * Whether `path()` returns a real on-disk location. False for a driver
   * whose bytes aren't on this machine, where the contract instead
   * requires `path()` to throw rather than invent a plausible-looking
   * path.
   */
  hasPath?: boolean;
  /**
   * Bytes for the "arrives in more than one chunk" streaming case.
   * Defaults to 8 MiB, comfortably past one filesystem read; a driver
   * paying real network latency per chunk may want less.
   */
  largeFileBytes?: number;
}

export function storageDriverContract(
  options: StorageDriverContractOptions = {},
): StorageDriverContractCase[] {
  const { urlPrefix, hasPath = true, largeFileBytes = 8 * 1024 * 1024 } = options;

  const cases: StorageDriverContractCase[] = [
    {
      name: "put()/get() round-trips a string",
      async run(disk) {
        await disk.put("hello.txt", "world");
        assertEquals((await disk.get("hello.txt")).toString("utf-8"), "world", "contents");
      },
    },
    {
      name: "put()/get() round-trips a Buffer",
      async run(disk) {
        const contents = Buffer.from([0, 1, 2, 250, 251, 255]);
        await disk.put("bytes.bin", contents);
        assert(
          (await disk.get("bytes.bin")).equals(contents),
          "get() did not return the bytes that were put",
        );
      },
    },
    {
      name: "put() overwrites an existing file rather than appending to it",
      async run(disk) {
        await disk.put("a.txt", "first value");
        await disk.put("a.txt", "second");
        assertEquals((await disk.get("a.txt")).toString("utf-8"), "second", "contents");
      },
    },
    {
      name: "exists() is false before put() and true after",
      async run(disk) {
        assertEquals(await disk.exists("a.txt"), false, "exists() before put()");
        await disk.put("a.txt", "x");
        assertEquals(await disk.exists("a.txt"), true, "exists() after put()");
      },
    },
    {
      name: "delete() removes the file",
      async run(disk) {
        await disk.put("a.txt", "x");
        await disk.delete("a.txt");
        assertEquals(await disk.exists("a.txt"), false, "exists() after delete()");
      },
    },
    {
      name: "delete() on a missing file does not throw",
      async run(disk) {
        await disk.delete("missing.txt");
      },
    },
    {
      name: "put() auto-creates nested parent directories",
      async run(disk) {
        await disk.put("a/b/c/nested.txt", "deep");
        assertEquals((await disk.get("a/b/c/nested.txt")).toString("utf-8"), "deep", "contents");
      },
    },
    {
      name: "get() on a missing file throws FileNotFoundException",
      async run(disk) {
        await assertRejectsWith(
          () => disk.get("missing.txt"),
          FileNotFoundException,
          "get() of a missing file",
        );
      },
    },
    {
      name: "a path escaping the disk root is rejected",
      async run(disk) {
        await assertRejects(
          () => disk.get("../../etc/passwd"),
          /escapes the storage root/,
          "get() above the root",
        );
        await assertRejects(
          () => disk.put("../outside.txt", "x"),
          /escapes the storage root/,
          "put() above the root",
        );
      },
    },

    // ── Listing ────────────────────────────────────────────────────────

    {
      name: "files() lists immediate files, sorted, relative and POSIX-separated",
      async run(disk) {
        await seedTree(disk);
        assertEquals(await disk.files(), ["a.txt", "root.txt"], "files()");
        assertEquals(await disk.files("sub"), ["sub/one.txt", "sub/two.txt"], 'files("sub")');
      },
    },
    {
      name: "directories() lists immediate subdirectories",
      async run(disk) {
        await seedTree(disk);
        assertEquals(await disk.directories(), ["empty", "sub"], "directories()");
        assertEquals(await disk.directories("sub"), ["sub/deep"], 'directories("sub")');
      },
    },
    {
      name: "allFiles() recurses",
      async run(disk) {
        await seedTree(disk);
        assertEquals(
          await disk.allFiles(),
          ["a.txt", "root.txt", "sub/deep/three.txt", "sub/one.txt", "sub/two.txt"],
          "allFiles()",
        );
        assertEquals(
          await disk.allFiles("sub"),
          ["sub/deep/three.txt", "sub/one.txt", "sub/two.txt"],
          'allFiles("sub")',
        );
      },
    },
    {
      name: "allDirectories() recurses",
      async run(disk) {
        await seedTree(disk);
        assertEquals(await disk.allDirectories(), ["empty", "sub", "sub/deep"], "allDirectories()");
      },
    },
    {
      name: "list() returns one level of files and directories",
      async run(disk) {
        await seedTree(disk);
        assertEquals(
          await disk.list(),
          { files: ["a.txt", "root.txt"], directories: ["empty", "sub"] },
          "list()",
        );
      },
    },
    {
      name: "a non-existent directory lists as empty, not an error",
      async run(disk) {
        assertEquals(await disk.files("nope"), [], 'files("nope")');
        assertEquals(await disk.directories("nope"), [], 'directories("nope")');
        assertEquals(await disk.allFiles("nope"), [], 'allFiles("nope")');
        assertEquals(await disk.list("nope"), { files: [], directories: [] }, 'list("nope")');
      },
    },
    {
      name: "listing rejects a traversal directory argument",
      async run(disk) {
        await assertRejects(
          () => disk.files("../.."),
          /escapes the storage root/,
          'files("../..")',
        );
      },
    },
    {
      /**
       * A remote driver walks a tree with bounded concurrency; a tree
       * both deeper and wider than that bound is what catches a walk that
       * drops branches once its queue is saturated.
       */
      name: "allFiles() returns every file of a tree deeper and wider than any concurrency bound",
      async run(disk) {
        const expected: string[] = [];

        for (let branch = 0; branch < 12; branch += 1) {
          let dir = `wide-${branch}`;

          for (let depth = 0; depth < 6; depth += 1) {
            dir = `${dir}/d${depth}`;
            const file = `${dir}/f.txt`;
            await disk.put(file, "x");
            expected.push(file);
          }
        }

        expected.sort();
        assertEquals(await disk.allFiles(), expected, "allFiles() over a deep, wide tree");
      },
    },

    // ── Streaming ──────────────────────────────────────────────────────

    {
      name: "readStream() streams the file's bytes",
      async run(disk) {
        await disk.put("a.txt", "hello world");
        assertEquals(
          (await drain(await disk.readStream("a.txt"))).toString("utf-8"),
          "hello world",
          "streamed contents",
        );
      },
    },
    {
      name: "readStream() honours inclusive start/end ranges",
      async run(disk) {
        await disk.put("a.txt", "0123456789");
        assertEquals(
          (await drain(await disk.readStream("a.txt", { start: 2, end: 5 }))).toString("utf-8"),
          "2345",
          "ranged contents",
        );
        assertEquals(
          (await drain(await disk.readStream("a.txt", { start: 7 }))).toString("utf-8"),
          "789",
          "open-ended range",
        );
      },
    },
    {
      /**
       * The point of the up-front existence check: a caller never has to
       * attach an error handler just to learn the file wasn't there, and
       * never sees a late ENOENT after it has started piping.
       */
      name: "readStream() rejects a missing file with FileNotFoundException before any chunk",
      async run(disk) {
        await assertRejectsWith(
          () => disk.readStream("missing.txt"),
          FileNotFoundException,
          "readStream() of a missing file",
        );
      },
    },
    {
      name: "readStream() delivers a large file in more than one chunk",
      async run(disk) {
        const big = Buffer.alloc(largeFileBytes, 7);
        await disk.put("big.bin", big);
        let chunks = 0;
        let total = 0;

        for await (const chunk of await disk.readStream("big.bin")) {
          chunks += 1;
          total += (chunk as Buffer).length;
        }

        assertEquals(total, big.length, "streamed byte count");
        assert(chunks > 1, `expected more than one chunk, got ${chunks}`);
      },
    },
    {
      name: "writeStream() writes the bytes and creates parent directories",
      async run(disk) {
        const stream = await disk.writeStream("out/nested.txt");
        await finished(stream, "streamed bytes");
        assertEquals(
          (await disk.get("out/nested.txt")).toString("utf-8"),
          "streamed bytes",
          "contents",
        );
      },
    },
    {
      /**
       * The atomicity guarantee: a write that dies mid-transfer must
       * leave nothing at the final path, and no visible temp file
       * either.
       */
      name: "writeStream() destroyed mid-transfer leaves no file at the final path",
      async run(disk) {
        const stream = await disk.writeStream("partial.txt");
        stream.write("some data");
        await new Promise<void>((resolve) => {
          stream.on("close", () => resolve());
          stream.destroy(new Error("boom"));
        });
        assertEquals(await disk.exists("partial.txt"), false, "exists() after an aborted write");
        assertEquals(await disk.files(), [], "files() after an aborted write");
      },
    },
    {
      name: "writeStream() replaces an existing file without leaving its old bytes",
      async run(disk) {
        await disk.put("a.txt", "the original, longer contents");
        const stream = await disk.writeStream("a.txt");
        await finished(stream, "short");
        assertEquals((await disk.get("a.txt")).toString("utf-8"), "short", "contents");
        assertEquals(await disk.files(), ["a.txt"], "files() after a replacing write");
      },
    },
    {
      name: "writeStream({ flags: 'a' }) appends",
      async run(disk) {
        await disk.put("log.txt", "first\n");
        const stream = await disk.writeStream("log.txt", { flags: "a" });
        await finished(stream, "second\n");
        assertEquals((await disk.get("log.txt")).toString("utf-8"), "first\nsecond\n", "contents");
      },
    },
    {
      name: "putStream() drains a Node Readable",
      async run(disk) {
        await disk.putStream("from-node.txt", Readable.from(["ab", "cd", "ef"]));
        assertEquals((await disk.get("from-node.txt")).toString("utf-8"), "abcdef", "contents");
      },
    },
    {
      name: "putStream() drains a web ReadableStream",
      async run(disk) {
        await disk.putStream("from-web.txt", new Response("web-body").body!);
        assertEquals((await disk.get("from-web.txt")).toString("utf-8"), "web-body", "contents");
      },
    },
    {
      name: "putStream() drains an async iterable",
      async run(disk) {
        async function* gen(): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode("x");
          yield new TextEncoder().encode("y");
          yield new TextEncoder().encode("z");
        }

        await disk.putStream("from-iter.txt", gen());
        assertEquals((await disk.get("from-iter.txt")).toString("utf-8"), "xyz", "contents");
      },
    },
    {
      name: "putStream() round-trips a payload larger than one chunk",
      async run(disk) {
        const big = Buffer.alloc(largeFileBytes, 3);
        await disk.putStream("big.bin", Readable.from([big]));
        assertEquals(await disk.size("big.bin"), big.length, "size() of the streamed file");
        assert((await disk.get("big.bin")).equals(big), "streamed bytes did not round-trip");
      },
    },

    // ── Metadata / manipulation ────────────────────────────────────────

    {
      name: "size() returns the byte length",
      async run(disk) {
        await disk.put("a.txt", "12345");
        assertEquals(await disk.size("a.txt"), 5, "size()");
      },
    },
    {
      name: "size() throws FileNotFoundException for a missing file",
      async run(disk) {
        await assertRejectsWith(() => disk.size("nope.txt"), FileNotFoundException, "size()");
      },
    },
    {
      name: "lastModified() returns a Date close to now",
      async run(disk) {
        await disk.put("a.txt", "x");
        const mtime = await disk.lastModified("a.txt");
        assert(mtime instanceof Date, "lastModified() did not return a Date");
        assert(
          Math.abs(Date.now() - mtime.getTime()) < 60_000,
          `lastModified() (${mtime.toISOString()}) is not close to now`,
        );
      },
    },
    {
      name: "lastModified() throws FileNotFoundException for a missing file",
      async run(disk) {
        await assertRejectsWith(
          () => disk.lastModified("nope.txt"),
          FileNotFoundException,
          "lastModified()",
        );
      },
    },
    {
      name: "mimeType() guesses from the extension, undefined when unknown",
      async run(disk) {
        assertEquals(await disk.mimeType("a.png"), "image/png", "mimeType() of a .png");
        assertEquals(
          await disk.mimeType("a.unknownext"),
          undefined,
          "mimeType() of an unknown extension",
        );
      },
    },
    {
      name: "copy() duplicates a file, creating parent directories",
      async run(disk) {
        await disk.put("a.txt", "orig");
        await disk.copy("a.txt", "backup/a.txt");
        assertEquals((await disk.get("backup/a.txt")).toString("utf-8"), "orig", "copy contents");
        assertEquals(await disk.exists("a.txt"), true, "source still exists after copy()");
      },
    },
    {
      name: "copy() overwrites an existing destination",
      async run(disk) {
        await disk.put("a.txt", "new");
        await disk.put("b.txt", "the older, longer contents");
        await disk.copy("a.txt", "b.txt");
        assertEquals((await disk.get("b.txt")).toString("utf-8"), "new", "destination contents");
      },
    },
    {
      name: "copy() throws FileNotFoundException when the source is missing",
      async run(disk) {
        await assertRejectsWith(
          () => disk.copy("nope.txt", "x.txt"),
          FileNotFoundException,
          "copy()",
        );
      },
    },
    {
      name: "copy() of a large file round-trips every byte",
      async run(disk) {
        const big = Buffer.alloc(largeFileBytes, 9);
        await disk.put("big.bin", big);
        await disk.copy("big.bin", "copies/big.bin");
        assert(
          (await disk.get("copies/big.bin")).equals(big),
          "copied bytes did not match the source",
        );
      },
    },
    {
      name: "move() renames a file, creating parent directories",
      async run(disk) {
        await disk.put("a.txt", "orig");
        await disk.move("a.txt", "moved/a.txt");
        assertEquals(await disk.exists("a.txt"), false, "source exists after move()");
        assertEquals((await disk.get("moved/a.txt")).toString("utf-8"), "orig", "moved contents");
      },
    },
    {
      /**
       * Silent overwrite, not a failure. SFTP's own `rename` refuses an
       * existing target, so a remote driver has to do real work here; a
       * caller must not have to care which disk it is talking to.
       */
      name: "move() overwrites an existing destination",
      async run(disk) {
        await disk.put("a.txt", "new");
        await disk.put("b.txt", "the older, longer contents");
        await disk.move("a.txt", "b.txt");
        assertEquals((await disk.get("b.txt")).toString("utf-8"), "new", "destination contents");
        assertEquals(await disk.exists("a.txt"), false, "source exists after move()");
      },
    },
    {
      name: "move() throws FileNotFoundException when the source is missing",
      async run(disk) {
        await assertRejectsWith(
          () => disk.move("nope.txt", "x.txt"),
          FileNotFoundException,
          "move()",
        );
      },
    },
    {
      name: "makeDirectory() creates parents and deleteDirectory() removes recursively",
      async run(disk) {
        await disk.makeDirectory("d/e/f");
        assertEquals(await disk.directories("d/e"), ["d/e/f"], "the created directory");
        await disk.put("d/e/f/x.txt", "x");
        await disk.deleteDirectory("d");
        assertEquals(await disk.exists("d/e/f/x.txt"), false, "file under a deleted directory");
        assertEquals(await disk.directories(), [], "directories() after deleteDirectory()");
      },
    },
    {
      name: "makeDirectory() on an existing directory is a no-op",
      async run(disk) {
        await disk.makeDirectory("d");
        await disk.makeDirectory("d");
        assertEquals(await disk.directories(), ["d"], "directories()");
      },
    },
    {
      name: "deleteDirectory() on a missing directory is a no-op",
      async run(disk) {
        await disk.deleteDirectory("nope");
      },
    },
  ];

  cases.push(
    hasPath
      ? {
          name: "path() returns a location under the root and still rejects traversal",
          async run(disk) {
            await disk.put("a.txt", "x");
            const location = disk.path("a.txt");
            assert(
              typeof location === "string" && location.length > 0,
              "path() returned no location",
            );
            assertThrows(
              () => disk.path("../../etc/passwd"),
              /escapes the storage root/,
              "path() above the root",
            );
          },
        }
      : {
          /**
           * A driver whose bytes are not on this machine must refuse,
           * not return a plausible-looking path. A fake path is worse
           * than an error: it gets handed to `node:fs` and fails
           * somewhere far away from the cause.
           */
          name: "path() throws, because the bytes are not on this machine",
          async run(disk) {
            assertThrows(() => disk.path("a.txt"), /path/i, "path()");
          },
        },
  );

  cases.push(
    urlPrefix === undefined
      ? {
          name: "url() throws, because this disk has no public URL",
          async run(disk) {
            assertThrows(() => disk.url("a.txt"), /URL/i, "url()");
          },
        }
      : {
          name: "url() returns the configured prefix plus the relative path",
          async run(disk) {
            assertEquals(
              disk.url("avatars/a.txt"),
              `${urlPrefix.replace(/\/+$/, "")}/avatars/a.txt`,
              "url()",
            );
            assertThrows(
              () => disk.url("../../etc/passwd"),
              /escapes the storage root/,
              "url() above the root",
            );
          },
        },
  );

  return cases;
}

/**
 * The tree every listing case asserts against: two files at the root, a
 * subdirectory with two files and a nested one, and an empty directory
 * (which only `makeDirectory` can produce, and which a driver that
 * infers directories from file paths will miss).
 */
async function seedTree(disk: StorageDriver): Promise<void> {
  await disk.put("root.txt", "r");
  await disk.put("a.txt", "a");
  await disk.put("sub/one.txt", "1");
  await disk.put("sub/two.txt", "2");
  await disk.put("sub/deep/three.txt", "3");
  await disk.makeDirectory("empty");
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks);
}

/** `end(contents)` and resolve on `finish`, reject on `error`. */
async function finished(stream: Writable, contents: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    stream.end(contents);
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** Structural equality, sufficient for the strings, numbers and string arrays the contract compares. */
function assertEquals(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual) ?? "undefined";
  const b = JSON.stringify(expected) ?? "undefined";

  if (a !== b) {
    throw new Error(`Expected ${what} to be ${b}, got ${a}.`);
  }
}

function assertThrows(run: () => unknown, match: RegExp, what: string): void {
  let error: unknown;

  try {
    run();
  } catch (thrown) {
    error = thrown;
  }

  if (error === undefined) {
    throw new Error(`Expected ${what} to throw, it did not.`);
  }

  if (!match.test(String((error as Error).message))) {
    throw new Error(`Expected ${what} to throw ${match}, got: ${(error as Error).message}`);
  }
}

async function assertRejects(
  run: () => Promise<unknown>,
  match: RegExp,
  what: string,
): Promise<void> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown ?? new Error("rejected with no reason"),
  );

  if (error === undefined) {
    throw new Error(`Expected ${what} to reject, it resolved.`);
  }

  if (!match.test(String((error as Error).message))) {
    throw new Error(`Expected ${what} to reject with ${match}, got: ${(error as Error).message}`);
  }
}

async function assertRejectsWith(
  run: () => Promise<unknown>,
  type: new (...args: never[]) => Error,
  what: string,
): Promise<void> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown ?? new Error("rejected with no reason"),
  );

  if (error === undefined) {
    throw new Error(`Expected ${what} to reject with ${type.name}, it resolved.`);
  }

  if (!(error instanceof type)) {
    throw new Error(
      `Expected ${what} to reject with ${type.name}, got ${
        (error as Error).name
      }: ${(error as Error).message}`,
    );
  }
}
