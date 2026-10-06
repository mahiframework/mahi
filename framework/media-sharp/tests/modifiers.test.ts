import { describe, expect, it } from "vitest";
import {
  cropToSquare,
  format,
  quality,
  resizeDown,
  rotate,
  runModifiers,
  setBackgroundColor,
  type MediaModifier,
} from "@mahiframework/media";
import { SharpImageDriver } from "../src/sharp-image-driver.js";
import {
  gradientPng,
  jpeg,
  png,
  sizeOf,
  topLeftPixel,
  transparentPng,
} from "./__fixtures__/images.js";

/**
 * `media`'s own modifiers, driven end to end through this driver.
 *
 * The contract covers the driver's six methods in isolation; this covers
 * the thing an application actually writes — a chain — and it is where
 * the composition bugs live. `media`'s own suite runs these against
 * `FakeImageDriver`, which tracks geometry faithfully but decodes
 * nothing, so this is the half that proves libvips agrees.
 */
async function run(
  bytes: Uint8Array,
  modifiers: MediaModifier[],
  mimeType = "image/png",
  driver = new SharpImageDriver(),
) {
  return runModifiers(driver, "sharp", bytes, mimeType, modifiers);
}

describe("single modifiers", () => {
  it("resizeDown shrinks, preserving the ratio", async () => {
    const result = await run(await png(1000, 800), [resizeDown(500)]);

    expect([result.width, result.height]).toEqual([500, 400]);
    expect(await sizeOf(result.bytes)).toEqual({ width: 500, height: 400 });
  });

  it("resizeDown never enlarges", async () => {
    const result = await run(await png(200, 200), [resizeDown(2000, 2000)]);

    expect([result.width, result.height]).toEqual([200, 200]);
  });

  it("cropToSquare takes a centred square", async () => {
    const result = await run(await png(100, 60), [cropToSquare()]);

    expect([result.width, result.height]).toEqual([60, 60]);
  });

  it("cropToSquare leaves an already-square image alone", async () => {
    const result = await run(await png(80, 80), [cropToSquare()]);

    expect([result.width, result.height]).toEqual([80, 80]);
  });

  it("rotate turns the image and swaps its dimensions", async () => {
    const result = await run(await png(100, 60), [rotate(90)]);

    expect([result.width, result.height]).toEqual([60, 100]);
  });

  it("format changes the encoding and the reported type", async () => {
    const result = await run(await png(50, 50), [format("webp")]);

    expect(result.extension).toBe("webp");
    expect(result.mimeType).toBe("image/webp");
  });

  it("quality affects the output size without touching the geometry", async () => {
    const source = await gradientPng(200, 200);

    const low = await run(source, [format("jpg"), quality(20)]);
    const high = await run(source, [format("jpg"), quality(95)]);

    expect(low.bytes.byteLength).toBeLessThan(high.bytes.byteLength);
    expect([low.width, low.height]).toEqual([200, 200]);
  });
});

/**
 * THE CHAIN THAT WOULD BE SILENTLY WRONG against a lazy sharp pipeline.
 * See `sharp-image-driver.test.ts` for the mechanism; this is the same
 * trap approached through the public API, which is how an application
 * would hit it.
 */
