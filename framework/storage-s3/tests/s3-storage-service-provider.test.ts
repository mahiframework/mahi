import { describe, expect, it } from "vitest";
import { Application, STORAGE_TOKEN } from "@mahiframework/core";
import {
  LocalStorageDriver,
  StorageManager,
  StorageServiceProvider,
  type StorageConfig,
} from "@mahiframework/storage";
import { S3StorageDriver } from "../src/s3-storage-driver.js";
import { S3StorageServiceProvider } from "../src/s3-storage-service-provider.js";
import { isS3DiskConfig } from "../src/s3-disk-config.js";
import { isNotFound } from "../src/s3-connection.js";

/**
 * No server needed: registering a disk builds no client and loads no SDK,
 * which is itself the property being asserted. An app that lists this
 * provider but never touches an S3 disk should pay nothing for it.
 */
function application(disks: StorageConfig["disks"], defaultDisk = "local"): Application {
  const app = new Application();
  app.config.set("storage", { default: defaultDisk, disks });

  const storage = new StorageServiceProvider(app);
  storage.register();

  const s3 = new S3StorageServiceProvider(app);
  s3.register();

  return app;
}

describe("S3StorageServiceProvider", () => {
  const bucket = { driver: "s3" as const, bucket: "media", region: "us-east-1" };

  it("registers an S3StorageDriver for every s3 disk, leaving local disks to StorageServiceProvider", () => {
    const app = application({
      local: { root: "/tmp/mahi-local" },
      media: bucket,
    });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.disk("local")).toBeInstanceOf(LocalStorageDriver);
    expect(storage.disk("media")).toBeInstanceOf(S3StorageDriver);
  });

  /**
   * Resolving the driver constructs it and nothing more. The SDK is an 18 MB
   * optional peer dependency loaded on first use, so an unused disk costs
   * neither the import nor a socket.
   */
  it("builds no client and loads no SDK when a disk is merely registered or resolved", () => {
    const app = application({ media: bucket });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    const driver = storage.disk("media") as S3StorageDriver;

    expect(driver.s3().connected()).toBe(false);
  });

  it("passes a configured url prefix through to the driver", () => {
    const app = application({
      media: { ...bucket, url: "https://cdn.example.com/media" },
    });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.url("clip.mp4", "media")).toBe("https://cdn.example.com/media/clip.mp4");
  });

  it("an s3 disk without a url prefix throws from url()", () => {
    const app = application({ media: bucket });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(() => storage.url("clip.mp4", "media")).toThrow(/no public URL/);
  });

  it("shutdown() resolves nothing when storage was never used", async () => {
    const app = new Application();
    app.config.set("storage", { default: "local", disks: { media: bucket } });
    const provider = new S3StorageServiceProvider(app);

    await provider.shutdown();

    expect(app.isResolved(STORAGE_TOKEN)).toBe(false);
  });

  it("scopes keys under a configured root", () => {
    const app = application({ media: { ...bucket, root: "uploads" } });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);
    const driver = storage.disk("media") as S3StorageDriver;

    expect(driver.s3().key("avatar.png")).toBe("uploads/avatar.png");
    expect(driver.s3().relative("uploads/avatar.png")).toBe("avatar.png");
    expect(driver.s3().relative("elsewhere/avatar.png")).toBeUndefined();
  });

  /**
   * The documented pattern for buckets that live in the database rather
   * than in config: a disk per row, built on demand with `extend()`,
   * re-extended when the row is edited (which invalidates the cached
   * driver), and dropped with `forget()`, which releases the client's
   * sockets rather than leaking them.
   */
  describe("disks built at runtime from database rows", () => {
    it("extend() adds a disk after boot and forget() drops and disconnects it", async () => {
      const app = application({ local: { root: "/tmp/mahi-local" } });
      const storage = app.make<StorageManager>(STORAGE_TOKEN);

      storage.extend("tenant:7", () => new S3StorageDriver({ bucket: "tenant-7" }));

      expect(storage.disk("tenant:7")).toBeInstanceOf(S3StorageDriver);
      expect(storage.isResolved("tenant:7")).toBe(true);

      expect(await storage.forget("tenant:7")).toBe(true);

      expect(storage.isResolved("tenant:7")).toBe(false);
      expect(() => storage.disk("tenant:7")).toThrow(/not registered/);
    });

    it("re-extending a disk replaces the driver, so an edited bucket takes effect", () => {
      const app = application({ local: { root: "/tmp/mahi-local" } });
      const storage = app.make<StorageManager>(STORAGE_TOKEN);

      storage.extend("tenant:7", () => new S3StorageDriver({ bucket: "old" }));
      const before = storage.disk("tenant:7");

      storage.extend("tenant:7", () => new S3StorageDriver({ bucket: "new" }));

      expect(storage.disk("tenant:7")).not.toBe(before);
    });
  });

  describe("path() and url() need no client", () => {
    it("path() throws without ever loading the SDK", () => {
      const driver = new S3StorageDriver({ bucket: "media" });

      expect(() => driver.path("a.txt")).toThrow(/object storage/);
      expect(driver.s3().connected()).toBe(false);
    });
  });
});

describe("isS3DiskConfig()", () => {
  it("accepts an s3 disk with a bucket", () => {
    expect(isS3DiskConfig({ driver: "s3", bucket: "media" })).toBe(true);
  });

  it("rejects a local disk, other drivers, and incomplete s3 configs", () => {
    expect(isS3DiskConfig({ root: "/srv/files" })).toBe(false);
    expect(isS3DiskConfig({ driver: "local", root: "/srv/files" })).toBe(false);
    expect(isS3DiskConfig({ driver: "sftp", host: "nas.local", username: "mahi" })).toBe(false);
    expect(isS3DiskConfig({ driver: "s3" })).toBe(false);
    expect(isS3DiskConfig(null)).toBe(false);
    expect(isS3DiskConfig("s3")).toBe(false);
  });
});

/**
 * S3 reports a missing key two different ways: `GetObject` answers
 * `NoSuchKey`, while `HeadObject` answers `NotFound`, because a HEAD
 * response has no body to carry the real code. Both, plus a bare 404 from a
 * compatible server using neither spelling, have to read as "missing".
 */
describe("isNotFound()", () => {
  it("recognises both SDK spellings and a bare 404", () => {
    expect(isNotFound({ name: "NoSuchKey" })).toBe(true);
    expect(isNotFound({ name: "NotFound" })).toBe(true);
    expect(isNotFound({ Code: "NoSuchKey" })).toBe(true);
    expect(isNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  it("does not swallow other failures", () => {
    expect(isNotFound({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isNotFound({ name: "SlowDown", $metadata: { httpStatusCode: 503 } })).toBe(false);
    expect(isNotFound(new Error("socket hang up"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
