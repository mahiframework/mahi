import { mkdtemp, rm, writeFile, symlink, stat, lstat, readlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageDriver } from "../../src/drivers/local-storage-driver.js";
import { FileNotFoundException } from "../../src/exceptions.js";
import { storageDriverContract } from "../../src/testing/storage-driver-contract.js";

describe("LocalStorageDriver", () => {
  let tmpDir: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-storage-test-"));
    driver = new LocalStorageDriver(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * The shared `StorageDriver` contract, the same cases every other
   * driver runs. A guarantee that only one implementation honours is a
   * guarantee callers can't rely on, so the contract lives in one place
   * and the drivers can't drift.
   */
  describe("StorageDriver contract", () => {
    for (const testCase of storageDriverContract({ hasSymlink: true, hasHardlink: true })) {
      it(testCase.name, async () => {
        await testCase.run(driver);
      });
    }
  });

  describe("StorageDriver contract (public disk)", () => {
    for (const testCase of storageDriverContract({
      urlPrefix: "/storage",
      hasSymlink: true,
      hasHardlink: true,
    })) {
      it(testCase.name, async () => {
        await testCase.run(new LocalStorageDriver(tmpDir, "/storage"));
      });
    }
  });

  /**
   * The same contract again with the temporary-URL fallback wired, which
   * is how a private local disk gets a shareable link. The builder is a
   * stand-in for `signedDiskUrls(name)`: the contract only asserts the
   * *shape* of what comes back, and the real signing is covered in
   * `temporary-url.test.ts` where a container and a signer exist.
   */
  describe("StorageDriver contract (temporary urls)", () => {
    for (const testCase of storageDriverContract({
      hasTemporaryUrl: true,
      hasSymlink: true,
      hasHardlink: true,
    })) {
      it(testCase.name, async () => {
        await testCase.run(
          new LocalStorageDriver(tmpDir, undefined, {
            temporaryUrl: async (filePath, expiresIn) =>
              `https://app.test/storage/temporary/private/${filePath}` +
              `?expires=${Math.floor(Date.now() / 1000) + expiresIn}&signature=stub`,
          }),
        );
      });
    }
  });

  it("path() returns an absolute filesystem path under the root", async () => {
    await driver.put("a.txt", "x");
    const p = driver.path("a.txt");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(path.resolve(tmpDir))).toBe(true);
  });

  it("url() joins an absolute CDN prefix", async () => {
    const publicDisk = new LocalStorageDriver(tmpDir, "https://cdn.example.com/media");
    expect(publicDisk.url("posts/1.png")).toBe("https://cdn.example.com/media/posts/1.png");
  });

  it("url() percent-encodes each path segment", async () => {
    const publicDisk = new LocalStorageDriver(tmpDir, "/storage");
    expect(publicDisk.url("a b.png")).toBe("/storage/a%20b.png");
    expect(publicDisk.url("dir with space/a?b=1#c.png")).toBe(
      "/storage/dir%20with%20space/a%3Fb%3D1%23c.png",
    );
  });

  it("url() throws for a private disk (no prefix configured), matching Laravel", async () => {
    await driver.put("a.txt", "x");
    expect(() => driver.url("a.txt")).toThrow(/does not support retrieving URLs/);
  });

  describe("symlink escape (realpath guard)", () => {
    let outsideDir: string;

    beforeEach(async () => {
      outsideDir = await mkdtemp(path.join(tmpdir(), "mahi-storage-outside-"));
    });

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it("get() refuses to follow a symlink that resolves outside the root", async () => {
      const secret = path.join(outsideDir, "secret.txt");
      await writeFile(secret, "top secret");
      await symlink(secret, path.join(tmpDir, "link.txt"));

      await expect(driver.get("link.txt")).rejects.toThrow(/escapes the storage root/);
    });

    it("exists() reports false for a symlink escaping the root (does not leak it)", async () => {
      const secret = path.join(outsideDir, "secret.txt");
      await writeFile(secret, "top secret");
      await symlink(secret, path.join(tmpDir, "link.txt"));

      expect(await driver.exists("link.txt")).toBe(false);
    });

    it("get() refuses a file reached through a symlinked directory", async () => {
      await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
      await symlink(outsideDir, path.join(tmpDir, "outlink"));

      await expect(driver.get("outlink/secret.txt")).rejects.toThrow(/escapes the storage root/);
    });

    it("put() refuses to write through a symlink pointing outside the root", async () => {
      await symlink(path.join(outsideDir, "target.txt"), path.join(tmpDir, "link.txt"));

      await expect(driver.put("link.txt", "pwned")).rejects.toThrow(/escapes the storage root/);
      // The outside target must not have been written through the symlink.
      const outsideDriver = new LocalStorageDriver(outsideDir);
      expect(await outsideDriver.exists("target.txt")).toBe(false);
    });

    it("still follows a symlink that stays inside the root", async () => {
      await driver.put("real.txt", "inside");
      await symlink(path.join(tmpDir, "real.txt"), path.join(tmpDir, "alias.txt"));

      const buf = await driver.get("alias.txt");
      expect(buf.toString("utf-8")).toBe("inside");
    });

    it("files() refuses to descend a symlinked directory escaping the root", async () => {
      await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
      await symlink(outsideDir, path.join(tmpDir, "outlink"));

      await expect(driver.files("outlink")).rejects.toThrow(/escapes the storage root/);
    });

    it("readStream() refuses a symlink escaping the root", async () => {
      const secret = path.join(outsideDir, "secret.txt");
      await writeFile(secret, "top secret");
      await symlink(secret, path.join(tmpDir, "link.txt"));

      await expect(driver.readStream("link.txt")).rejects.toThrow(/escapes the storage root/);
    });
  });

  it("makeDirectory() creates a real directory on disk", async () => {
    await driver.makeDirectory("d/e/f");
    expect((await stat(driver.path("d/e/f"))).isDirectory()).toBe(true);
  });

  /**
   * What the shared contract deliberately leaves out: it asserts both
   * kinds of link read back, because that is what every driver owes, but
   * the properties that make them *different* are filesystem-specific.
   */
  describe("links", () => {
    let outsideRoot: string;

    beforeEach(async () => {
      outsideRoot = await mkdtemp(path.join(tmpdir(), "mahi-storage-outside-"));
      await writeFile(path.join(outsideRoot, "secret.txt"), "top secret");
    });

    afterEach(async () => {
      await rm(outsideRoot, { recursive: true, force: true });
    });

    it("symlink() stores a target relative to the link's own directory", async () => {
      await driver.put("originals/photo.jpg", "bytes");
      await driver.symlink("originals/photo.jpg", "albums/summer/photo.jpg");

      // Relative, and specifically relative to the link's directory
      // rather than to the root, which is what makes it resolve.
      expect(await readlink(driver.path("albums/summer/photo.jpg"))).toBe(
        path.join("..", "..", "originals", "photo.jpg"),
      );
    });

    it("symlinks survive the storage root being moved", async () => {
      await driver.put("originals/photo.jpg", "bytes");
      await driver.symlink("originals/photo.jpg", "albums/photo.jpg");

      // The case a relative target exists for: the same directory tree
      // reachable at a different absolute path, as under a container
      // bind-mount or after a deployment moves the disk.
      const moved = `${tmpDir}-moved`;
      await rename(tmpDir, moved);

      try {
        const movedDriver = new LocalStorageDriver(moved);
        expect((await movedDriver.get("albums/photo.jpg")).toString("utf-8")).toBe("bytes");
      } finally {
        await rename(moved, tmpDir);
      }
    });

    it("a symlink dangles when its original is deleted", async () => {
      await driver.put("original.txt", "bytes");
      await driver.symlink("original.txt", "link.txt");
      await driver.delete("original.txt");

      // The link is a path reference, so the entry remains and resolves
      // to nothing. `exists()` reports false because it checks access.
      expect(await driver.exists("link.txt")).toBe(false);
      expect((await lstat(driver.path("link.txt"))).isSymbolicLink()).toBe(true);
    });

    it("a hard link keeps the bytes alive after its original is deleted", async () => {
      await driver.put("original.txt", "bytes");
      await driver.hardlink("original.txt", "link.txt");
      await driver.delete("original.txt");

      // The whole point of a hard link: there is no "real one", so the
      // last remaining name still has the file.
      expect(await driver.exists("link.txt")).toBe(true);
      expect((await driver.get("link.txt")).toString("utf-8")).toBe("bytes");
    });

    it("hardlink() points both names at one inode, so a write through either is seen by both", async () => {
      await driver.put("original.txt", "first");
      await driver.hardlink("original.txt", "link.txt");

      expect((await lstat(driver.path("link.txt"))).ino).toBe(
        (await lstat(driver.path("original.txt"))).ino,
      );
    });

    it("put() through a symlink writes to the original, since the link stays in the root", async () => {
      await driver.put("original.txt", "bytes");
      await driver.symlink("original.txt", "link.txt");
      await driver.put("link.txt", "replaced");

      // Writing through a link is POSIX behaviour and the link resolves
      // inside the root, so the guard permits it: both names now read the
      // new bytes, and the link is still a link. The guard's job is to
      // refuse a link pointing *outside* the root, which is covered above.
      expect((await driver.get("original.txt")).toString("utf-8")).toBe("replaced");
      expect((await driver.get("link.txt")).toString("utf-8")).toBe("replaced");
      expect((await lstat(driver.path("link.txt"))).isSymbolicLink()).toBe(true);
    });

    it("files() lists a symlink to a file, but not a dangling or escaping one", async () => {
      await driver.put("original.txt", "bytes");
      await driver.symlink("original.txt", "good.txt");
      await symlink(path.join(tmpDir, "gone.txt"), path.join(tmpDir, "dangling.txt"));
      await symlink(path.join(outsideRoot, "secret.txt"), path.join(tmpDir, "escaping.txt"));

      // Consistent with `exists()`, which is false for the latter two.
      expect(await driver.files()).toEqual(["good.txt", "original.txt"]);
    });

    it("directories() does not report a symlink to a directory, so a cyclic link cannot be walked", async () => {
      await driver.put("sub/file.txt", "x");
      await symlink(path.join(tmpDir, "sub"), path.join(tmpDir, "sub-link"));

      expect(await driver.directories()).toEqual(["sub"]);
      // The guard that matters: a link pointing at its own ancestor must
      // not make the recursive walk unbounded.
      await symlink(tmpDir, path.join(tmpDir, "self"));
      expect(await driver.allFiles()).toEqual(["sub/file.txt"]);
    });

    it("refuses to link a directory", async () => {
      await driver.makeDirectory("d");

      await expect(driver.symlink("d", "link")).rejects.toThrow(FileNotFoundException);
      await expect(driver.hardlink("d", "link")).rejects.toThrow(FileNotFoundException);
    });

    it("supportsLink() reports both kinds", async () => {
      expect(await driver.supportsLink("soft")).toBe(true);
      expect(await driver.supportsLink("hard")).toBe(true);
    });
  });
});
