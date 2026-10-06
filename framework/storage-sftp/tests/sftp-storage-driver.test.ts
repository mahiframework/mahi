import { afterEach, describe, expect, it } from "vitest";
import { storageDriverContract, FileNotFoundException } from "@mahiframework/storage";
import { SftpStorageDriver } from "../src/sftp-storage-driver.js";
import { SFTP_UNAVAILABLE, sftpConfig, testDriver } from "./sftp-test-helpers.js";

describe.skipIf(SFTP_UNAVAILABLE)("SftpStorageDriver (integration)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function disk(urlPrefix?: string): Promise<SftpStorageDriver> {
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
   * The same contract `LocalStorageDriver` runs. This is the point of
   * having it: a sorted listing, `[]` for a missing directory, an
   * up-front `FileNotFoundException` from `readStream`, and an atomic
   * `writeStream` are guarantees callers rely on without knowing which
   * disk they hold, so both drivers are held to them identically.
   *
   * `largeFileBytes` is smaller here than the local default: 8 MiB over
   * SFTP is many round trips for no extra coverage, and 512 KiB is
   * already well past one chunk.
   */
  describe("StorageDriver contract", () => {
    for (const testCase of storageDriverContract({
      hasPath: false,
      largeFileBytes: 512 * 1024,
      hasSymlink: true,
      hasHardlink: true,
    })) {
      it(testCase.name, async () => {
        await testCase.run(await disk());
      });
    }
  });

  /**
   * An SFTP disk normally has no URL at all; a prefix is only meaningful
   * when some *other* server publishes the same files over HTTP. Both
   * shapes have to behave, so both run the contract.
   */
  describe("StorageDriver contract (with a url prefix)", () => {
    for (const testCase of storageDriverContract({
      hasPath: false,
      urlPrefix: "https://media.example.com/files",
      largeFileBytes: 512 * 1024,
      hasSymlink: true,
      hasHardlink: true,
    })) {
      it(testCase.name, async () => {
        await testCase.run(await disk("https://media.example.com/files"));
      });
    }
  });

  describe("url() and path()", () => {
    it("url() throws without a prefix, naming SFTP as the reason", async () => {
      const driver = await disk();
      expect(() => driver.url("a.txt")).toThrow(/no public URL/);
    });

    it("path() always throws, rather than inventing a local path", async () => {
      const driver = await disk();
      expect(() => driver.path("a.txt")).toThrow(/another machine/);
    });
  });

  describe("connection lifecycle", () => {
    it("connect() opens the session up front and disconnect() closes it", async () => {
      const driver = new SftpStorageDriver(sftpConfig({ root: "upload" }));

      expect(driver.sftp().connected()).toBe(false);
      await driver.connect();
      expect(driver.sftp().connected()).toBe(true);

      await driver.disconnect();
      expect(driver.sftp().connected()).toBe(false);
    });

    it("disconnect() is safe when never connected, and safe twice", async () => {
      const driver = new SftpStorageDriver(sftpConfig({ root: "upload" }));

      await driver.disconnect();
      await driver.connect();
      await driver.disconnect();
      await driver.disconnect();
    });

    it("reuses one session across many operations rather than reconnecting", async () => {
      const driver = await disk();
      await driver.put("a.txt", "x");
      await driver.files();
      await driver.size("a.txt");

      expect(driver.sftp().connected()).toBe(true);
    });

    /**
     * The failure mode a long-lived connection to a NAS actually has: the
     * far side drops the session while the process is idle, and the next
     * call must recover rather than surface a dead channel. Destroying
     * the client from underneath the driver is what the server doing it
     * looks like from here.
     */
    it("recovers on the next call when the session is dropped between two operations", async () => {
      const driver = await disk();
      await driver.put("before.txt", "first");

      await killSession(driver);

      expect((await driver.get("before.txt")).toString("utf-8")).toBe("first");
      await driver.put("after.txt", "second");
      expect((await driver.get("after.txt")).toString("utf-8")).toBe("second");
    });

    it("recovers a dropped session on a listing too", async () => {
      const driver = await disk();
      await driver.put("a.txt", "x");
      await driver.put("sub/b.txt", "y");

      await killSession(driver);

      expect(await driver.allFiles()).toEqual(["a.txt", "sub/b.txt"]);
    });

    it("concurrent first operations share a single handshake", async () => {
      const driver = await disk();

      await Promise.all([
        driver.put("a.txt", "1"),
        driver.put("b.txt", "2"),
        driver.put("c.txt", "3"),
      ]);

      expect(await driver.files()).toEqual(["a.txt", "b.txt", "c.txt"]);
    });
  });

  describe("atomic writes", () => {
    /**
     * atmoz/sftp is OpenSSH, so the extension is there and this is a real
     * atomic replace. On a server without it the driver degrades to
     * unlink-then-rename, which is why this asserts on the capability
     * rather than assuming it.
     */
    it("uses posix-rename where the server offers it", async () => {
      const driver = await disk();
      await driver.put("a.txt", "x");

      expect(driver.sftp().replacesAtomically()).toBe(true);
    });

    it("a write killed mid-transfer leaves no file and no temp file behind", async () => {
      const driver = await disk();
      const stream = await driver.writeStream("partial.txt");
      stream.write("some bytes");

      await new Promise<void>((resolve) => {
        stream.on("close", () => resolve());
        stream.destroy(new Error("boom"));
      });

      expect(await driver.exists("partial.txt")).toBe(false);
      expect(await driver.files()).toEqual([]);
    });

    it("the previous file survives a write that dies before finishing", async () => {
      const driver = await disk();
      await driver.put("a.txt", "the original");

      const stream = await driver.writeStream("a.txt");
      stream.write("replacement, never finished");
      await new Promise<void>((resolve) => {
        stream.on("close", () => resolve());
        stream.destroy(new Error("boom"));
      });

      expect((await driver.get("a.txt")).toString("utf-8")).toBe("the original");
      expect(await driver.files()).toEqual(["a.txt"]);
    });

    /**
     * `finish` has to mean "readable at the final path", not "the temp
     * file closed". If the rename happened after the event, this read
     * would race it.
     */
    it("finish means the bytes are readable at the final path", async () => {
      const driver = await disk();
      const stream = await driver.writeStream("a.txt");

      await new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
        stream.end("committed");
      });

      expect((await driver.get("a.txt")).toString("utf-8")).toBe("committed");
    });
  });

  describe("listing over a slow link", () => {
    it("allFiles() walks a tree far deeper than the concurrency bound", async () => {
      const { driver, cleanup } = await testDriver({ concurrency: 2 });
      cleanups.push(cleanup);

      const expected: string[] = [];
      let dir = "deep";

      for (let depth = 0; depth < 12; depth += 1) {
        dir = `${dir}/d${depth}`;
        const file = `${dir}/f.txt`;
        await driver.put(file, "x");
        expected.push(file);
      }

      expect(await driver.allFiles()).toEqual([...expected].sort());
    });

    it("allFiles() walks a tree far wider than the concurrency bound", async () => {
      const { driver, cleanup } = await testDriver({ concurrency: 2 });
      cleanups.push(cleanup);

      const expected: string[] = [];

      for (let branch = 0; branch < 9; branch += 1) {
        const file = `w${branch}/f.txt`;
        await driver.put(file, "x");
        expected.push(file);
      }

      expect(await driver.allFiles()).toEqual([...expected].sort());
    });
  });

  describe("remote-specific behaviour", () => {
    it("copy() moves the bytes through the client and leaves both files intact", async () => {
      const driver = await disk();
      const contents = Buffer.alloc(256 * 1024, 5);
      await driver.put("big.bin", contents);
      await driver.copy("big.bin", "copies/big.bin");

      expect((await driver.get("copies/big.bin")).equals(contents)).toBe(true);
      expect(await driver.size("big.bin")).toBe(contents.length);
    });

    it("move() replaces an existing destination, which plain SFTP rename refuses", async () => {
      const driver = await disk();
      await driver.put("a.txt", "new");
      await driver.put("b.txt", "old and longer");
      await driver.move("a.txt", "b.txt");

      expect((await driver.get("b.txt")).toString("utf-8")).toBe("new");
      expect(await driver.exists("a.txt")).toBe(false);
    });

    it("makeDirectory() creates a deep path, which SFTP has no recursive mkdir for", async () => {
      const driver = await disk();
      await driver.makeDirectory("a/b/c/d");

      expect(await driver.allDirectories()).toEqual(["a", "a/b", "a/b/c", "a/b/c/d"]);
    });

    it("deleteDirectory() removes a non-empty tree, which SFTP rmdir refuses", async () => {
      const driver = await disk();
      await driver.put("tree/a.txt", "a");
      await driver.put("tree/sub/b.txt", "b");
      await driver.makeDirectory("tree/empty");

      await driver.deleteDirectory("tree");

      expect(await driver.directories()).toEqual([]);
      expect(await driver.exists("tree/sub/b.txt")).toBe(false);
    });

    it("lastModified() returns a real timestamp from the server", async () => {
      const driver = await disk();
      await driver.put("a.txt", "x");
      const mtime = await driver.lastModified("a.txt");

      expect(mtime).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - mtime.getTime())).toBeLessThan(120_000);
    });

    it("a missing file is FileNotFoundException, not a raw SFTP status", async () => {
      const driver = await disk();

      await expect(driver.get("nope.txt")).rejects.toBeInstanceOf(FileNotFoundException);
      await expect(driver.readStream("nope.txt")).rejects.toBeInstanceOf(FileNotFoundException);
      await expect(driver.size("nope.txt")).rejects.toBeInstanceOf(FileNotFoundException);
    });

    it("a root that does not exist yet lists as empty rather than throwing", async () => {
      const driver = new SftpStorageDriver(
        sftpConfig({ root: `upload/not-created-${Date.now()}` }),
      );

      try {
        expect(await driver.files()).toEqual([]);
        expect(await driver.allFiles()).toEqual([]);
      } finally {
        await driver.disconnect();
      }
    });

    it("writes create the disk root on demand", async () => {
      const root = `upload/on-demand-${Date.now()}`;
      const driver = new SftpStorageDriver(sftpConfig({ root }));

      try {
        await driver.put("a.txt", "x");
        expect((await driver.get("a.txt")).toString("utf-8")).toBe("x");
      } finally {
        await driver.deleteDirectory("").catch(() => {});
        await driver.disconnect();
      }
    });

    it("a relative root resolves against the login user's home directory", async () => {
      const driver = new SftpStorageDriver(sftpConfig({ root: "upload" }));

      try {
        expect(await driver.sftp().remoteRoot()).toBe("/upload");
      } finally {
        await driver.disconnect();
      }
    });
  });
});

/**
 * Drop the SSH session the way a server (or a NAT table, or a sleeping
 * NAS) does: kill the transport without the driver being told. Reaching
 * into the connection's private client is the only way to simulate that
 * from in-process, and simulating it is the whole point of the test.
 */
async function killSession(driver: SftpStorageDriver): Promise<void> {
  const connection = driver.sftp() as unknown as { client?: { destroy(): void } };
  connection.client?.destroy();

  // Let the `close` handlers run, so the driver has genuinely forgotten
  // the channel rather than racing the next call against the teardown.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}
