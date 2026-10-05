import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoImageDriverError, UnsupportedImageOpError } from "../src/errors.js";
import { FakeImageDriver } from "../src/image/fake-image-driver.js";
import {
  cropToSquare,
  format,
  quality,
  resizeDown,
  rotate,
  setBackgroundColor,
  targetMimeType,
} from "../src/modifiers/index.js";
import { runModifiers } from "../src/pipeline/run-modifiers.js";
import { modifier } from "../src/pipeline/modifier.js";
import * as bytes from "./__fixtures__/bytes.js";
import { captureError, createHarness, type Harness } from "./__fixtures__/test-app.js";

/** Run a chain against a fresh fake driver, outside the upload path. */
async function run(
  modifiers: Parameters<typeof runModifiers>[4],
  driver = new FakeImageDriver(1000, 800),
  mimeType = "image/png",
) {
  const result = await runModifiers(driver, "fake", bytes.PNG, mimeType, modifiers);

  return { result, driver };
}

describe("resizeDown", () => {
  it("emits a scaleDown op with both bounds", async () => {
    const { driver } = await run([resizeDown(500, 400)]);

    expect(driver.opsOfType("scaleDown")).toEqual([{ type: "scaleDown", width: 500, height: 400 }]);
  });

  it("preserves aspect ratio", async () => {
    const { result } = await run([resizeDown(500)]);

    // 1000x800 bounded to 500 wide.
    expect(result.width).toBe(500);
    expect(result.height).toBe(400);
  });

  it("never enlarges", async () => {
    // The property that separates it from a plain resize: upscaling
    // invents detail and makes every small logo worse.
    const { result } = await run([resizeDown(4000, 4000)], new FakeImageDriver(200, 200));

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
  });

  it("bounds by one dimension when given one", async () => {
    const { result } = await run([resizeDown(undefined, 400)]);

    expect(result.height).toBe(400);
    expect(result.width).toBe(500);
  });
});

describe("cropToSquare", () => {
  it("centres the crop", async () => {
    // Deliberately unlike laravel-media, whose `CropToSquare` anchors
    // bottom-right (`x = width - size`) — so a portrait photo cropped
    // for an avatar keeps the chest and loses the face.
    const { driver } = await run([cropToSquare()], new FakeImageDriver(1000, 600));

    expect(driver.opsOfType("crop")).toEqual([
      { type: "crop", width: 600, height: 600, x: 200, y: 0 },
    ]);
  });

  it("crops a portrait image on the vertical axis", async () => {
    const { driver } = await run([cropToSquare()], new FakeImageDriver(600, 1000));

    expect(driver.opsOfType("crop")).toEqual([
      { type: "crop", width: 600, height: 600, x: 0, y: 200 },
    ]);
  });

  it("does nothing to an already square image", async () => {
    const { driver } = await run([cropToSquare()], new FakeImageDriver(500, 500));

    driver.assertNotApplied("crop");
  });
});

describe("format", () => {
  it("changes the encoded format without touching pixels", async () => {
    const { result, driver } = await run([format("webp")]);

    expect(result.extension).toBe("webp");
    expect(result.mimeType).toBe("image/webp");
    expect(driver.applied).toEqual([]);
  });

  it("accepts a mime type as well as an extension", async () => {
    const { result } = await run([format("image/jpeg")]);

    expect(result.extension).toBe("jpg");
  });

  it("takes effect wherever it sits in the chain", async () => {
    // It sets encode options rather than transforming, so order against
    // the pixel modifiers is irrelevant — worth proving, because a
    // reader could reasonably assume otherwise.
    const first = await run([format("webp"), resizeDown(100)]);
    const last = await run([resizeDown(100), format("webp")]);

    expect(first.result.extension).toBe("webp");
    expect(last.result.extension).toBe("webp");
  });

  it("keeps the input format when no format modifier is present", async () => {
    const { result } = await run([resizeDown(100)], new FakeImageDriver(), "image/jpeg");

    expect(result.extension).toBe("jpg");
    expect(result.mimeType).toBe("image/jpeg");
  });
});

