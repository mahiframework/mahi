import { mkdtemp, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageDriver } from "../../src/drivers/local-storage-driver.js";
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
    for (const testCase of storageDriverContract()) {
      it(testCase.name, async () => {
        await testCase.run(driver);
      });
    }
  });

  describe("StorageDriver contract (public disk)", () => {
    for (const testCase of storageDriverContract({ urlPrefix: "/storage" })) {
      it(testCase.name, async () => {
        await testCase.run(new LocalStorageDriver(tmpDir, "/storage"));
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
});
