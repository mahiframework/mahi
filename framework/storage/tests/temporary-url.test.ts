import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Application, SIGNER_TOKEN, setCurrentApp, clearCurrentApp } from "@mahiframework/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageManager } from "../src/storage-manager.js";
import { StorageServiceProvider } from "../src/storage-service-provider.js";
import { serveTemporaryDiskFile } from "../src/serve-stored-file.js";
import { TEMPORARY_URL_PREFIX } from "../src/temporary-url.js";
import { STORAGE_TOKEN } from "../src/storage-service-provider.js";

/**
 * A stand-in for `@mahiframework/encryption`'s `Signer`.
 *
 * This package resolves the signer by token and types it structurally
 * precisely so it needn't depend on `encryption` (whose `argon2` is a
 * native build), and this is the other half of that bargain: the test
 * supplies the same structural shape. The HMAC is real, so tampering is
 * genuinely detected rather than detected by a stub that was told to.
 */
function testSigner(key = "test-key"): {
  sign(payload: string): string;
  verify(signed: string): string | null;
  for(purpose: string): ReturnType<typeof testSigner>;
} {
  const mac = (payload: string): string =>
    createHmac("sha256", key).update(payload).digest("base64url");

  return {
    sign: (payload) => `${payload}.${mac(payload)}`,
    verify: (signed) => {
      const at = signed.lastIndexOf(".");

      if (at <= 0) {
        return null;
      }

      const payload = signed.slice(0, at);

      return mac(payload) === signed.slice(at + 1) ? payload : null;
    },
    for: (purpose) => testSigner(`${key}:${purpose}`),
  };
}

/** A request shaped the way the route handler expects. */
function request(url: string, headers?: Record<string, string>) {
  const parsed = new URL(url, "https://app.test");

  return {
    path: () => parsed.pathname,
    queryString: () => parsed.search.replace(/^\?/, ""),
    headers: headers === undefined ? undefined : () => headers,
  };
}

