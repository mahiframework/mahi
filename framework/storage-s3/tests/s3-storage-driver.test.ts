import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { storageDriverContract, FileNotFoundException } from "@mahiframework/storage";
import { S3StorageDriver } from "../src/s3-storage-driver.js";
import { S3_UNAVAILABLE, s3Config, testDriver } from "./s3-test-helpers.js";

describe.skipIf(S3_UNAVAILABLE)("S3StorageDriver (integration)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function disk(urlPrefix?: string): Promise<S3StorageDriver> {
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
   * having it: a bucket is a flat key/value store, so a sorted listing,
   * `[]` for a missing directory, an up-front `FileNotFoundException` and
   * an atomic `writeStream` are all things this driver has to construct
   * rather than inherit, and callers rely on them without knowing which
   * disk they hold.
   *
   * `largeFileBytes` is 512 KiB rather than the 8 MiB default: it is well
   * past one chunk, and the genuinely multipart path (above the 5 MiB part
   * size) gets its own test below rather than being paid for in every
   * streaming case.
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
   * A bucket's public URL depends on its policy, so both shapes are real:
   * a private disk whose `url()` throws, and one behind a CDN.
   */
  describe("StorageDriver contract (with a url prefix)", () => {
    for (const testCase of storageDriverContract({
      hasPath: false,
      urlPrefix: "https://cdn.example.com/media",
      largeFileBytes: 512 * 1024,
    })) {
      it(testCase.name, async () => {
        await testCase.run(await disk("https://cdn.example.com/media"));
      });
    }
  });

  describe("url() and path()", () => {
    it("url() throws without a prefix, naming the bucket policy as the reason", async () => {
      const driver = await disk();
      expect(() => driver.url("a.txt")).toThrow(/no public URL/);
    });

    it("path() always throws, rather than inventing a local path", async () => {
      const driver = await disk();
      expect(() => driver.path("a.txt")).toThrow(/object storage/);
    });

    it("temporaryUrl() signs a working link to a private object", async () => {
      const driver = await disk();
      await driver.put("secret.txt", "classified");

      const url = await driver.temporaryUrl("secret.txt", 60);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("classified");
    });
  });

  /**
   * Directories don't exist in a bucket, so `makeDirectory()` writes a
   * zero-byte marker at `prefix/`. The marker is what makes an empty
   * directory visible, and it must never surface as a file — which is the
   * easiest way to fail the contract subtly, since the marker's own
   * listing entry has an empty name.
   */
  describe("directory markers", () => {
    it("an empty directory is listed, and its marker is not a file", async () => {
      const driver = await disk();
      await driver.makeDirectory("empty");

      expect(await driver.directories("")).toEqual(["empty"]);
      expect(await driver.files("")).toEqual([]);
      expect(await driver.files("empty")).toEqual([]);
      expect(await driver.allFiles("")).toEqual([]);
    });

    it("a directory implied only by a nested file is still listed", async () => {
      const driver = await disk();
      await driver.put("implied/deep/file.txt", "x");

      expect(await driver.directories("")).toEqual(["implied"]);
      expect(await driver.allDirectories("")).toEqual(["implied", "implied/deep"]);
    });

    it("makeDirectory() is idempotent and deleteDirectory() removes the marker", async () => {
      const driver = await disk();
      await driver.makeDirectory("twice");
      await driver.makeDirectory("twice");

      expect(await driver.directories("")).toEqual(["twice"]);

      await driver.deleteDirectory("twice");

      expect(await driver.directories("")).toEqual([]);
    });
  });

  /**
   * One listing request returns at most 1000 keys. A bucket larger than
   * that is the normal case in production and never reached by the
   * contract suite, so the continuation loop is tested directly with a
   * deliberately tiny page size.
   */
  describe("pagination", () => {
    it("lists every file across several pages", async () => {
      const { driver, cleanup } = await testDriver({ pageSize: 2 });
      cleanups.push(cleanup);

      for (let index = 0; index < 7; index += 1) {
        await driver.put(`page/file-${index}.txt`, String(index));
      }

      const files = await driver.files("page");

      expect(files).toHaveLength(7);
      expect(files[0]).toBe("page/file-0.txt");
      expect(await driver.allFiles("")).toHaveLength(7);
    });

    it("deletes a directory spanning several pages", async () => {
      const { driver, cleanup } = await testDriver({ pageSize: 2 });
      cleanups.push(cleanup);

      for (let index = 0; index < 5; index += 1) {
        await driver.put(`bulk/file-${index}.txt`, String(index));
      }

      await driver.deleteDirectory("bulk");

      expect(await driver.allFiles("")).toEqual([]);
    });
  });

  /**
   * Write atomicity comes from the protocol here rather than from a
   * temp-and-rename: nothing is visible at the key until
   * `CompleteMultipartUpload`. These assert that, since it is the reason
   * the `CommittingWriteStream` the other drivers need is absent.
   */
  describe("atomic writes", () => {
    it("a destroyed writeStream leaves nothing at the final key", async () => {
      const driver = await disk();
      const stream = await driver.writeStream("aborted.bin");

      stream.write(Buffer.alloc(1024, 1));
      stream.destroy(new Error("boom"));

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await driver.exists("aborted.bin")).toBe(false);
    });

    it("a failed replace leaves the previous bytes intact", async () => {
      const driver = await disk();
      await driver.put("keep.txt", "original");

      const stream = await driver.writeStream("keep.txt");
      stream.write(Buffer.from("replacement"));
      stream.destroy(new Error("boom"));

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect((await driver.get("keep.txt")).toString()).toBe("original");
    });

    it("finish means the object is readable at its final key", async () => {
      const driver = await disk();
      const stream = await driver.writeStream("committed.txt");

      await new Promise<void>((resolve, reject) => {
        stream.once("finish", () => resolve());
        stream.once("error", reject);
        stream.end(Buffer.from("committed"));
      });

      expect((await driver.get("committed.txt")).toString()).toBe("committed");
    });

    it("a payload larger than the part size uploads as real multipart", async () => {
      const driver = await disk();
      // 6 MiB against a 5 MiB part size: two parts, so this exercises
      // CreateMultipartUpload/UploadPart/CompleteMultipartUpload rather
      // than the single-request PutObject path.
      const payload = Buffer.alloc(6 * 1024 * 1024, 7);
      await driver.putStream("multipart.bin", Readable.from([payload]));

      expect(await driver.size("multipart.bin")).toBe(payload.length);
      expect((await driver.get("multipart.bin")).equals(payload)).toBe(true);
    });
  });

  describe("object storage specifics", () => {
    it("copy() is server-side and leaves both objects readable", async () => {
      const driver = await disk();
      const payload = Buffer.alloc(256 * 1024, 3);
      await driver.put("source.bin", payload);

      await driver.copy("source.bin", "nested/target.bin");

      expect((await driver.get("source.bin")).equals(payload)).toBe(true);
      expect((await driver.get("nested/target.bin")).equals(payload)).toBe(true);
    });

    it("copy() handles a key with characters that need encoding", async () => {
      const driver = await disk();
      await driver.put("odd name +1.txt", "spaces and plus");

      await driver.copy("odd name +1.txt", "copied odd.txt");

      expect((await driver.get("copied odd.txt")).toString()).toBe("spaces and plus");
    });

    it("move() copies then deletes, since S3 has no rename", async () => {
      const driver = await disk();
      await driver.put("from.txt", "moved");

      await driver.move("from.txt", "to.txt");

      expect(await driver.exists("from.txt")).toBe(false);
      expect((await driver.get("to.txt")).toString()).toBe("moved");
    });

    it("append reads, concatenates and rewrites, since objects are immutable", async () => {
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

    it("stores a Content-Type guessed from the extension", async () => {
      const driver = await disk();
      await driver.put("avatar.png", "not really a png");

      const head = await driver.s3().head(driver.s3().key("avatar.png"));

      expect(head?.ContentType).toBe("image/png");
    });
  });

  /**
   * S3 reports a missing key two different ways — `GetObject` says
   * `NoSuchKey`, `HeadObject` says `NotFound`, because a HEAD response has
   * no body to carry the code. Both have to become the same exception.
   */
  describe("missing objects", () => {
    it("get() throws FileNotFoundException, not a raw SDK error", async () => {
      const driver = await disk();

      await expect(driver.get("nope.txt")).rejects.toThrow(FileNotFoundException);
    });

    it("readStream() rejects before any chunk is emitted", async () => {
      const driver = await disk();

      await expect(driver.readStream("nope.txt")).rejects.toThrow(FileNotFoundException);
    });

    it("size() and lastModified() throw from a HeadObject 404", async () => {
      const driver = await disk();

      await expect(driver.size("nope.txt")).rejects.toThrow(FileNotFoundException);
      await expect(driver.lastModified("nope.txt")).rejects.toThrow(FileNotFoundException);
    });

    it("copy() throws when the source is missing", async () => {
      const driver = await disk();

      await expect(driver.copy("nope.txt", "dest.txt")).rejects.toThrow(FileNotFoundException);
    });

    it("delete() on a missing key is a no-op", async () => {
      const driver = await disk();

      await expect(driver.delete("nope.txt")).resolves.toBeUndefined();
    });

    it("listing an unused prefix is empty rather than an error", async () => {
      const driver = await disk();

      expect(await driver.files("nope")).toEqual([]);
      expect(await driver.allFiles("nope")).toEqual([]);
      expect(await driver.list("nope")).toEqual({ files: [], directories: [] });
    });
  });

  describe("root prefix", () => {
    it("scopes keys under the configured root", async () => {
      const root = `mahi-test-root-${Date.now()}`;
      const { driver, cleanup } = await testDriver({ root });
      cleanups.push(cleanup);

      await driver.put("a.txt", "a");

      expect(driver.s3().key("a.txt")).toBe(`${root}/a.txt`);
      expect(await driver.files("")).toEqual(["a.txt"]);
    });

    it("keeps two disks in one bucket from seeing each other", async () => {
      const first = await disk();
      const second = await disk();

      await first.put("mine.txt", "first");

      expect(await second.files("")).toEqual([]);
      expect(await first.files("")).toEqual(["mine.txt"]);
    });
  });

  describe("lifecycle", () => {
    it("builds no client until an operation runs", async () => {
      const driver = new S3StorageDriver(s3Config());

      expect(driver.s3().connected()).toBe(false);

      await driver.exists("anything.txt");

      expect(driver.s3().connected()).toBe(true);
      await driver.disconnect();
    });

    it("disconnect() is safe when never connected, and twice", async () => {
      const driver = new S3StorageDriver(s3Config());

      await expect(driver.disconnect()).resolves.toBeUndefined();
      await expect(driver.disconnect()).resolves.toBeUndefined();
    });

    it("reuses one client across operations", async () => {
      const driver = await disk();
      await driver.put("a.txt", "a");
      const client = await driver.s3().connect();
      await driver.put("b.txt", "b");

      expect(await driver.s3().connect()).toBe(client);
    });

    it("rebuilds the client after a disconnect", async () => {
      const driver = await disk();
      await driver.put("a.txt", "a");

      await driver.disconnect();
      expect(driver.s3().connected()).toBe(false);

      expect(await driver.exists("a.txt")).toBe(true);
    });
  });
});
