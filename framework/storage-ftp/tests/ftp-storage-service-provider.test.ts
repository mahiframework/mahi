import { describe, expect, it } from "vitest";
import { Application, STORAGE_TOKEN } from "@mahiframework/core";
import {
  LocalStorageDriver,
  StorageManager,
  StorageServiceProvider,
  type StorageConfig,
} from "@mahiframework/storage";
import { FtpStorageDriver } from "../src/ftp-storage-driver.js";
import { FtpStorageServiceProvider } from "../src/ftp-storage-service-provider.js";
import { isFtpDiskConfig } from "../src/ftp-disk-config.js";
import { isConnectionError, isMissing } from "../src/ftp-connection.js";

/**
 * No server needed: registering a disk logs in nowhere, which is itself the
 * property being asserted. An appliance that is offline at boot must not be
 * a boot failure.
 */
function application(disks: StorageConfig["disks"], defaultDisk = "local"): Application {
  const app = new Application();
  app.config.set("storage", { default: defaultDisk, disks });

  const storage = new StorageServiceProvider(app);
  storage.register();

  const ftp = new FtpStorageServiceProvider(app);
  ftp.register();

  return app;
}

describe("FtpStorageServiceProvider", () => {
  const remote = { driver: "ftp" as const, host: "nas.invalid", user: "mahi", root: "files" };

  it("registers an FtpStorageDriver for every ftp disk, leaving local disks to StorageServiceProvider", () => {
    const app = application({
      local: { root: "/tmp/mahi-local" },
      archive: remote,
    });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.disk("local")).toBeInstanceOf(LocalStorageDriver);
    expect(storage.disk("archive")).toBeInstanceOf(FtpStorageDriver);
  });

  /**
   * Registration must not connect. Resolving the driver constructs it and
   * nothing more; the control connection opens on the first operation, so an
   * unreachable host costs nothing until something reads from it.
   */
  it("opens no connection when a disk is merely registered or resolved", () => {
    const app = application({ archive: remote });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    const driver = storage.disk("archive") as FtpStorageDriver;

    expect(driver.ftp().connected()).toBe(false);
  });

  it("passes a configured url prefix through to the driver", () => {
    const app = application({
      archive: { ...remote, url: "https://files.example.com/public" },
    });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.url("report.pdf", "archive")).toBe(
      "https://files.example.com/public/report.pdf",
    );
  });

  it("an ftp disk without a url prefix throws from url()", () => {
    const app = application({ archive: remote });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(() => storage.url("report.pdf", "archive")).toThrow(/no public URL/);
  });

  it("path() throws without ever connecting", () => {
    const app = application({ archive: remote });
    const storage = app.make<StorageManager>(STORAGE_TOKEN);
    const driver = storage.disk("archive") as FtpStorageDriver;

    expect(() => driver.path("report.pdf")).toThrow(/another machine/);
    expect(driver.ftp().connected()).toBe(false);
  });

  it("shutdown() resolves nothing when storage was never used", async () => {
    const app = new Application();
    app.config.set("storage", { default: "local", disks: { archive: remote } });
    const provider = new FtpStorageServiceProvider(app);

    await provider.shutdown();

    expect(app.isResolved(STORAGE_TOKEN)).toBe(false);
  });

  /**
   * The documented pattern for hosts that live in the database rather than
   * in config: a disk per row, built on demand with `extend()`, re-extended
   * when the row is edited, and dropped with `forget()`, which disconnects
   * it rather than leaking the session.
   */
  describe("disks built at runtime from database rows", () => {
    it("extend() adds a disk after boot and forget() drops and disconnects it", async () => {
      const app = application({ local: { root: "/tmp/mahi-local" } });
      const storage = app.make<StorageManager>(STORAGE_TOKEN);

      storage.extend("share:3", () => new FtpStorageDriver({ host: "nas.invalid", user: "mahi" }));

      expect(storage.disk("share:3")).toBeInstanceOf(FtpStorageDriver);
      expect(storage.isResolved("share:3")).toBe(true);

      expect(await storage.forget("share:3")).toBe(true);

      expect(storage.isResolved("share:3")).toBe(false);
      expect(() => storage.disk("share:3")).toThrow(/not registered/);
    });

    it("re-extending a disk replaces the driver, so an edited host takes effect", () => {
      const app = application({ local: { root: "/tmp/mahi-local" } });
      const storage = app.make<StorageManager>(STORAGE_TOKEN);

      storage.extend("share:3", () => new FtpStorageDriver({ host: "old.invalid", user: "a" }));
      const before = storage.disk("share:3");

      storage.extend("share:3", () => new FtpStorageDriver({ host: "new.invalid", user: "a" }));

      expect(storage.disk("share:3")).not.toBe(before);
    });
  });
});

describe("isFtpDiskConfig()", () => {
  it("accepts an ftp disk with a host and user", () => {
    expect(isFtpDiskConfig({ driver: "ftp", host: "nas.local", user: "mahi" })).toBe(true);
  });

  it("rejects a local disk, other drivers, and incomplete ftp configs", () => {
    expect(isFtpDiskConfig({ root: "/srv/files" })).toBe(false);
    expect(isFtpDiskConfig({ driver: "local", root: "/srv/files" })).toBe(false);
    expect(isFtpDiskConfig({ driver: "s3", bucket: "media" })).toBe(false);
    // `sftp` is a different protocol entirely, and uses `username` rather
    // than `user`, so neither guard can claim the other's disk.
    expect(isFtpDiskConfig({ driver: "sftp", host: "nas.local", username: "mahi" })).toBe(false);
    expect(isFtpDiskConfig({ driver: "ftp", host: "nas.local" })).toBe(false);
    expect(isFtpDiskConfig({ driver: "ftp", user: "mahi" })).toBe(false);
    expect(isFtpDiskConfig(null)).toBe(false);
    expect(isFtpDiskConfig("ftp")).toBe(false);
  });
});

describe("isMissing()", () => {
  it("recognises the codes FTP uses for a refused file operation", () => {
    expect(isMissing({ code: 550 })).toBe(true);
    expect(isMissing({ code: "550" })).toBe(true);
    // 553 is what `STOR` answers when the parent directory doesn't exist.
    expect(isMissing({ code: 553 })).toBe(true);
    expect(isMissing(new Error("550 No such file or directory"))).toBe(true);
  });

  it("does not swallow other failures", () => {
    expect(isMissing({ code: 421 })).toBe(false);
    expect(isMissing(new Error("ECONNRESET"))).toBe(false);
    expect(isMissing(undefined)).toBe(false);
  });
});

/**
 * The retry is only safe when the request never reached the server. An
 * aborted upload also leaves `basic-ftp`'s client closed, but it carries the
 * *caller's* error and the transfer was already in flight — retrying it
 * would re-run work the caller cancelled.
 */
describe("isConnectionError()", () => {
  it("recognises transport failures", () => {
    expect(isConnectionError({ code: "ECONNRESET" })).toBe(true);
    expect(isConnectionError({ code: "EPIPE" })).toBe(true);
    expect(isConnectionError({ code: 421 })).toBe(true);
    expect(isConnectionError(new Error("Client is closed"))).toBe(true);
    expect(isConnectionError(new Error("Timeout exceeded"))).toBe(true);
  });

  it("does not retry a transfer the caller aborted", () => {
    expect(isConnectionError(new Error("boom"))).toBe(false);
    expect(isConnectionError(new Error("Client is closed because boom"))).toBe(false);
  });

  it("does not retry a server-level refusal", () => {
    expect(isConnectionError({ code: 550 })).toBe(false);
    expect(isConnectionError({ code: 553 })).toBe(false);
  });
});
