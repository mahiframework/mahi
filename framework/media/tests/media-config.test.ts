import { describe, expect, it } from "vitest";
import { resolveAccept, resolveConfig } from "../src/media-config.js";

describe("resolveConfig", () => {
  it("defaults every field", () => {
    expect(resolveConfig()).toEqual({
      disk: null,
      path: null,
      pathNesting: 4,
      hashAlgorithm: "sha256",
      verifyHashes: false,
      accept: { mimes: [], extensions: [], maxBytes: null },
      connection: undefined,
    });
  });

  it("defaults to sha256 rather than md5", () => {
    // A checksum here answers "has this file changed underneath us", and
    // md5's collision weakness makes that answer forgeable by anyone who
    // can write to the disk. laravel-media defaults to md5; this does not.
    expect(resolveConfig().hashAlgorithm).toBe("sha256");
  });

  it.each([
    ["uploads", "uploads"],
    ["/uploads", "uploads"],
    ["uploads/", "uploads"],
    ["/uploads/media/", "uploads/media"],
    ["", null],
    ["/", null],
  ])("normalises the path prefix %j to %j", (input, expected) => {
    expect(resolveConfig({ path: input }).path).toBe(expected);
  });

  it("keeps a falsy-but-meaningful pathNesting of 0", () => {
    // `??` not `||`: zero nesting is a legitimate choice (one flat
    // directory), and `||` would silently restore the default of 4.
    expect(resolveConfig({ pathNesting: 0 }).pathNesting).toBe(0);
  });

  it("keeps verify: false distinct from unset", () => {
    expect(resolveConfig({ hashing: { verify: false } }).verifyHashes).toBe(false);
    expect(resolveConfig({ hashing: { verify: true } }).verifyHashes).toBe(true);
  });
});

describe("resolveAccept", () => {
  it("lowercases mime patterns", () => {
    // A filter a capitalisation defeats is not a filter: `image/JPEG`
    // from a careless client has to match an `image/jpeg` rule.
    expect(resolveAccept({ mimes: ["Image/JPEG"] }).mimes).toEqual(["image/jpeg"]);
  });

  it("lowercases extensions and strips a leading dot", () => {
    expect(resolveAccept({ extensions: [".JPG", "PNG"] }).extensions).toEqual(["jpg", "png"]);
  });

  it("preserves glob patterns for Str.is", () => {
    expect(resolveAccept({ mimes: ["image/*"] }).mimes).toEqual(["image/*"]);
  });

  it("defaults to no constraints at all", () => {
    expect(resolveAccept()).toEqual({ mimes: [], extensions: [], maxBytes: null });
  });

  it("keeps maxBytes: 0 distinct from unset", () => {
    expect(resolveAccept({ maxBytes: 0 }).maxBytes).toBe(0);
    expect(resolveAccept().maxBytes).toBeNull();
  });
});