describe("quality", () => {
  it("passes through to the encoder", async () => {
    const { driver } = await run([quality(70)]);

    expect(driver.encoded).toEqual([{ format: "png", quality: 70 }]);
  });

  it("clamps out-of-range values rather than failing the upload", async () => {
    expect((await run([quality(0)])).driver.encoded[0]?.quality).toBe(1);
    expect((await run([quality(500)])).driver.encoded[0]?.quality).toBe(100);
  });

  it("leaves quality unset when no modifier asks for one", async () => {
    // So the driver picks its own per-format default: 82 is a good JPEG
    // and a wasteful WebP.
    const { driver } = await run([resizeDown(100)]);

    expect(driver.encoded[0]?.quality).toBeUndefined();
  });
});

describe("setBackgroundColor", () => {
  it("fills a canvas and composites the original over it", async () => {
    // The only way to flatten transparency with the generic ops, and
    // the reason `create()` is on the driver contract at all.
    const { driver } = await run([setBackgroundColor("#ffffff")]);

    driver.assertSequence(["fill", "place"]);
    expect(driver.opsOfType("fill")).toEqual([{ type: "fill", color: "#ffffff" }]);
  });

  it("does not change the dimensions", async () => {
    const { result } = await run([setBackgroundColor("#000000")], new FakeImageDriver(640, 480));

    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });
});

describe("rotate", () => {
  it("swaps dimensions on a quarter turn", async () => {
    const { result } = await run([rotate(90)], new FakeImageDriver(1000, 500));

    expect(result.width).toBe(500);
    expect(result.height).toBe(1000);
  });
});

describe("the chain", () => {
  it("runs modifiers in declared order", async () => {
    const { driver } = await run([cropToSquare(), resizeDown(200), rotate(90)]);

    driver.assertSequence(["crop", "scaleDown", "rotate"]);
  });

  it("supports a modifier that acts after the rest of the chain", async () => {
    // The middleware shape laravel-media's optimizers rely on: run the
    // chain first, then act on the result.
    const order: string[] = [];

    const after = modifier("after", async (context, next) => {
      const result = await next(context);

      order.push("after");

      return result;
    });

    const before = modifier("before", async (context, next) => {
      order.push("before");

      return next(context);
    });

    await run([after, before]);

    expect(order).toEqual(["before", "after"]);
  });

  it("applies the cumulative geometry of a whole chain", async () => {
    const { result } = await run(
      [cropToSquare(), resizeDown(200, 200), format("webp"), quality(80)],
      new FakeImageDriver(1000, 600),
    );

    // Cropped to 600x600, then bounded to 200x200.
    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
    expect(result.extension).toBe("webp");
  });

  it("throws when the driver cannot do an op, rather than skipping it", async () => {
    // laravel-media's pipeline silently drops modifiers it does not
    // recognise, producing an unmodified image and no indication why.
    const driver = new FakeImageDriver().without("crop");
    const error = await captureError(run([cropToSquare()], driver));

    expect(error).toBeInstanceOf(UnsupportedImageOpError);
    expect((error as UnsupportedImageOpError).driver).toBe("fake");
    expect((error as UnsupportedImageOpError).op).toBe("crop");
  });
});

describe("targetMimeType", () => {
  it("reports the format a chain will produce", async () => {
    // Read BEFORE the chain runs, so the storage path carries the right
    // extension and no file has to be moved afterwards.
    expect(targetMimeType([resizeDown(100), format("webp")], "image/png")).toBe("image/webp");
  });

  it("falls back when no modifier forces a format", () => {
    expect(targetMimeType([resizeDown(100)], "image/png")).toBe("image/png");
  });

  it("takes the last format when several are declared", () => {
    expect(targetMimeType([format("webp"), format("jpg")], "image/png")).toBe("image/jpeg");
  });
});