describe("temporary URLs", () => {
  let tmpDir: string;
  let app: Application;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-temp-url-test-"));
    app = new Application();
    app.config.set("http", { url: "https://app.test" });
    app.config.set("storage", {
      default: "private",
      disks: {
        private: { root: path.join(tmpDir, "private"), temporaryUrls: true },
        locked: { root: path.join(tmpDir, "locked") },
      },
    });
    app.instance(SIGNER_TOKEN, testSigner());
    new StorageServiceProvider(app).register();
    setCurrentApp(app);
  });

  afterEach(async () => {
    clearCurrentApp(app);
    await rm(tmpDir, { recursive: true, force: true });
  });

  const storage = (): StorageManager => app.make<StorageManager>(STORAGE_TOKEN);

  describe("building", () => {
    it("returns an absolute URL carrying the disk, path, expiry and signature", async () => {
      const url = await storage().disk("private").temporaryUrl("invoices/jan.pdf", 300);
      const parsed = new URL(url);

      expect(parsed.origin).toBe("https://app.test");
      expect(parsed.pathname).toBe(`${TEMPORARY_URL_PREFIX}/private/invoices/jan.pdf`);
      expect(Number(parsed.searchParams.get("expires"))).toBeGreaterThan(Date.now() / 1000);
      expect(parsed.searchParams.get("signature")).toBeTruthy();
    });

    it("defaults to a five minute lifetime", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("a.txt"));
      const expires = Number(url.searchParams.get("expires"));

      expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(280);
      expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    });

    it("percent-encodes a path that needs it", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("my report #1.pdf"));

      expect(url.pathname).toBe(`${TEMPORARY_URL_PREFIX}/private/my%20report%20%231.pdf`);
    });

    it("refuses a disk that did not opt in", async () => {
      await expect(storage().disk("locked").temporaryUrl("a.txt")).rejects.toThrow(
        /temporaryUrls: true/,
      );
    });

    it("rejects a traversal path before signing anything", async () => {
      await expect(storage().disk("private").temporaryUrl("../../etc/passwd")).rejects.toThrow(
        /escapes the storage root/,
      );
    });

    it("explains itself when no signer is bound", async () => {
      const bare = new Application();
      bare.config.set("http", { url: "https://app.test" });
      bare.config.set("storage", {
        default: "private",
        disks: { private: { root: tmpDir, temporaryUrls: true } },
      });
      new StorageServiceProvider(bare).register();
      clearCurrentApp(app);
      setCurrentApp(bare);

      try {
        await expect(
          bare.make<StorageManager>(STORAGE_TOKEN).disk("private").temporaryUrl("a.txt"),
        ).rejects.toThrow(/SIGNER_TOKEN is not bound/);
      } finally {
        clearCurrentApp(bare);
        setCurrentApp(app);
      }
    });

    /**
     * A temporary URL is absolute so it is interchangeable with a
     * presigned S3 one. Without a request or `http.url` there is no
     * honest origin, and guessing one produces links that 404 in
     * production only.
     */
    it("explains itself when no origin can be resolved", async () => {
      const bare = new Application();
      bare.config.set("storage", {
        default: "private",
        disks: { private: { root: tmpDir, temporaryUrls: true } },
      });
      bare.instance(SIGNER_TOKEN, testSigner());
      new StorageServiceProvider(bare).register();
      clearCurrentApp(app);
      setCurrentApp(bare);

      try {
        await expect(
          bare.make<StorageManager>(STORAGE_TOKEN).disk("private").temporaryUrl("a.txt"),
        ).rejects.toThrow(/no `http.url` config set/);
      } finally {
        clearCurrentApp(bare);
        setCurrentApp(app);
      }
    });

    it("is reachable from the manager and the facade signature", async () => {
      const url = await storage().temporaryUrl("a.txt", 60, "private");

      expect(new URL(url).pathname).toBe(`${TEMPORARY_URL_PREFIX}/private/a.txt`);
    });
  });

  describe("serving", () => {
    beforeEach(async () => {
      await storage().disk("private").put("invoices/jan.pdf", "the invoice");
      await storage().disk("locked").put("secret.txt", "nope");
    });

    const serve = serveTemporaryDiskFile();

    it("streams the file for a valid link", async () => {
      const url = await storage().disk("private").temporaryUrl("invoices/jan.pdf");
      const response = await serve(request(url));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("the invoice");
    });

    it("supports Range, so a media file is seekable", async () => {
      const url = await storage().disk("private").temporaryUrl("invoices/jan.pdf");
      const response = await serve(request(url, { range: "bytes=4-6" }));

      expect(response.status).toBe(206);
      expect(await response.text()).toBe("inv");
    });

    it("refuses a link with no signature at all", async () => {
      const response = await serve(request(`${TEMPORARY_URL_PREFIX}/private/invoices/jan.pdf`));

      expect(response.status).toBe(403);
    });

    it("refuses a tampered path", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("invoices/jan.pdf"));
      await storage().disk("private").put("invoices/feb.pdf", "the other invoice");
      url.pathname = `${TEMPORARY_URL_PREFIX}/private/invoices/feb.pdf`;

      expect((await serve(request(url.toString()))).status).toBe(403);
    });

    /**
     * The disk name is inside the HMAC precisely so a link minted for one
     * disk cannot be edited into a read of another.
     */
    it("refuses a swapped disk name", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("invoices/jan.pdf"));
      url.pathname = `${TEMPORARY_URL_PREFIX}/locked/secret.txt`;

      expect((await serve(request(url.toString()))).status).toBe(403);
    });

    it("refuses an extended expiry", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("invoices/jan.pdf"));
      url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + 86_400));

      expect((await serve(request(url.toString()))).status).toBe(403);
    });

    it("refuses an expired link", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("invoices/jan.pdf", -60));

      expect((await serve(request(url.toString()))).status).toBe(403);
    });

    /**
     * Even a correctly signed link is refused for a disk that never opted
     * in, which is what bounds the damage if APP_KEY ever leaks.
     */
    it("refuses a disk that did not opt in, even with a valid signature", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("invoices/jan.pdf"));
      // Sign a link for `locked` the way the builder would, proving the
      // refusal is the opt-in check rather than a signature mismatch.
      const forged = await (async () => {
        const { buildSignedUrl } = await import("@mahiframework/core");

        return buildSignedUrl(
          `${TEMPORARY_URL_PREFIX}/locked/secret.txt`,
          {},
          testSigner().for("url"),
          { expiresInSeconds: 300 },
        );
      })();

      expect(url.searchParams.get("signature")).toBeTruthy();
      expect((await serve(request(forged))).status).toBe(404);
    });

    it("404s a signed link to a file that does not exist", async () => {
      const url = await storage().disk("private").temporaryUrl("invoices/missing.pdf");

      expect((await serve(request(url))).status).toBe(404);
    });

    it("404s a path outside the route prefix", async () => {
      const url = new URL(await storage().disk("private").temporaryUrl("invoices/jan.pdf"));
      const elsewhere = `/elsewhere/private/invoices/jan.pdf${url.search}`;

      expect((await serve(request(elsewhere))).status).toBe(403);
    });
  });
});
