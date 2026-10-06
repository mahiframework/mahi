import { describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { SettingDecodeError, SettingsError } from "../src/errors.js";
import { decode, display, encode, parseInput } from "../src/value-codec.js";

describe("encode / decode round trips", () => {
  it("round-trips every type", () => {
    const cases: [string, Parameters<typeof encode>[1], unknown][] = [
      ["s", "string", "hello"],
      ["s", "string", ""],
      ["n", "number", 42],
      ["n", "number", 0],
      ["n", "number", -1.5],
      ["b", "boolean", true],
      ["b", "boolean", false],
      ["a", "array", []],
      ["a", "array", [1, "two", null]],
      ["j", "json", { nested: { deep: true } }],
      ["j", "json", null],
    ];

    for (const [key, type, value] of cases) {
      expect(decode(key, type, encode(key, type, value))).toEqual(value);
    }
  });

  it("round-trips a datetime to the same instant", () => {
    const when = DateTime.parse("2026-03-04T05:06:07Z", "UTC");
    const decoded = decode("d", "datetime", encode("d", "datetime", when));

    expect(decoded).toBeInstanceOf(DateTime);
    expect((decoded as DateTime).toISOString()).toBe(when.toISOString());
  });

  it("normalises a zoned datetime to UTC on the way in", () => {
    // `toISOString()` renders in the instance's own zone, so without the
    // conversion a value built in a non-UTC zone would be stored as a
    // local wall clock and read back as a different instant on two
    // engines out of three.
    const perth = DateTime.parse("2026-03-04T05:06:07Z", "UTC").inTimezone("Australia/Perth");

    expect(encode("d", "datetime", perth)).toBe('"2026-03-04T05:06:07.000Z"');
  });

  it("accepts a Date, an ISO string or an epoch number for a datetime", () => {
    const expected = DateTime.parse("2026-03-04T05:06:07Z", "UTC").toISOString();

    for (const input of [
      new Date("2026-03-04T05:06:07Z"),
      "2026-03-04T05:06:07Z",
      Date.parse("2026-03-04T05:06:07Z"),
    ]) {
      expect(encode("d", "datetime", input)).toBe(JSON.stringify(expected));
    }
  });

  it("produces JSON-safe text for every type", () => {
    // The encoded form is what crosses the cache boundary, where
    // `JSON.stringify` is the persistence mechanism on two of three
    // stores.
    const encoded = encode("j", "json", { a: [1, 2], b: null });

    expect(JSON.parse(JSON.stringify(encoded))).toBe(encoded);
  });
});

describe("encode rejections", () => {
  it("names the setting when a value cannot be serialised", () => {
    // `JSON.stringify` throws on a bigint. The error it raises on its own
    // does not say which setting, which is the only thing that makes it
    // actionable.
    const error = (() => {
      try {
        encode("snowflake_setting", "json", { id: 1n });
      } catch (caught) {
        return caught;
      }

      return undefined;
    })();

    expect(error).toBeInstanceOf(SettingsError);
    expect((error as Error).message).toContain("snowflake_setting");
  });

  it("rejects a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => encode("c", "json", circular)).toThrow(SettingsError);
  });

  it("rejects a datetime value that is not a date", () => {
    expect(() => encode("d", "datetime", "not a date")).toThrow(SettingsError);
  });
});

describe("decode rejections", () => {
  it("rejects text that is not JSON", () => {
    expect(() => decode("s", "string", "not json")).toThrow(SettingDecodeError);
  });

  it("rejects a stored value whose shape no longer matches the declared type", () => {
    // The case a definition's `type` changing after a value was written
    // produces. Throwing rather than silently falling back to the
    // default: a row saying one thing while the app reads another is a
    // configuration change nobody asked for.
    const error = (() => {
      try {
        decode("import_batch_size", "number", '"two hundred"');
      } catch (caught) {
        return caught;
      }

      return undefined;
    })();

    expect(error).toBeInstanceOf(SettingDecodeError);
    expect((error as Error).message).toContain("expected a finite number, got a string");
    // Names the way out, so the error is self-servicing.
    expect((error as Error).message).toContain("settings:forget import_batch_size");
  });

  it("rejects a non-finite number", () => {
    // `JSON.stringify(Infinity)` is `"null"`, so this is reachable from
    // a hand-edited row rather than from `encode()`.
    expect(() => decode("n", "number", "null")).toThrow(SettingDecodeError);
  });

  it("rejects an object where an array was declared", () => {
    expect(() => decode("a", "array", '{"0":"a"}')).toThrow(SettingDecodeError);
  });

  it("rejects an unparsable date", () => {
    expect(() => decode("d", "datetime", '"the fourth of March"')).toThrow(SettingDecodeError);
  });

  it("accepts null for a json setting, which holds anything JSON does", () => {
    expect(decode("j", "json", "null")).toBeNull();
  });
});

describe("parseInput", () => {
  it("passes a string through untouched", () => {
    expect(parseInput("s", "string", "  spaces kept  ")).toBe("  spaces kept  ");
  });

  it("parses a number", () => {
    expect(parseInput("n", "number", "42")).toBe(42);
    expect(parseInput("n", "number", "-1.5")).toBe(-1.5);
  });

  it("rejects a number it cannot parse, naming the setting", () => {
    expect(() => parseInput("import_batch_size", "number", "many")).toThrow(
      /"many" is not a number, which "import_batch_size" requires/,
    );
  });

  it("accepts the booleans an operator would actually type", () => {
    for (const input of ["true", "1", "yes", "on", "TRUE", " On "]) {
      expect(parseInput("b", "boolean", input)).toBe(true);
    }

    for (const input of ["false", "0", "no", "off", "FALSE"]) {
      expect(parseInput("b", "boolean", input)).toBe(false);
    }
  });

  it("rejects a boolean it cannot parse", () => {
    expect(() => parseInput("b", "boolean", "maybe")).toThrow(SettingsError);
  });

  it("takes JSON text for a json or array setting", () => {
    // Deliberately JSON rather than a comma-separated list: a setting
    // whose values can contain commas would otherwise have no way to say
    // so.
    expect(parseInput("a", "array", '["a","b,c"]')).toEqual(["a", "b,c"]);
    expect(parseInput("j", "json", '{"k":1}')).toEqual({ k: 1 });
  });

  it("rejects invalid JSON, naming the setting", () => {
    expect(() => parseInput("branding", "json", "{nope}")).toThrow(/"branding" takes JSON/);
  });
});

describe("display", () => {
  it("renders a string bare, without JSON quotes", () => {
    expect(display("hello")).toBe("hello");
  });

  it("renders scalars, arrays and objects readably", () => {
    expect(display(42)).toBe("42");
    expect(display(false)).toBe("false");
    expect(display(null)).toBe("null");
    expect(display(["a", "b"])).toBe('["a","b"]');
    expect(display({ k: 1 })).toBe('{"k":1}');
  });

  it("renders a DateTime as an ISO string", () => {
    const when = DateTime.parse("2026-03-04T05:06:07Z", "UTC");

    expect(display(when)).toBe(when.toISOString());
  });
});
