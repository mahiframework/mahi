import { describe, expect, it } from "vitest";
import { loadSharp, resetSharpCache } from "../src/sharp-loader.js";

describe("loadSharp", () => {
  it("resolves the callable sharp factory", async () => {
    // `sharp` is CommonJS, so `import()` yields a namespace object whose
    // `default` is the factory — the namespace itself is NOT callable.
    // Returning the namespace would make every `sharp(...)` call in this
    // package a TypeError on first use.
    const sharp = await loadSharp();

    expect(typeof sharp).toBe("function");
    expect(sharp.versions.vips).toBeTypeOf("string");
  });

  it("builds a working pipeline from what it returns", async () => {
    const sharp = await loadSharp();

    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();

    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("caches the module across calls", async () => {
    // Called once per operation on a modifier chain, so the await and
    // the promise are worth avoiding even though Node caches the module
    // record itself.
    resetSharpCache();

    expect(await loadSharp()).toBe(await loadSharp());
  });

  it("returns the same module after a cache reset", async () => {
    // The reset is a test affordance, not an unload — Node's own module
    // cache still holds the native addon, and loading a second copy of
    // it would be a problem rather than a feature.
    const first = await loadSharp();
    resetSharpCache();

    expect(await loadSharp()).toBe(first);
  });
});
