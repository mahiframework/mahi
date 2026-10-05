import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempFile } from "@mahiframework/core";
import { MediaTooLargeError, UnacceptableMediaTypeError } from "../src/errors.js";
import { resolveAccept } from "../src/media-config.js";
import { MediaFile } from "../src/models/media-file.model.js";
import { checksum } from "../src/support/checksum.js";
import * as bytes from "./__fixtures__/bytes.js";
import { captureError, createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("add", () => {
  it("writes the file and records the row", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "avatar.png" });

    await harness.disk.assertExists(media.path);
    expect(await harness.disk.get(media.path)).toEqual(bytes.PNG);
    expect(media.size).toBe(bytes.PNG.byteLength);
    expect(media.mime_type).toBe("image/png");
    expect(media.extension).toBe("png");
    expect(media.original_filename).toBe("avatar.png");
  });

  it("records a checksum of the stored bytes", async () => {
    const media = await harness.media.add(bytes.PDF, { filename: "invoice.pdf" });

    expect(media.checksum_algo).toBe("sha256");
    expect(media.checksum_hash).toBe(checksum(bytes.PDF, "sha256"));
  });

  it("stamps the owner", async () => {
    const user = await makeUser();

    const media = await harness.media.add(bytes.PNG, {
      owner: { type: "User", id: user.id },
      collection: "photos",
      order: 3,
    });

    expect(media.model_type).toBe("User");
    expect(media.model_id).toBe(String(user.id));
    expect(media.collection).toBe("photos");
    expect(media.order).toBe(3);
  });

  it("leaves the owner null when there is none", async () => {
    const media = await harness.media.add(bytes.PNG);

    expect(media.model_type).toBeNull();
    expect(media.model_id).toBeNull();
  });

  it("stores custom properties", async () => {
    const media = await harness.media.add(bytes.PNG, {
      customProperties: { alt: "A cat on a sofa" },
    });

    expect((await MediaFile.findOrFail(media.id)).getCustomProperty("alt")).toBe("A cat on a sofa");
  });
});

describe("type identification", () => {
  it("trusts the bytes over the supplied name", async () => {
    // The security property this package rests on. A PNG uploaded as
    // `report.pdf` is stored as a PNG, so a later `isImage()` check and
    // any accept rule both see the truth.
    const media = await harness.media.add(bytes.PNG, { filename: "report.pdf" });

    expect(media.mime_type).toBe("image/png");
    expect(media.extension).toBe("png");
  });

  it("uses the extension for formats with no magic number", async () => {
    const media = await harness.media.add(bytes.CSV, { filename: "export.csv" });

    expect(media.mime_type).toBe("text/csv");
    expect(media.extension).toBe("csv");
  });

  it("stores an empty extension when nothing identifies the file", async () => {
    const media = await harness.media.add(bytes.PLAIN, { filename: "README" });

    expect(media.mime_type).toBe("application/octet-stream");
    expect(media.extension).toBe("");
    // The path then carries no extension either, which is legal.
    expect(media.path.endsWith(".")).toBe(false);
  });

  it("canonicalises the extension", async () => {
    // Uploaded as `.jpeg`, stored as `.jpg`, because the type resolves
    // through the MIME table rather than echoing the upload.
    const media = await harness.media.add(bytes.JPEG, { filename: "holiday.jpeg" });

    expect(media.extension).toBe("jpg");
    expect(media.original_filename).toBe("holiday.jpeg");
  });
});

