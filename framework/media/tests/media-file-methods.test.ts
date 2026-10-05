import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempFile } from "@mahiframework/core";
import { MediaChecksumMismatchError } from "../src/errors.js";
import { MediaFile } from "../src/models/media-file.model.js";
import { checksum } from "../src/support/checksum.js";
import * as bytes from "./__fixtures__/bytes.js";
import { captureError, createHarness, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("urls", () => {
  it("returns a public url for a disk with a prefix", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png", disk: "public" });

    expect(media.url()).toBe(`/storage/${media.path}`);
    expect(media.isPublic()).toBe(true);
  });

  it("throws for a private disk, with storage's own message", async () => {
    // Not this package's embellishment: `url()` on a disk with no `url`
    // prefix is storage's contract, and its message names the fix.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.isPublic()).toBe(false);
    expect(() => media.url()).toThrow(/private disk/);
  });

  it("rejects a temporary url when the disk cannot sign one", async () => {
    // Honest rather than convenient. A local disk needs
    // `temporaryUrls: true`, and inventing a link that would 404 is
    // worse than failing here.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await expect(media.temporaryUrl()).rejects.toThrow();
  });
});

describe("reading", () => {
  it("returns the contents", async () => {
    const media = await harness.media.add(bytes.PDF, { filename: "a.pdf" });

    expect(await media.contents()).toEqual(bytes.PDF);
  });

  it("streams a byte range", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    const stream = await media.readStream({ start: 0, end: 3 });
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks)).toEqual(bytes.PNG.subarray(0, 4));
  });

  it("copies to a local temp file", async () => {
    // For tools that cannot read a remote disk: you cannot hand an S3
    // key to ffmpeg.
    const media = await harness.media.add(bytes.JPEG, { filename: "a.jpg" });
    const temp = await media.toTempFile();

    try {
      const { readFile } = await import("node:fs/promises");

      expect(await readFile(temp.path)).toEqual(bytes.JPEG);
      expect(temp.path.endsWith(".jpg")).toBe(true);
    } finally {
      await temp.delete();
    }
  });

  it("leaves no temp file behind when the copy is scoped", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    const before = TempFile.liveCount();

    {
      await using temp = await media.toTempFile();
      expect(temp.path).toBeTruthy();
    }

    expect(TempFile.liveCount()).toBe(before);
  });
});

describe("isImage", () => {
  it("is true for a raster image", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.isImage()).toBe(true);
  });

  it("is false for a document", async () => {
    const media = await harness.media.add(bytes.PDF, { filename: "a.pdf" });

    expect(media.isImage()).toBe(false);
  });

  it("is false for an SVG", async () => {
    const media = await harness.media.add(bytes.SVG, { filename: "logo.svg" });

    expect(media.mime_type).toBe("image/svg+xml");
    expect(media.isImage()).toBe(false);
  });

  it("follows the sniffed type, not the extension", async () => {
    const media = await harness.media.add(bytes.PDF, { filename: "pretend.png" });

    expect(media.isImage()).toBe(false);
  });
});

describe("verify", () => {
  it("passes for an untouched file", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await expect(media.verify()).resolves.toBeUndefined();
  });

  it("throws when the file changed underneath us", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await harness.disk.put(media.path, Buffer.from("replaced out of band"));

    const error = await captureError(media.verify());

    expect(error).toBeInstanceOf(MediaChecksumMismatchError);
  });

  it("self-heals the algorithm once the file is proven intact", async () => {
    // A row hashed under an older algorithm than the one now configured
    // is rehashed on a successful verify, which makes changing
    // `hashing.algorithm` a background migration rather than a flag day.
    const legacy = await createHarness({ hashing: { algorithm: "md5" } });
    const media = await legacy.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.checksum_algo).toBe("md5");

    // The app now configures sha256; the row still says md5.
    legacy.media.config.hashAlgorithm = "sha256";

    await media.verify();

    expect(media.checksum_algo).toBe("sha256");
    expect(media.checksum_hash).toBe(checksum(bytes.PNG, "sha256"));

    // And it persisted, so the next verify is cheap.
    const reloaded = await MediaFile.findOrFail(media.id);

    expect(reloaded.checksum_algo).toBe("sha256");

    await legacy.cleanup();
  });

  it("does not rewrite the hash when the algorithm already matches", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });
    const original = media.updated_at;

    await media.verify();

    expect((await MediaFile.findOrFail(media.id)).updated_at.toISOString()).toBe(
      original.toISOString(),
    );
  });
});

describe("custom properties", () => {
  it("sets, reads and forgets", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await media.setCustomProperty("alt", "A cat").setCustomProperty("credit", "Ada").save();

    const reloaded = await MediaFile.findOrFail(media.id);

    expect(reloaded.getCustomProperty("alt")).toBe("A cat");
    expect(reloaded.hasCustomProperty("credit")).toBe(true);

    await reloaded.forgetCustomProperty("credit").save();

    const again = await MediaFile.findOrFail(media.id);

    expect(again.hasCustomProperty("credit")).toBe(false);
    expect(again.getCustomProperty("alt")).toBe("A cat");
  });

  it("merges rather than replacing", async () => {
    const media = await harness.media.add(bytes.PNG, {
      filename: "a.png",
      customProperties: { alt: "first" },
    });

    await media.setCustomProperty("credit", "Ada").save();

    expect((await MediaFile.findOrFail(media.id)).custom_properties).toEqual({
      alt: "first",
      credit: "Ada",
    });
  });

  it("does not save on its own", async () => {
    // Unsaved so several can be set and written once.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    media.setCustomProperty("alt", "unsaved");

    expect((await MediaFile.findOrFail(media.id)).hasCustomProperty("alt")).toBe(false);
  });

  it("reports a property whose value is null as present", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    await media.setCustomProperty("alt", null).save();

    const reloaded = await MediaFile.findOrFail(media.id);

    expect(reloaded.hasCustomProperty("alt")).toBe(true);
    expect(reloaded.getCustomProperty("alt")).toBeNull();
  });

  it("forgetting from an empty bag is a no-op", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(() => media.forgetCustomProperty("nothing")).not.toThrow();
  });
});