describe("through the upload path", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ image: { default: "fake" } });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("stores the transformed bytes, not the original", async () => {
    const media = await harness.media.add(bytes.PNG, {
      filename: "a.png",
      modifiers: [resizeDown(100)],
    });

    const stored = await harness.disk.get(media.path);

    expect(stored).not.toEqual(bytes.PNG);
    expect(media.size).toBe(stored.byteLength);
  });

  it("records the dimensions the modifiers produced", async () => {
    const media = await harness.media.add(bytes.PNG, {
      filename: "a.png",
      modifiers: [resizeDown(500)],
    });

    expect(media.image_width).toBe(500);
    expect(media.image_height).toBe(400);
  });

  it("writes a format change to a path with the right extension", async () => {
    // The laravel-media bug this package does not have: its
    // `updateOriginal()` writes the new bytes to the OLD path, leaving a
    // `.png` file whose row claims webp. Only the columns change there.
    const media = await harness.media.add(bytes.PNG, {
      filename: "a.png",
      modifiers: [format("webp")],
    });

    expect(media.extension).toBe("webp");
    expect(media.mime_type).toBe("image/webp");
    expect(media.path.endsWith(".webp")).toBe(true);
    await harness.disk.assertExists(media.path);
  });

  it("checksums the transformed bytes", async () => {
    const media = await harness.media.add(bytes.PNG, {
      filename: "a.png",
      modifiers: [resizeDown(100)],
    });

    // Verifies against what is actually on the disk.
    await expect(media.verify()).resolves.toBeUndefined();
  });

  it("never runs modifiers on a non-image", async () => {
    // The package is multipurpose: a PDF with a modifier chain attached
    // is stored unchanged rather than failing in an image decoder.
    const media = await harness.media.add(bytes.PDF, {
      filename: "a.pdf",
      modifiers: [resizeDown(100), format("webp")],
    });

    expect(media.mime_type).toBe("application/pdf");
    expect(media.extension).toBe("pdf");
    expect(harness.imageDriver.applied).toEqual([]);
    expect(await harness.disk.get(media.path)).toEqual(bytes.PDF);
  });

  it("never runs modifiers on an SVG", async () => {
    // An image to a browser, a text document to a decoder.
    const media = await harness.media.add(bytes.SVG, {
      filename: "logo.svg",
      modifiers: [resizeDown(100)],
    });

    expect(media.mime_type).toBe("image/svg+xml");
    expect(harness.imageDriver.applied).toEqual([]);
  });

  it("leaves dimensions null for a non-image", async () => {
    const media = await harness.media.add(bytes.PDF, { filename: "a.pdf" });

    expect(media.image_width).toBeNull();
    expect(media.image_height).toBeNull();
  });
});

describe("without an image driver", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("stores images fine as long as nothing transforms them", async () => {
    // The whole reason the driver is a separate package: an app that
    // stores images without resizing them needs no image library.
    const media = await harness.media.add(bytes.PNG, { filename: "a.png" });

    expect(media.mime_type).toBe("image/png");
  });

  it("stores documents fine", async () => {
    const media = await harness.media.add(bytes.PDF, { filename: "a.pdf" });

    expect(media.mime_type).toBe("application/pdf");
  });

  it("fails with an actionable error when a modifier needs one", async () => {
    const error = await captureError(
      harness.media.add(bytes.PNG, { filename: "a.png", modifiers: [resizeDown(100)] }),
    );

    expect(error).toBeInstanceOf(NoImageDriverError);
    // The message has to name the install step: this is the expected
    // state for an app adding its first thumbnail.
    expect((error as Error).message).toContain("media-sharp");
    expect((error as Error).message).toContain("config/media.ts");
  });

  it("reports that it is not configured", () => {
    expect(harness.images.configured()).toBe(false);
    expect(harness.images.defaultName()).toBeNull();
  });
});