describe("accept rules", () => {
  it("allows a file matching a mime glob", async () => {
    const media = await harness.media.add(bytes.PNG, {
      filename: "a.png",
      accept: resolveAccept({ mimes: ["image/*"] }),
    });

    expect(media.mime_type).toBe("image/png");
  });

  it("rejects a file matching neither list", async () => {
    const error = await captureError(
      harness.media.add(bytes.PDF, {
        filename: "a.pdf",
        accept: resolveAccept({ mimes: ["image/*"] }),
      }),
    );

    expect(error).toBeInstanceOf(UnacceptableMediaTypeError);
  });

  it("allows a file matching only the extension list", async () => {
    // OR semantics, matching laravel-media: either list satisfying is
    // enough.
    const media = await harness.media.add(bytes.PDF, {
      filename: "a.pdf",
      accept: resolveAccept({ mimes: ["image/*"], extensions: ["pdf"] }),
    });

    expect(media.extension).toBe("pdf");
  });

  it("judges the sniffed type, not the claimed one", async () => {
    // A PDF renamed `.png` against an image-only rule must still be
    // refused — the rename is exactly the attack.
    const error = await captureError(
      harness.media.add(bytes.PDF, {
        filename: "sneaky.png",
        accept: resolveAccept({ mimes: ["image/*"] }),
      }),
    );

    expect(error).toBeInstanceOf(UnacceptableMediaTypeError);
  });

  it("enforces maxBytes", async () => {
    const error = await captureError(
      harness.media.add(bytes.PNG, { accept: resolveAccept({ maxBytes: 8 }) }),
    );

    expect(error).toBeInstanceOf(MediaTooLargeError);
  });

  it("writes nothing when a file is rejected", async () => {
    // Validate-then-write is the contract: a refused upload must leave
    // neither a row nor bytes.
    await captureError(
      harness.media.add(bytes.PDF, { accept: resolveAccept({ mimes: ["image/*"] }) }),
    );

    expect(await harness.disk.allFiles()).toEqual([]);
    expect((await MediaFile.query().get()).all()).toHaveLength(0);
  });

  it("accepts anything when no rules are set", async () => {
    const media = await harness.media.add(bytes.SEVEN_ZIP, { filename: "backup.7z" });

    expect(media.mime_type).toBe("application/x-7z-compressed");
  });

  it("refuses an executable payload regardless of the accept rules", async () => {
    // Unconditional, not merely "excluded by the type lists". PHP
    // sniffs as nothing, so a MIME-only check would admit it on its
    // extension's word — and on a public disk that is remote code
    // execution.
    for (const payload of [bytes.PHP, bytes.PHP_SHORT_TAG, bytes.SHEBANG, bytes.PHP_OBFUSCATED]) {
      const error = await captureError(harness.media.add(payload, { filename: "avatar.png" }));

      expect(error).toBeInstanceOf(UnacceptableMediaTypeError);
    }

    expect(await harness.disk.allFiles()).toEqual([]);
  });
});

describe("paths", () => {
  it("generates a nested uuid path, never the upload's name", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "../../etc/passwd.png" });

    // Four directories then a filename, all hex.
    expect(media.path).toMatch(
      /^[0-9a-f]{8}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{12}\.png$/,
    );
    expect(media.path).not.toContain("passwd");
    expect(media.path).not.toContain("..");
  });

  it("honours the configured nesting depth", async () => {
    const flat = await createHarness({ pathNesting: 0 });
    const media = await flat.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.path).toMatch(/^[0-9a-f]{32}\.png$/);

    await flat.cleanup();
  });

  it("applies the configured prefix", async () => {
    const prefixed = await createHarness({ path: "uploads" });
    const media = await prefixed.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.path.startsWith("uploads/")).toBe(true);

    await prefixed.cleanup();
  });

  it("does not collide across many uploads", async () => {
    const all = await Promise.all(
      Array.from({ length: 25 }, () => harness.media.add(bytes.PNG, { filename: "a.png" })),
    );

    expect(new Set(all.map((media) => media.path)).size).toBe(25);
  });

  it("sanitises the download name", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "../../etc/passwd.png" });

    // The directory part is stripped; the name itself survives.
    expect(media.original_filename).toBe("passwd.png");
  });
});

