import { describe, expect, it } from "vitest";
import { FakeImageDriver, resizeDown, runModifiers } from "@mahiframework/media";
import { SharpImageDriver } from "../src/sharp-image-driver.js";
import {
  blur,
  extend,
  grayscale,
  sharpen,
  sharpModifier,
  tint,
  trim,
} from "../src/sharp-modifier.js";
import { gradientPng, jpeg, png, sizeOf, topLeftPixel } from "./__fixtures__/images.js";

async function run(
  bytes: Uint8Array,
  modifiers: Parameters<typeof runModifiers>[4],
  driver: Parameters<typeof runModifiers>[0] = new SharpImageDriver(),
) {
  return runModifiers(driver, "sharp", bytes, "image/png", modifiers);
}

describe("sharpModifier", () => {
  it("runs an arbitrary transformation against a real sharp pipeline", async () => {
    const result = await run(await png(100, 60), [
      sharpModifier("halve", (pipeline) => pipeline.resize({ width: 50 })),
    ]);

    expect([result.width, result.height]).toEqual([50, 30]);
  });

  it("materialises the result, so it chains with generic modifiers", async () => {
    // The property that makes the escape hatch safe to mix in: a native
    // modifier's output is a normal handle, so the generic op after it
    // measures the right thing.
    const result = await run(await png(200, 100), [
      sharpModifier("crop", (pipeline) =>
        pipeline.extract({ left: 0, top: 0, width: 80, height: 80 }),
      ),
      resizeDown(40),
    ]);

    expect([result.width, result.height]).toEqual([40, 40]);
  });

  it("composes several filter calls in one transform", async () => {
    // Filters compose correctly on a lazy pipeline, unlike geometry
    // calls, so chaining them inside one transform is both allowed and
    // cheaper than a modifier each.
    const result = await run(await gradientPng(100, 100), [
      sharpModifier("soften", (pipeline) => pipeline.blur(4).modulate({ brightness: 0.9 })),
    ]);

    expect([result.width, result.height]).toEqual([100, 100]);
  });

  it("fails clearly under a driver that is not this one", async () => {
    // NOT PORTABLE BY CONSTRUCTION, and the failure has to say so.
    // Silently skipping would produce an unmodified image and no
    // indication why — the laravel-media behaviour `media` exists to
    // avoid.
    const fake = new FakeImageDriver(100, 60);

    await expect(
      runModifiers(fake, "fake", await png(), "image/png", [
        sharpModifier("blur", (pipeline) => pipeline.blur(4)),
      ]),
    ).rejects.toThrow(
      /specific to @mahiframework\/media-sharp.*configured image driver is "fake"/s,
    );
  });

  it("names itself in that error, so the offending modifier is findable", async () => {
    const fake = new FakeImageDriver();

    await expect(
      runModifiers(fake, "fake", await png(), "image/png", [
        sharpModifier("my-custom-thing", (pipeline) => pipeline),
      ]),
    ).rejects.toThrow(/The "my-custom-thing" modifier/);
  });

  it("surfaces an error thrown by the transform itself", async () => {
    await expect(
      run(await png(100, 60), [
        // Off the edge of the image, which libvips refuses.
        sharpModifier("bad-crop", (pipeline) =>
          pipeline.extract({ left: 500, top: 0, width: 10, height: 10 }),
        ),
      ]),
    ).rejects.toThrow(/extract_area/);
  });
});

describe("the named extras", () => {
  it("blur keeps the dimensions and changes the pixels", async () => {
    const source = await gradientPng(100, 100);
    const blurred = await run(source, [blur(8)]);

    expect([blurred.width, blurred.height]).toEqual([100, 100]);
    expect(Buffer.from(blurred.bytes).equals(Buffer.from(source))).toBe(false);
  });

  it("sharpen works with and without an explicit sigma", async () => {
    const source = await gradientPng(80, 80);

    expect((await run(source, [sharpen()])).width).toBe(80);
    expect((await run(source, [sharpen(2)])).width).toBe(80);
  });

  it("grayscale collapses the colour", async () => {
    // A red image becomes a grey one, so the three channels agree.
    const result = await run(await png(40, 40, "#ff0000"), [grayscale()]);
    const [r, g, b] = await topLeftPixel(result.bytes);

    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("tint shifts the hue", async () => {
    // Mid-grey, not white. `tint` PRESERVES LUMINANCE, so a pure white
    // input stays white — every channel is already clipped at 255 and
    // there is no headroom for blue to win. A grey source is the one
    // that can actually move.
    const result = await run(await png(40, 40, "#808080"), [tint("#0000ff")]);
    const [r, , b] = await topLeftPixel(result.bytes);

    expect(b).toBeGreaterThan(r);
  });

  it("trim removes a uniform border", async () => {
    // A 20x20 red square centred in a 60x60 white canvas: trimming the
    // white should leave the square. This is the auto-crop for a logo
    // that arrived with padding baked in.
    const sharp = (await import("sharp")).default;
    const bordered = await sharp({
      create: { width: 60, height: 60, channels: 4, background: "#ffffff" },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 20, height: 20, channels: 4, background: "#ff0000" },
          })
            .png()
            .toBuffer(),
          left: 20,
          top: 20,
        },
      ])
      .png()
      .toBuffer();

    const result = await run(bordered, [trim()]);

    expect([result.width, result.height]).toEqual([20, 20]);
  });

  it("extend pads by a uniform amount", async () => {
    const result = await run(await png(40, 30), [extend(5)]);

    expect([result.width, result.height]).toEqual([50, 40]);
  });

  it("extend pads per side", async () => {
    const result = await run(await png(40, 30), [extend({ left: 10, bottom: 4 })]);

    expect([result.width, result.height]).toEqual([50, 34]);
  });

  it("extend pads transparently by default", async () => {
    const result = await run(await png(20, 20, "#ff0000"), [extend(5)]);
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(Buffer.from(result.bytes))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(data[3]).toBe(0);
    expect(info.width).toBe(30);
  });

  it("extend takes a background colour", async () => {
    const result = await run(await png(20, 20, "#ff0000"), [extend(5, "#0000ff")]);

    expect(await topLeftPixel(result.bytes)).toEqual([0, 0, 255]);
  });

  it("mixes with the generic modifiers in one chain", async () => {
    // The realistic use: a portable chain with one native step in it.
    const result = await run(await jpeg(400, 300), [resizeDown(200), sharpen(), grayscale()]);

    expect([result.width, result.height]).toEqual([200, 150]);
    expect(await sizeOf(result.bytes)).toEqual({ width: 200, height: 150 });
  });
});