describe("chains", () => {
  it("crops against the RESIZED dimensions, not the source's", async () => {
    // 100x60, scaled to 80 wide, is 80x48 — so the square is 48x48.
    // A driver measuring the source would cut 60x60 from an image only
    // 48 pixels tall.
    const result = await run(await png(100, 60), [resizeDown(80), cropToSquare()]);

    expect([result.width, result.height]).toEqual([48, 48]);
    expect(await sizeOf(result.bytes)).toEqual({ width: 48, height: 48 });
  });

  it("does not let a no-op resize undo a real one", async () => {
    const result = await run(await png(100, 60), [resizeDown(50), resizeDown(4000)]);

    expect([result.width, result.height]).toEqual([50, 30]);
  });

  it("runs a realistic avatar chain", async () => {
    const result = await run(await png(1200, 900), [
      cropToSquare(),
      resizeDown(512, 512),
      format("webp"),
      quality(82),
    ]);

    expect([result.width, result.height]).toEqual([512, 512]);
    expect(result.extension).toBe("webp");
    expect(await sizeOf(result.bytes)).toEqual({ width: 512, height: 512 });
  });

  it("applies the chain in order, which rotate and resize disagree about", async () => {
    // The two orders give genuinely different images, which is what
    // makes this an ordering test rather than a commutative one.
    //
    //   rotate then resize:  100x60 -> 60x100 -> bound width 30 -> 30x50
    //   resize then rotate:  100x60 -> 30x18  -> rotate         -> 18x30
    //
    // A pipeline that reordered or collapsed the two would produce one
    // of these for both inputs.
    const rotatedFirst = await run(await png(100, 60), [rotate(90), resizeDown(30)]);
    const resizedFirst = await run(await png(100, 60), [resizeDown(30), rotate(90)]);

    expect([rotatedFirst.width, rotatedFirst.height]).toEqual([30, 50]);
    expect([resizedFirst.width, resizedFirst.height]).toEqual([18, 30]);
  });

  it("lets the last format in a chain win", async () => {
    const result = await run(await png(50, 50), [format("webp"), format("avif")]);

    expect(result.extension).toBe("avif");
  });

  it("keeps the input's format when no format modifier is present", async () => {
    // A chain of pure resizes should leave a PNG a PNG.
    const result = await run(await png(100, 100), [resizeDown(50)]);

    expect(result.extension).toBe("png");
    expect(result.mimeType).toBe("image/png");
  });
});

describe('format("jpg")', () => {
  it("encodes successfully at the end of a chain", async () => {
    // The `jpg`-versus-`jpeg` normalisation. `media` canonicalises
    // `image/jpeg` to the `jpg` extension and passes it straight to the
    // driver; a chain that did all its work and then threw on the last
    // step is the failure this covers.
    const result = await run(await png(120, 90), [resizeDown(60), format("jpg")]);

    expect(result.extension).toBe("jpg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(await sizeOf(result.bytes)).toEqual({ width: 60, height: 45 });
  });

  it("accepts the MIME spelling too", async () => {
    const result = await run(await png(40, 40), [format("image/jpeg")]);

    expect(result.extension).toBe("jpg");
  });
});

describe("setBackgroundColor", () => {
  it("puts white where the image was transparent", async () => {
    // The practical case: a transparent PNG becoming a JPEG, which has
    // no alpha channel. Without the flatten the transparent area renders
    // black — see the control below.
    const result = await run(
      await transparentPng(40, 40),
      [setBackgroundColor("#ffffff"), format("jpg")],
      "image/png",
    );

    expect(await topLeftPixel(result.bytes)).toEqual([255, 255, 255]);
  });

  it("goes black without it, which is the whole reason it exists", async () => {
    const result = await run(await transparentPng(40, 40), [format("jpg")], "image/png");

    expect(await topLeftPixel(result.bytes)).toEqual([0, 0, 0]);
  });

  it("preserves the dimensions", async () => {
    const result = await run(await transparentPng(70, 50), [setBackgroundColor("#ff0000")]);

    expect([result.width, result.height]).toEqual([70, 50]);
  });

  it("composes with a resize before it", async () => {
    const result = await run(await transparentPng(100, 100), [
      resizeDown(40),
      setBackgroundColor("#ffffff"),
      format("jpg"),
    ]);

    expect([result.width, result.height]).toEqual([40, 40]);
    expect(await topLeftPixel(result.bytes)).toEqual([255, 255, 255]);
  });
});

describe("JPEG input", () => {
  it("round-trips through a chain", async () => {
    // A 3-channel source, so the raw materialisation has to carry
    // `channels: 3` rather than assuming RGBA.
    const result = await run(await jpeg(200, 100), [resizeDown(100)], "image/jpeg");

    expect([result.width, result.height]).toEqual([100, 50]);
    expect(result.extension).toBe("jpg");
  });

  it("converts to a format with alpha without inventing any", async () => {
    const result = await run(await jpeg(60, 60), [format("png")], "image/jpeg");

    expect(await sizeOf(result.bytes)).toEqual({ width: 60, height: 60 });
  });
});