describe("disks", () => {
  it("writes to the configured media disk", async () => {
    const configured = await createHarness({ disk: "public" });
    const media = await configured.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.disk).toBe("public");
    await configured.publicDisk.assertExists(media.path);
    await configured.disk.assertMissing(media.path);

    await configured.cleanup();
  });

  it("writes to an explicitly named disk", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png", disk: "public" });

    expect(media.disk).toBe("public");
    await harness.publicDisk.assertExists(media.path);
  });

  it("stores null for the storage default, so the row follows it later", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.disk).toBeNull();
    await harness.disk.assertExists(media.path);
  });
});

describe("sources", () => {
  it("accepts a Buffer", async () => {
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(await harness.disk.get(media.path)).toEqual(bytes.PNG);
  });

  it("accepts a web File, the shape request.file() returns", async () => {
    const file = new File([bytes.PNG], "upload.png", { type: "image/png" });
    const media = await harness.media.add(file);

    expect(media.original_filename).toBe("upload.png");
    expect(media.mime_type).toBe("image/png");
  });

  it("ignores the File's claimed type", async () => {
    // `new File(..., { type })` is the client's claim, which is exactly
    // what must not be believed.
    const file = new File([bytes.PDF], "lies.png", { type: "image/png" });
    const media = await harness.media.add(file);

    expect(media.mime_type).toBe("application/pdf");
    expect(media.extension).toBe("pdf");
  });

  it("accepts a local path", async () => {
    await using source = await TempFile.fromContents(bytes.JPEG, "jpg");
    const media = await harness.media.add(source.path);

    expect(media.mime_type).toBe("image/jpeg");
    expect(media.original_filename).toMatch(/\.jpg$/);
  });

  it("accepts a Node stream with a name", async () => {
    const media = await harness.media.add({
      stream: Readable.from([bytes.PNG]),
      filename: "streamed.png",
    });

    expect(media.original_filename).toBe("streamed.png");
    expect(media.mime_type).toBe("image/png");
  });

  it("accepts a web ReadableStream", async () => {
    const body = new Response(bytes.PDF).body;
    const media = await harness.media.add(body as ReadableStream<Uint8Array>, {
      filename: "fetched.pdf",
    });

    expect(media.mime_type).toBe("application/pdf");
  });

  it("streams a large source without buffering it", async () => {
    // Past the 8 MiB in-memory threshold, so this exercises the
    // temp-file path: sniffed from a prefix, hashed from a stream,
    // written with putStream().
    const large = Buffer.concat([bytes.PNG, Buffer.alloc(9 * 1024 * 1024, 0x61)]);
    const media = await harness.media.add({
      stream: Readable.from([large]),
      filename: "big.png",
    });

    expect(media.size).toBe(large.byteLength);
    expect(media.mime_type).toBe("image/png");
    expect(media.checksum_hash).toBe(checksum(large, "sha256"));
    expect((await stat(harness.disk.path(media.path))).size).toBe(large.byteLength);
  });

  it("leaves no temp file behind after streaming", async () => {
    const before = TempFile.liveCount();

    await harness.media.add({
      stream: Readable.from([Buffer.concat([bytes.PNG, Buffer.alloc(9 * 1024 * 1024)])]),
      filename: "big.png",
    });

    expect(TempFile.liveCount()).toBe(before);
  });

  it("leaves no temp file behind when a streamed upload is rejected", async () => {
    const before = TempFile.liveCount();

    await captureError(
      harness.media.add(
        { stream: Readable.from([Buffer.alloc(9 * 1024 * 1024)]), filename: "big.bin" },
        { accept: resolveAccept({ maxBytes: 10 }) },
      ),
    );

    expect(TempFile.liveCount()).toBe(before);
  });

  it("does not delete a caller-supplied local path", async () => {
    // Reading from a path must never consume it. laravel-media's
    // `deleteOriginal` defaults to TRUE, which destroys the source file
    // by default; that is a surprising default for a library to have.
    const source = await TempFile.fromContents(bytes.PNG, "png");

    try {
      await harness.media.add(source.path);

      expect(await readFile(source.path)).toEqual(bytes.PNG);
    } finally {
      await source.delete();
    }
  });
});
