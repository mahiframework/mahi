import { describe, expect, it } from "vitest";
import { Base32Error, decodeBase32, encodeBase32 } from "../../src/totp/base32.js";

describe("encodeBase32", () => {
  it("matches the RFC 4648 §10 test vectors, unpadded", () => {
    // The RFC tabulates these with `=` padding; this encoder omits it on
    // purpose (see the module docblock), so the expectations are the
    // RFC's values with the padding stripped.
    const vectors: Array<[string, string]> = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];

    for (const [input, expected] of vectors) {
      expect(encodeBase32(Buffer.from(input, "utf-8"))).toBe(expected);
    }
  });

  it("encodes the RFC 6238 20-byte seed", () => {
    expect(encodeBase32(Buffer.from("12345678901234567890", "utf-8"))).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
  });

  it("emits only alphabet characters", () => {
    for (let length = 1; length <= 40; length += 1) {
      const encoded = encodeBase32(Buffer.alloc(length, length));
      expect(encoded).toMatch(/^[A-Z2-7]+$/);
    }
  });

  it("does not truncate a trailing partial group", () => {
    // A 20-byte secret is not a multiple of 5 bits' worth of bytes in a
    // way that lands evenly, so dropping leftover bits here would
    // silently shorten most real secrets.
    for (let length = 1; length <= 16; length += 1) {
      const bytes = Buffer.alloc(length, 0xab);
      expect(Buffer.from(decodeBase32(encodeBase32(bytes)))).toEqual(bytes);
    }
  });
});

describe("decodeBase32", () => {
  it("round-trips random bytes", () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_value, index) => (index * 37 + 11) % 256));
      expect(Buffer.from(decodeBase32(encodeBase32(bytes)))).toEqual(bytes);
    }
  });

  it("is case-insensitive", () => {
    expect(Buffer.from(decodeBase32("mzxw6ytboi")).toString("utf-8")).toBe("foobar");
  });

  it("accepts padding", () => {
    expect(Buffer.from(decodeBase32("MZXW6YTBOI======")).toString("utf-8")).toBe("foobar");
  });

  it("accepts the spacing a human reads a secret in", () => {
    expect(Buffer.from(decodeBase32("MZXW 6YTB OI")).toString("utf-8")).toBe("foobar");
    expect(Buffer.from(decodeBase32("MZXW-6YTB-OI")).toString("utf-8")).toBe("foobar");
  });

  it("throws on a character outside the alphabet", () => {
    // Skipping it would turn a mistyped secret into a DIFFERENT valid
    // secret, whose codes would simply never match, with nothing to
    // indicate why.
    for (const bad of ["MZXW6YTBO!", "MZXW6YTB0I", "MZXW6YTB1I", "MZXW6YTB8I"]) {
      expect(() => decodeBase32(bad)).toThrow(Base32Error);
    }
  });

  it("decodes empty input to no bytes", () => {
    expect(decodeBase32("")).toEqual(new Uint8Array(0));
    expect(decodeBase32("   ")).toEqual(new Uint8Array(0));
  });
});
