import { afterEach, describe, expect, it } from "vitest";
import { storageDriverContract, FileNotFoundException } from "@mahiframework/storage";
import { FtpStorageDriver } from "../src/ftp-storage-driver.js";
import { FTP_UNAVAILABLE, ftpConfig, testDriver } from "./ftp-test-helpers.js";

describe.skipIf(FTP_UNAVAILABLE)("FtpStorageDriver (integration)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function disk(urlPrefix?: string): Promise<FtpStorageDriver> {
    const { driver, cleanup } = await testDriver({}, urlPrefix);
    cleanups.push(cleanup);

    return driver;
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  /**
   * The same contract `LocalStorageDriver` runs. FTP is the weakest of the
   * backends, so this is where that matters most: the guarantees callers
   * rely on without knowing which disk they hold have to hold here too,
   * however much work the protocol makes of them.
   *
   * `largeFileBytes` is 512 KiB rather than the 8 MiB default: FTP opens a
   * fresh data connection per transfer, and 512 KiB is already well past
   * one chunk.
   */
  describe("StorageDriver contract", () => {
    for (const testCase of storageDriverContract({
      hasPath: false,
      largeFileBytes: 512 * 1024,
    })) {
      it(testCase.name, async () => {
        await testCase.run(await disk());
      });
    }
  });

  /**
   * An FTP disk normally has no URL at all; a prefix is only meaningful
   * when some *other* server publishes the same files over HTTP.
   */
  describe("StorageDriver contract (with a url prefix)", () => {
    for (const testCase of storageDriverContract({
      hasPath: false,
      urlPrefix: "https://files.example.com/public",
      largeFileBytes: 512 * 1024,
    })) {
      it(testCase.name, async () => {
        await testCase.run(await disk("https://files.example.com/public"));
      });
    }
  });

  describe("url() and path()", () => {
    it("url() throws without a prefix, naming FTP as the reason", async () => {
      const driver = await disk();
      expect(() => driver.url("a.txt")).toThrow(/no public URL/);
    });

    it("path() always throws, rather than inventing a local path", async () => {
      const driver = await disk();
      expect(() => driver.path("a.txt")).toThrow(/another machine/);
    });
  });

  /**
   * The headline constraint. FTP's control connection carries one command
   * at a time, and `basic-ftp` throws "User launched a task while another
   * one is still running" rather than corrupting the session. Without the
   * serialising queue in `FtpConnection` every one of these fails.
   */
  describe("serialisation", () => {
    it("runs concurrent operations without tripping the single-task client", async () => {
      const driver = await disk();
      await driver.put("a.txt", "a");
      await driver.put("b.txt", "bb");

      const [first, second, listing] = await Promise.all([
        driver.size("a.txt"),
        driver.size("b.txt"),
        driver.files(""),
      ]);

      expect(first).toBe(1);
      expect(second).toBe(2);
      expect(listing).toEqual(["a.txt", "b.txt"]);
    });

    it("survives a failed operation without wedging the queue", async () => {
      const driver = await disk();
      await driver.put("ok.txt", "fine");

      await expect(driver.size("missing.txt")).rejects.toThrow(FileNotFoundException);

      // The queue must still be usable: a rejected operation that left the
      // chain rejected would poison every later call.
      expect(await driver.size("ok.txt")).toBe(4);
    });

    it("shares one login across concurrent first operations", async () => {
      const driver = new FtpStorageDriver(ftpConfig({ root: "concurrent-login" }));

      try {
        await Promise.all([
          driver.makeDirectory(""),
          driver.files(""),
          driver.exists("nothing.txt"),
        ]);

        expect(driver.ftp().connected()).toBe(true);
      } finally {
        await driver.deleteDirectory("").catch(() => {});
        await driver.disconnect();
      }
    });
  });

  /**
   * `ensureDir()` leaves the client cd'd into the directory it created, so
   * every later relative path would resolve from there. These would pass
   * even with the bug present unless an operation follows the mkdir, which
   * is why each one does.
   */
  describe("working directory", () => {
    it("keeps later operations correct after makeDirectory()", async () => {
      const driver = await disk();

      await driver.makeDirectory("deep/nested/tree");
      await driver.put("root-level.txt", "top");

      expect(await driver.files("")).toEqual(["root-level.txt"]);
      expect(await driver.directories("")).toEqual(["deep"]);
      expect(await driver.allDirectories("")).toEqual(["deep", "deep/nested", "deep/nested/tree"]);
    });

    it("writes into a directory created moments earlier", async () => {
      const driver = await disk();

      await driver.makeDirectory("uploads");
      await driver.put("uploads/file.txt", "inside");

      expect((await driver.get("uploads/file.txt")).toString()).toBe("inside");
      expect(await driver.files("uploads")).toEqual(["uploads/file.txt"]);
    });

    it("creates parent directories for a write, which STOR will not", async () => {
      const driver = await disk();

      await driver.put("auto/created/parents.txt", "made");

      expect((await driver.get("auto/created/parents.txt")).toString()).toBe("made");
    });
  });

  /**
   * FTP's `REST` positions the start of a transfer and the protocol has no
   * end offset, so `end` is enforced client-side. The bytes past it still
   * cross the wire.
   */
  describe("ranged reads", () => {
    it("honours a start offset via REST", async () => {
      const driver = await disk();
      await driver.put("range.txt", "0123456789");

      const stream = await driver.readStream("range.txt", { start: 4 });

      expect((await collect(stream)).toString()).toBe("456789");
    });

    it("truncates at an end offset, which FTP cannot express", async () => {
      const driver = await disk();
      await driver.put("range.txt", "0123456789");

      const stream = await driver.readStream("range.txt", { start: 2, end: 5 });

      expect((await collect(stream)).toString()).toBe("2345");
    });

    it("truncates a range spanning more than one chunk", async () => {
      const driver = await disk();
      const payload = Buffer.alloc(256 * 1024, 9);
      await driver.put("big.bin", payload);

      const stream = await driver.readStream("big.bin", { start: 0, end: 99_999 });

      expect(await collect(stream)).toHaveLength(100_000);
    });
  });

  /**
   * Without `MLSD` a `LIST` line has no year and no timezone, and
   * `basic-ftp` refuses to parse it rather than guess. So `lastModified()`
   * has to use `MDTM`, one round trip per file.
   */
  describe("timestamps", () => {
    it("returns a real date even when the listing has none", async () => {
      const driver = await disk();
      await driver.put("dated.txt", "now");

      const modified = await driver.lastModified("dated.txt");

      expect(modified.getTime()).toBeGreaterThan(Date.now() - 300_000);
      expect(modified.getTime()).toBeLessThan(Date.now() + 300_000);
    });

    it("reports whether the server offered MLSD at all", async () => {
      const driver = await disk();
      await driver.exists("anything.txt");

      // Either answer is valid; what matters is that the driver probed
      // rather than assuming, since the fallback changes how
      // `lastModified()` works.
      expect(typeof driver.ftp().supportsMlsd()).toBe("boolean");
    });
  });

  describe("atomic writes", () => {
    it("reports whether a replacing rename was atomic", async () => {
      const driver = await disk();
      await driver.put("replace.txt", "first");
      await driver.put("replace.txt", "second");

      expect((await driver.get("replace.txt")).toString()).toBe("second");
      // vsftpd allows a clobbering rename; a server that refuses degrades
      // to delete-then-rename and reports `false`. Both are real.
      expect([true, false]).toContain(driver.ftp().replacesAtomically());
    });

    it("a destroyed writeStream leaves no file and no temp file", async () => {
      const driver = await disk();
      const stream = await driver.writeStream("aborted.bin");

      stream.write(Buffer.alloc(1024, 1));
      await new Promise<void>((resolve) => {
        stream.once("close", () => resolve());
        stream.destroy(new Error("boom"));
      });

      expect(await driver.exists("aborted.bin")).toBe(false);
      expect(await driver.files("")).toEqual([]);
    });

    it("finish means the bytes are readable at the final path", async () => {
      const driver = await disk();
      const stream = await driver.writeStream("committed.txt");

      await new Promise<void>((resolve, reject) => {
        stream.once("finish", () => resolve());
        stream.once("error", reject);
        stream.end(Buffer.from("committed"));
      });

      expect((await driver.get("committed.txt")).toString()).toBe("committed");
    });
  });

  describe("remote specifics", () => {
    it("copy() moves the bytes through this client, leaving both intact", async () => {
      const driver = await disk();
      const payload = Buffer.alloc(256 * 1024, 4);
      await driver.put("source.bin", payload);

      await driver.copy("source.bin", "nested/target.bin");

      expect((await driver.get("source.bin")).equals(payload)).toBe(true);
      expect((await driver.get("nested/target.bin")).equals(payload)).toBe(true);
    });

    it("move() replaces an existing destination", async () => {
      const driver = await disk();
      await driver.put("from.txt", "moved");
      await driver.put("to.txt", "replaced");

      await driver.move("from.txt", "to.txt");

      expect(await driver.exists("from.txt")).toBe(false);
      expect((await driver.get("to.txt")).toString()).toBe("moved");
    });

    it("deleteDirectory() removes a non-empty tree deepest-first", async () => {
      const driver = await disk();
      await driver.put("tree/a.txt", "a");
      await driver.put("tree/deep/b.txt", "b");
      await driver.makeDirectory("tree/empty");

      await driver.deleteDirectory("tree");

      expect(await driver.directories("")).toEqual([]);
      expect(await driver.allFiles("")).toEqual([]);
    });

    it("appends in place, since there is no atomic append", async () => {
      const driver = await disk();
      await driver.put("log.txt", "first");

      const stream = await driver.writeStream("log.txt", { flags: "a" });
      await new Promise<void>((resolve, reject) => {
        stream.once("finish", () => resolve());
        stream.once("error", reject);
        stream.end(Buffer.from("-second"));
      });

      expect((await driver.get("log.txt")).toString()).toBe("first-second");
    });
  });

  describe("missing files", () => {
    it("get() and readStream() throw FileNotFoundException", async () => {
      const driver = await disk();

      await expect(driver.get("nope.txt")).rejects.toThrow(FileNotFoundException);
      await expect(driver.readStream("nope.txt")).rejects.toThrow(FileNotFoundException);
    });

    it("size() and lastModified() throw rather than surfacing a 550", async () => {
      const driver = await disk();

      await expect(driver.size("nope.txt")).rejects.toThrow(FileNotFoundException);
      await expect(driver.lastModified("nope.txt")).rejects.toThrow(FileNotFoundException);
    });

    it("delete() on a missing file is a no-op, despite the server's 550", async () => {
      const driver = await disk();

      await expect(driver.delete("nope.txt")).resolves.toBeUndefined();
    });

    it("listing a missing directory is empty rather than an error", async () => {
      const driver = await disk();

      expect(await driver.files("nope")).toEqual([]);
      expect(await driver.allFiles("nope")).toEqual([]);
    });

    it("exists() is false for a directory, not just for nothing", async () => {
      const driver = await disk();
      await driver.makeDirectory("adir");

      expect(await driver.exists("adir")).toBe(false);
      expect(await driver.exists("nothing")).toBe(false);
    });
  });

  describe("connection lifecycle", () => {
    it("connect() logs in up front and disconnect() closes it", async () => {
      const driver = new FtpStorageDriver(ftpConfig());

      expect(driver.ftp().connected()).toBe(false);

      await driver.connect();
      expect(driver.ftp().connected()).toBe(true);

      await driver.disconnect();
      expect(driver.ftp().connected()).toBe(false);
    });

    it("disconnect() is safe when never connected, and twice", async () => {
      const driver = new FtpStorageDriver(ftpConfig());

      await expect(driver.disconnect()).resolves.toBeUndefined();
      await expect(driver.disconnect()).resolves.toBeUndefined();
    });

    it("reconnects after the connection is closed underneath it", async () => {
      const driver = await disk();
      await driver.put("a.txt", "a");

      await driver.disconnect();

      expect((await driver.get("a.txt")).toString()).toBe("a");
      expect(driver.ftp().connected()).toBe(true);
    });

    it("resolves a relative root against the login directory", async () => {
      const { driver, cleanup } = await testDriver({ root: "relative-root" });
      cleanups.push(cleanup);

      await driver.put("a.txt", "a");

      expect(await driver.ftp().remoteRoot()).toMatch(/relative-root$/);
      expect(await driver.files("")).toEqual(["a.txt"]);
    });
  });
});

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks);
}
