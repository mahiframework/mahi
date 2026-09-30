import { describe, expect, it } from "vitest";
import { Application, STORAGE_TOKEN } from "@mahiframework/core";
import {
  LocalStorageDriver,
  StorageManager,
  StorageServiceProvider,
  type StorageConfig,
} from "@mahiframework/storage";
import { SftpStorageDriver } from "../src/sftp-storage-driver.js";
import { SftpStorageServiceProvider } from "../src/sftp-storage-service-provider.js";
import { isSftpDiskConfig } from "../src/sftp-disk-config.js";
import { sftpConfig } from "./sftp-test-helpers.js";

/**
 * No server needed: registering a disk resolves no connection, which is
 * itself the property being asserted. A NAS that is asleep at boot must
 * not be a boot failure.
 */
function application(disks: StorageConfig["disks"], defaultDisk = "local"): Application {
  const app = new Application();
  app.config.set("storage", { default: defaultDisk, disks });

  const storage = new StorageServiceProvider(app);
  storage.register();

  const sftp = new SftpStorageServiceProvider(app);
  sftp.register();

  return app;
}

describe("SftpStorageServiceProvider", () => {
  const remote = { driver: "sftp" as const, host: "nas.invalid", username: "mahi", root: "media" };

  it("registers an SftpStorageDriver for every sftp disk, leaving local disks to StorageServiceProvider", () => {
    const app = application({
      local: { root: "/tmp/mahi-local" },
      media: remote,
    });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.disk("local")).toBeInstanceOf(LocalStorageDriver);
    expect(storage.disk("media")).toBeInstanceOf(SftpStorageDriver);
  });

  /**
   * Registration must not connect. Resolving the driver constructs it and
   * nothing more, the SSH session opens on the first operation, so an
   * unreachable host costs nothing until something actually reads from it.
   */
  it("opens no connection when a disk is merely registered or resolved", () => {
    const app = application({ media: remote });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    const driver = storage.disk("media") as SftpStorageDriver;

    expect(driver.sftp().connected()).toBe(false);
  });

  it("passes a configured url prefix through to the driver", () => {
    const app = application({
      media: { ...remote, url: "https://media.example.com/files" },
    });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.url("clip.mp4", "media")).toBe("https://media.example.com/files/clip.mp4");
  });

  it("an sftp disk without a url prefix throws from url()", () => {
    const app = application({ media: remote });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(() => storage.url("clip.mp4", "media")).toThrow(/no public URL/);
  });

  it("shutdown() resolves nothing when storage was never used", async () => {
    const app = new Application();
    app.config.set("storage", { default: "local", disks: { media: remote } });
    const provider = new SftpStorageServiceProvider(app);

    await provider.shutdown();

    expect(app.isResolved(STORAGE_TOKEN)).toBe(false);
  });

  /**
   * The documented pattern for hosts that live in the database rather
   * than in config: a disk per row, built on demand with `extend()`,
   * re-extended when the row is edited (which `Manager.extend()`
   * invalidates the cached driver for), and dropped with `forget()`
   * when the row goes away, which disconnects it rather than leaking the
   * SSH session.
   */
  describe("disks built at runtime from database rows", () => {
    it("extend() adds a disk after boot and forget() drops and disconnects it", async () => {
      const app = application({ local: { root: "/tmp/mahi-local" } });
      const storage = app.make<StorageManager>(STORAGE_TOKEN);

      storage.extend("library:7", () => new SftpStorageDriver(sftpConfig({ host: "nas.invalid" })));

      const driver = storage.disk("library:7") as SftpStorageDriver;
      expect(driver).toBeInstanceOf(SftpStorageDriver);
      expect(storage.isResolved("library:7")).toBe(true);

      expect(await storage.forget("library:7")).toBe(true);

      expect(storage.isResolved("library:7")).toBe(false);
      expect(() => storage.disk("library:7")).toThrow(/not registered/);
    });

    it("re-extending a disk replaces the driver, so an edited host takes effect", () => {
      const app = application({ local: { root: "/tmp/mahi-local" } });
      const storage = app.make<StorageManager>(STORAGE_TOKEN);

      storage.extend("library:7", () => new SftpStorageDriver(sftpConfig({ host: "old.invalid" })));
      const before = storage.disk("library:7");

      storage.extend("library:7", () => new SftpStorageDriver(sftpConfig({ host: "new.invalid" })));
      const after = storage.disk("library:7");

      expect(after).not.toBe(before);
    });
  });
});

describe("isSftpDiskConfig()", () => {
  it("accepts an sftp disk with a host and username", () => {
    expect(isSftpDiskConfig({ driver: "sftp", host: "nas.local", username: "mahi" })).toBe(true);
  });

  it("rejects a local disk, other drivers, and incomplete sftp configs", () => {
    expect(isSftpDiskConfig({ root: "/srv/files" })).toBe(false);
    expect(isSftpDiskConfig({ driver: "local", root: "/srv/files" })).toBe(false);
    expect(isSftpDiskConfig({ driver: "s3", bucket: "media" })).toBe(false);
    expect(isSftpDiskConfig({ driver: "sftp", username: "mahi" })).toBe(false);
    expect(isSftpDiskConfig({ driver: "sftp", host: "nas.local" })).toBe(false);
    expect(isSftpDiskConfig(null)).toBe(false);
    expect(isSftpDiskConfig("sftp")).toBe(false);
  });
});
