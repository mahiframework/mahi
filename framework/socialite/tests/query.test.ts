import { describe, expect, it } from "vitest";
import { buildQuery } from "../src/query.js";

describe("buildQuery", () => {
  it("joins pairs in insertion order", () => {
    expect(buildQuery({ client_id: "abc", scope: "read" })).toBe("client_id=abc&scope=read");
  });

  it("skips undefined values so optional fields can be spread in", () => {
    expect(buildQuery({ a: "1", b: undefined, c: "3" })).toBe("a=1&c=3");
  });

  it("keeps an empty string, which is not the same as absent", () => {
    expect(buildQuery({ a: "" })).toBe("a=");
  });

  describe("rfc1738 (the default)", () => {
    it("encodes a space as +", () => {
      expect(buildQuery({ scope: "read write" })).toBe("scope=read+write");
    });

    it("escapes a tilde", () => {
      expect(buildQuery({ a: "~" })).toBe("a=%7E");
    });
  });

  describe("rfc3986", () => {
    it("encodes a space as %20", () => {
      expect(buildQuery({ scope: "read write" }, "rfc3986")).toBe("scope=read%20write");
    });

    it("leaves a tilde literal", () => {
      expect(buildQuery({ a: "~" }, "rfc3986")).toBe("a=~");
    });
  });

  // The two encodings differ on exactly these characters, which is the
  // whole reason this module exists rather than a bare URLSearchParams.
  it("differs between encodings only on space and tilde", () => {
    const params = { a: "a b~c" };

    expect(buildQuery(params, "rfc1738")).toBe("a=a+b%7Ec");
    expect(buildQuery(params, "rfc3986")).toBe("a=a%20b~c");
  });

  it("escapes the sub-delimiters encodeURIComponent leaves alone", () => {
    expect(buildQuery({ a: "!'()*" }, "rfc3986")).toBe("a=%21%27%28%29%2A");
  });

  it("escapes reserved characters that would otherwise split the query", () => {
    expect(buildQuery({ "a&b": "c=d" })).toBe("a%26b=c%3Dd");
  });

  it("round-trips through URLSearchParams", () => {
    const url = new URL(`https://x.test/?${buildQuery({ scope: "read write", state: "a~b" })}`);

    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("a~b");
  });
});
