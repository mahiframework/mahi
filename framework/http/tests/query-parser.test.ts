import { afterEach, describe, expect, it } from "vitest";
import { parseNestedEntries, parseNestedQuery } from "../src/query-parser.js";

describe("parseNestedQuery()", () => {
  it("parses plain pairs", () => {
    expect(parseNestedQuery("a=1&b=two")).toEqual({ a: "1", b: "two" });
  });

  it("tolerates a leading ? and an empty string", () => {
    expect(parseNestedQuery("?a=1")).toEqual({ a: "1" });
    expect(parseNestedQuery("")).toEqual({});
  });

  it("expands [] into a real array", () => {
    // The headline case: without this, `ids` is the single string-keyed
    // entry `{"ids[]": "1"}`, so an `array()` validation rule on a query
    // field could never pass, and the second value was silently dropped.
    expect(parseNestedQuery("ids[]=1&ids[]=2")).toEqual({ ids: ["1", "2"] });
  });

  it("expands explicit numeric indices into an array", () => {
    expect(parseNestedQuery("ids[0]=a&ids[1]=b")).toEqual({ ids: ["a", "b"] });
  });

  it("keeps a gapped index set as an object rather than inventing holes", () => {
    expect(parseNestedQuery("ids[0]=a&ids[2]=c")).toEqual({ ids: { "0": "a", "2": "c" } });
  });

  it("expands nested object notation", () => {
    expect(parseNestedQuery("user[name]=bob")).toEqual({ user: { name: "bob" } });
    expect(parseNestedQuery("user[address][city]=Perth")).toEqual({
      user: { address: { city: "Perth" } },
    });
  });

  it("handles arrays of objects", () => {
    expect(parseNestedQuery("items[0][id]=1&items[1][id]=2")).toEqual({
      items: [{ id: "1" }, { id: "2" }],
    });
  });

  it("lets the last value win for a repeated plain key, as PHP does", () => {
    expect(parseNestedQuery("a=1&a=2")).toEqual({ a: "2" });
  });

  it("leaves values as strings. Coercion is the validator's job", () => {
    // Coercing here would turn a zip code of "01234" into 1234.
    expect(parseNestedQuery("n=007")).toEqual({ n: "007" });
  });

  it("keeps malformed bracket keys verbatim instead of throwing", () => {
    expect(parseNestedQuery("a[b=1")).toEqual({ "a[b": "1" });
    expect(parseNestedQuery("a[b]c=1")).toEqual({ "a[b]c": "1" });
    expect(parseNestedQuery("[a]=1")).toEqual({ "[a]": "1" });
  });

  it("caps nesting depth, keeping an over-deep key literal", () => {
    const deep = `a${"[b]".repeat(20)}=1`;
    expect(parseNestedQuery(deep)).toEqual({ [`a${"[b]".repeat(20)}`]: "1" });
  });

  it("refuses to allocate a huge array for a large index", () => {
    // `?a[10000000]=1` is 16 bytes of attacker input.
    const parsed = parseNestedQuery("a[10000000]=1") as { a: Record<string, string> };
    expect(Array.isArray(parsed.a)).toBe(false);
    expect(parsed.a["10000000"]).toBe("1");
  });

  it("resolves a scalar/container conflict in favour of the container", () => {
    expect(parseNestedQuery("a=1&a[b]=2")).toEqual({ a: { b: "2" } });
  });

  describe("prototype pollution", () => {
    afterEach(() => {
      for (const key of ["polluted", "headers", "nested"]) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    });

    it("never writes through __proto__ at the root", () => {
      expect(parseNestedQuery("__proto__[polluted]=yes")).toEqual({});
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("never writes through __proto__ below the root", () => {
      expect(parseNestedQuery("a[__proto__][polluted]=yes&a[ok]=1")).toEqual({ a: { ok: "1" } });
      expect(parseNestedQuery("a[b][__proto__][nested][deep]=yes")).toEqual({});
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).nested).toBeUndefined();
    });

    it("drops constructor and prototype segments", () => {
      expect(parseNestedQuery("constructor[prototype][polluted]=yes")).toEqual({});
      expect(parseNestedQuery("a[constructor][prototype][polluted]=yes")).toEqual({});
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("drops a plain unsafe key", () => {
      const parsed = parseNestedQuery("__proto__=x&constructor=y&a=1");

      expect(parsed).toEqual({ a: "1" });
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    });

    it("guards form entries the same way", () => {
      expect(parseNestedEntries([["__proto__[headers][x]", "1"]])).toEqual({});
      expect(parseNestedEntries([["a[__proto__][polluted]", "1"]])).toEqual({});
      expect(({} as Record<string, unknown>).headers).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("descends only through own properties", () => {
      expect(parseNestedQuery("toString[a]=1&hasOwnProperty[]=2")).toEqual({
        toString: { a: "1" },
        hasOwnProperty: ["2"],
      });
    });
  });
});
