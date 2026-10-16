import { describe, expect, it, beforeEach } from "vitest";
import { expectTypeOf } from "vitest";
import {
  Rule,
  rule,
  numberRule,
  booleanRule,
  fileRule,
  objectRule,
  Validator,
  ValidationRule,
  ValidationException,
  resetDefaults,
  setPresenceResolver,
} from "../src/index.js";
import type { InferRules } from "../src/index.js";

beforeEach(() => {
  resetDefaults();
  setPresenceResolver(undefined);
});

describe("Validator: presence and types", () => {
  it("passes a required string", async () => {
    const validator = new Validator({ name: "Ada" }, {}, { name: rule().string().required() });
    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ name: "Ada" });
  });

  it("fails when a required field is missing", async () => {
    const validator = new Validator({}, {}, { name: rule().string().required() });
    expect(await validator.passes()).toBe(false);
    expect(validator.errors().name?.[0]).toMatch(/name field is required/);
  });

  it("fails when a required field is empty", async () => {
    const validator = new Validator({ name: "" }, {}, { name: rule().string().required() });
    expect(await validator.passes()).toBe(false);
  });

  it("skips optional missing fields and omits them from validated()", async () => {
    const validator = new Validator(
      { name: "Ada" },
      {},
      {
        name: rule().string().required(),
        age: numberRule().integer().optional(),
      },
    );
    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ name: "Ada" });
  });

  it("includes optional fields that are present", async () => {
    const validator = new Validator(
      { name: "Ada", age: "18" },
      {},
      {
        name: rule().string().required(),
        age: numberRule().integer().optional(),
      },
    );
    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ name: "Ada", age: 18 });
  });

  it("allows null on nullable fields and skips remaining steps", async () => {
    const validator = new Validator(
      { post_id: null },
      {},
      {
        post_id: rule().nullable().exists("posts", "id"),
      },
    );
    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ post_id: null });
  });

  it("strips unknown extra keys from validated()", async () => {
    const validator = new Validator(
      { name: "Ada", extra: "nope" },
      {},
      {
        name: rule().string().required(),
      },
    );
    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ name: "Ada" });
  });
});

describe("Validator: constraints", () => {
  it("enforces min/max on strings", async () => {
    const rules = { title: rule().string().min(5).max(10) };
    expect(await new Validator({ title: "hey" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ title: "hello" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ title: "hello world" }, {}, rules).passes()).toBe(false);
  });

  it("enforces min/max on numbers", async () => {
    const rules = { age: numberRule().integer().min(18) };
    expect(await new Validator({ age: 17 }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ age: 18 }, {}, rules).passes()).toBe(true);
  });

  it("validates email", async () => {
    const rules = { email: rule().string().email().required() };
    expect(await new Validator({ email: "not-an-email" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ email: "ada@example.com" }, {}, rules).passes()).toBe(true);
  });

  it("validates regex, confirmed, in, same", async () => {
    const rules = {
      username: rule()
        .string()
        .regex(/^[a-z0-9_]{3,20}$/)
        .required(),
      password: rule().string().required().confirmed(),
      role: rule().string().in(["admin", "user"]),
      password_confirmation: rule().string().required(),
    };
    const ok = new Validator(
      { username: "ada", password: "secret", password_confirmation: "secret", role: "user" },
      {},
      rules,
    );
    expect(await ok.passes()).toBe(true);

    const bad = new Validator(
      { username: "Ada", password: "secret", password_confirmation: "nope", role: "god" },
      {},
      rules,
    );
    expect(await bad.passes()).toBe(false);
    expect(bad.errors().username).toBeTruthy();
    expect(bad.errors().password).toBeTruthy();
    expect(bad.errors().role).toBeTruthy();
  });

  it("bail() stops that field after the first failure", async () => {
    const rules = { title: rule().string().min(10).max(5).bail() };
    const validator = new Validator({ title: "hey" }, {}, rules);
    expect(await validator.passes()).toBe(false);
    expect(validator.errors().title).toHaveLength(1);
  });

  it("collects multiple errors per field without bail()", async () => {
    const rules = { title: rule().string().startsWith("X").endsWith("Z") };
    const validator = new Validator({ title: "hello" }, {}, rules);
    expect(await validator.passes()).toBe(false);
    expect(validator.errors().title?.length).toBeGreaterThan(1);
  });
});

describe("Validator: nested data", () => {
  it("validates objectRule shapes and strips extra nested keys", async () => {
    const rules = {
      address: objectRule({
        city: rule().string().required(),
        zip: rule().string().required(),
      }),
    };
    const validator = new Validator(
      { address: { city: "Perth", zip: "6000", extra: true } },
      {},
      rules,
    );
    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ address: { city: "Perth", zip: "6000" } });
  });

  it("reports nested object errors with dotted keys", async () => {
    const rules = {
      address: objectRule({
        city: rule().string().required(),
      }),
    };
    const validator = new Validator({ address: {} }, {}, rules);
    expect(await validator.passes()).toBe(false);
    expect(validator.errors()["address.city"]?.[0]).toMatch(/city field is required/);
  });

  it("validates arrays of scalars", async () => {
    const rules = { tags: rule().array(rule().string()).optional() };
    expect(await new Validator({ tags: ["a", "b"] }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ tags: ["a", 1] }, {}, rules).passes()).toBe(false);
  });

  it("object() with no shape passes the contents through, as array() does", async () => {
    const validator = new Validator(
      { tags: ["a", "b"], config: { host: "example.test", retries: 3 } },
      {},
      { tags: rule().array().optional(), config: rule().object().optional() },
    );

    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({
      tags: ["a", "b"],
      config: { host: "example.test", retries: 3 },
    });
  });

  it("object() with no shape still asserts the value is an object", async () => {
    const rules = { config: rule().object().required() };

    expect(await new Validator({ config: "nope" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ config: [1, 2] }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ config: null }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ config: { a: 1 } }, {}, rules).passes()).toBe(true);
  });

  it("object({}) declares an empty shape, so every key is stripped", async () => {
    const validator = new Validator(
      { config: { host: "example.test" } },
      {},
      { config: rule().object({}).optional() },
    );

    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ config: {} });
  });

  it("object() takes a message in the no-shape position", async () => {
    const validator = new Validator(
      { config: 7 },
      {},
      { config: rule().object("Config must be an object.").required() },
    );

    expect(await validator.passes()).toBe(false);
    expect(validator.errors().config).toEqual(["Config must be an object."]);
  });

  it("objectRule() with no shape is rule().object()", async () => {
    const validator = new Validator(
      { config: { host: "example.test" } },
      {},
      { config: objectRule() },
    );

    expect(await validator.passes()).toBe(true);
    expect(validator.validated()).toEqual({ config: { host: "example.test" } });
  });

  it("a shapeless object() rule survives clone()", async () => {
    const shared = rule().object().optional();

    for (const config of [{ a: 1 }, { b: 2 }]) {
      const validator = new Validator({ config }, {}, { config: shared.clone() });
      expect(await validator.passes()).toBe(true);
      expect(validator.validated()).toEqual({ config });
    }
  });
});

describe("Validator: files", () => {
  it("reads files from the files bag, not input", async () => {
    const file = new File(["hello"], "photo.png", { type: "image/png" });
    const rules = { avatar: fileRule().image().optional() };
    const validator = new Validator({}, { avatar: file }, rules);
    expect(await validator.passes()).toBe(true);
    expect(validator.validated().avatar).toBe(file);
  });

  it("rejects non-image files for image()", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const validator = new Validator({}, { avatar: file }, { avatar: fileRule().image() });
    expect(await validator.passes()).toBe(false);
  });

  it("enforces max file size in kilobytes", async () => {
    const file = new File([new Uint8Array(2048)], "photo.png", { type: "image/png" });
    const ok = new Validator({}, { avatar: file }, { avatar: fileRule().max(3) });
    expect(await ok.passes()).toBe(true);
    const tooBig = new Validator({}, { avatar: file }, { avatar: fileRule().max(1) });
    expect(await tooBig.passes()).toBe(false);
  });

  it("validates arrays of files", async () => {
    const files = [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ];
    const rules = { images: rule().array(fileRule().image()).max(4).optional() };
    const validator = new Validator({}, { images: files }, rules);
    expect(await validator.passes()).toBe(true);
    expect(validator.validated().images).toHaveLength(2);
  });
});

describe("Validator: messages and attributes", () => {
  it("interpolates :attribute and :min, humanizing the field key", async () => {
    const validator = new Validator({ post_id: "" }, {}, { post_id: rule().string().required() });
    await validator.passes();
    expect(validator.errors().post_id?.[0]).toBe("The post id field is required.");
  });

  it("uses .as() for the display name", async () => {
    const validator = new Validator({}, {}, { post_id: rule().string().required().as("Post") });
    await validator.passes();
    expect(validator.errors().post_id?.[0]).toBe("The Post field is required.");
  });

  it("uses a per-call message over the default", async () => {
    const validator = new Validator(
      { title: 1 },
      {},
      { title: rule().string("Must be a valid string") },
    );
    await validator.passes();
    expect(validator.errors().title?.[0]).toBe("Must be a valid string");
  });

  it("Rule.setDefaultErrors overrides the default map", async () => {
    Rule.setDefaultErrors({ required: "Need a :attribute." });
    const validator = new Validator({}, {}, { email: rule().string().required() });
    await validator.passes();
    expect(validator.errors().email?.[0]).toBe("Need a email.");
  });

  it("Rule.setDefaultAttributes overrides the humanized key", async () => {
    Rule.setDefaultAttributes({ email: "email address" });
    const validator = new Validator({}, {}, { email: rule().string().required() });
    await validator.passes();
    expect(validator.errors().email?.[0]).toBe("The email address field is required.");
  });
});

describe("Validator: custom rules and composition", () => {
  it("runs a ValidationRule pass()/fail()", async () => {
    class NoSpam extends ValidationRule {
      run(_attribute: string, value: unknown): this {
        if (typeof value === "string" && value.includes("spam")) {
          return this.fail("Looks like spam.");
        }

        return this.pass();
      }
    }

    const rules = { title: rule().string().rule(new NoSpam()) };
    expect(await new Validator({ title: "hello" }, {}, rules).passes()).toBe(true);
    const bad = new Validator({ title: "buy spam" }, {}, rules);
    expect(await bad.passes()).toBe(false);
    expect(bad.errors().title?.[0]).toBe("Looks like spam.");
  });

  it(".with() applies a reusable fragment", async () => {
    const integerPercent = (r: Rule<number, any>) => r.integer().min(0).max(100);
    const rules = { percent: numberRule().required().with(integerPercent) };
    expect(await new Validator({ percent: 50 }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ percent: 101 }, {}, rules).passes()).toBe(false);
  });

  it(".when() applies a branch at chain time", async () => {
    const rules = {
      role: rule().string().required(),
      admin_code: rule()
        .string()
        .optional()
        .when(true, (r) => {
          r.required();
        }),
    };
    expect(await new Validator({ role: "admin" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ role: "admin", admin_code: "x" }, {}, rules).passes()).toBe(true);
  });
});

describe("Validator: exists / unique", () => {
  it("calls the presence resolver for exists and unique", async () => {
    const seen: string[] = [];
    setPresenceResolver({
      async exists(table, column, value) {
        seen.push(`exists:${table}:${column}:${value}`);

        return value === "ok";
      },
      async unique(table, column, value, ignore) {
        seen.push(`unique:${table}:${column}:${value}:${ignore?.id ?? ""}`);

        return value !== "taken";
      },
    });

    const rules = {
      post_id: rule().exists("posts", "id"),
      email: rule().string().unique("users", "email").ignore("self"),
    };

    const ok = new Validator({ post_id: "ok", email: "new@example.com" }, {}, rules);
    expect(await ok.passes()).toBe(true);

    const bad = new Validator({ post_id: "missing", email: "taken" }, {}, rules);
    expect(await bad.passes()).toBe(false);
    expect(seen).toContain("exists:posts:id:ok");
    expect(seen).toContain("unique:users:email:taken:self");
  });
});

describe("InferRules typing", () => {
  it("infers required / optional / nullable from Rule presence", () => {
    const rules = {
      name: rule().string().required(),
      email: rule().string().email().required(),
      age: numberRule().integer().min(18).optional(),
      bio: rule().string().nullish(),
    };

    expect(Object.keys(rules)).toEqual(["name", "email", "age", "bio"]);
    type Payload = InferRules<typeof rules>;
    expectTypeOf<Payload>().toEqualTypeOf<{
      name: string;
      email: string;
      age: number | undefined;
      bio: string | null | undefined;
    }>();
  });

  it("infers a shapeless object() as Record<string, unknown>", () => {
    const rules = {
      config: rule().object().required(),
      meta: objectRule().optional(),
      address: objectRule({ city: rule().string().required() }),
    };

    expect(Object.keys(rules)).toEqual(["config", "meta", "address"]);
    type Payload = InferRules<typeof rules>;
    expectTypeOf<Payload>().toEqualTypeOf<{
      config: Record<string, unknown>;
      meta: Record<string, unknown> | undefined;
      address: { city: string };
    }>();
  });
});

describe("ValidationException", () => {
  it("carries a 422 status and the error bag", () => {
    const error = new ValidationException({ email: ["The email field is required."] });
    expect(error.status).toBe(422);
    expect(error.message).toBe("Validation failed");
    expect(error.errors).toEqual({ email: ["The email field is required."] });
  });
});

describe("booleanRule", () => {
  it("coerces form-style booleans", async () => {
    const rules = { ok: booleanRule() };
    expect((await pass({ ok: "true" }, rules)).ok).toBe(true);
    expect((await pass({ ok: "0" }, rules)).ok).toBe(false);
    expect(await new Validator({ ok: "maybe" }, {}, rules).passes()).toBe(false);
  });
});

async function pass(data: Record<string, unknown>, rules: Record<string, Rule<any, any>>) {
  const validator = new Validator(data, {}, rules);
  expect(await validator.passes()).toBe(true);

  return validator.validated();
}

async function errorsFor(data: Record<string, unknown>, rules: Record<string, Rule<any, any>>) {
  const validator = new Validator(data, {}, rules);
  await validator.passes();

  return validator.errors();
}

describe(":values interpolation", () => {
  it("renders :values in startsWith/endsWith messages", async () => {
    const errs = await errorsFor({ code: "abc" }, { code: rule().string().startsWith("xyz") });
    expect(errs.code?.[0]).toBe("The code field must start with xyz.");
    const errs2 = await errorsFor({ code: "abc" }, { code: rule().string().endsWith("zzz") });
    expect(errs2.code?.[0]).toBe("The code field must end with zzz.");
  });

  it("renders :values in mimes/extensions messages", async () => {
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const v = new Validator({}, { doc: file }, { doc: fileRule().mimes("pdf", "docx") });
    await v.passes();
    expect(v.errors().doc?.[0]).toBe("The doc field must be a file of type: pdf, docx.");

    const v2 = new Validator({}, { doc: file }, { doc: fileRule().extensions("pdf") });
    await v2.passes();
    expect(v2.errors().doc?.[0]).toBe(
      "The doc field must have one of the following extensions: pdf.",
    );
  });

  it("interpolates :value without eating an adjacent :values token", async () => {
    // A template containing both should resolve each independently.
    const errs = await errorsFor(
      { n: 3 },
      { n: numberRule().multipleOf(2, ":value / :attribute") },
    );
    // multipleOf message uses :value only; ensure it renders the divisor.
    expect(errs.n?.[0]).toBe("2 / n");
  });
});

describe("nullable / nullish presence", () => {
  it("nullable requires the key to be present (a missing key fails)", async () => {
    const v = new Validator({}, {}, { name: rule().string().nullable() });
    expect(await v.passes()).toBe(false);
  });

  it("nullable accepts an explicit null and keeps it", async () => {
    expect(await pass({ name: null }, { name: rule().string().nullable() })).toEqual({
      name: null,
    });
  });

  it("nullish skips a missing key and omits it from validated()", async () => {
    expect(await pass({}, { name: rule().string().nullish() })).toEqual({});
  });

  it("nullish accepts an explicit null", async () => {
    expect(await pass({ name: null }, { name: rule().string().nullish() })).toEqual({ name: null });
  });
});

describe("sometimes()", () => {
  it("sometimes().required() and required().sometimes() behave identically", async () => {
    const a = { code: rule().string().sometimes().required() };
    const b = { code: rule().string().required().sometimes() };

    // Missing key: both skip.
    expect(await pass({}, a)).toEqual({});
    expect(await pass({}, b)).toEqual({});

    // Present but empty: both fail the required check.
    expect(await new Validator({ code: "" }, {}, a).passes()).toBe(false);
    expect(await new Validator({ code: "" }, {}, b).passes()).toBe(false);

    // Present and valid: both pass.
    expect(await pass({ code: "x" }, a)).toEqual({ code: "x" });
    expect(await pass({ code: "x" }, b)).toEqual({ code: "x" });
  });
});

describe("in()/notIn() reject non-scalars", () => {
  it("an array never passes in() and never reaches validated()", async () => {
    const v = new Validator({ role: ["admin"] }, {}, { role: rule().in(["admin", "user"]) });
    expect(await v.passes()).toBe(false);
  });

  it("notIn() also rejects a non-scalar value", async () => {
    const v = new Validator({ role: { a: 1 } }, {}, { role: rule().notIn(["x"]) });
    expect(await v.passes()).toBe(false);
  });

  it("in() compares strictly. A string does not match a numeric list member", async () => {
    // Bidirectional String() coercion would let "1" satisfy in([1]).
    const asString = new Validator({ n: "1" }, {}, { n: rule().in([1, 2, 3]) });
    expect(await asString.passes()).toBe(false);

    const asNumber = new Validator({ n: 1 }, {}, { n: rule().in([1, 2, 3]) });
    expect(await asNumber.passes()).toBe(true);
  });

  it("in() compares strictly. A number does not match a string list member", async () => {
    const v = new Validator({ n: 1 }, {}, { n: rule().in(["1", "2"]) });
    expect(await v.passes()).toBe(false);
  });

  it("notIn() compares strictly. A string is not excluded by a numeric list member", async () => {
    // "1" is NOT in [1], so notIn([1]) must pass it.
    const v = new Validator({ n: "1" }, {}, { n: rule().notIn([1, 2]) });
    expect(await v.passes()).toBe(true);
  });
});

describe("validated() guards", () => {
  it("throws a ValidationException when called after a failure", async () => {
    const v = new Validator({}, {}, { name: rule().string().required() });
    expect(await v.passes()).toBe(false);
    expect(() => v.validated()).toThrow(ValidationException);
  });

  it("throws when called before passes()", () => {
    const v = new Validator({ name: "x" }, {}, { name: rule().string().required() });
    expect(() => v.validated()).toThrow(/before passes\(\)/);
  });

  it("does not leak a raw invalid nested item into validated()", async () => {
    const v = new Validator(
      { tags: ["ok", ""] },
      {},
      { tags: rule().array(rule().string().required()) },
    );
    expect(await v.passes()).toBe(false);
    expect(() => v.validated()).toThrow(ValidationException);
  });
});

describe("concurrent validations on a shared rule", () => {
  it("does not leak steps or state between validators", async () => {
    let spamResolve!: () => void;
    const gate = new Promise<void>((r) => (spamResolve = r));

    class SlowNoSpam extends ValidationRule {
      async run(_attribute: string, value: unknown): Promise<this> {
        await gate;

        if (typeof value === "string" && value.includes("spam")) {
          return this.fail("spam");
        }

        return this.pass();
      }
    }

    const shared = rule().string().rule(new SlowNoSpam());
    const good = new Validator({ v: "hello" }, {}, { v: shared });
    const bad = new Validator({ v: "spam" }, {}, { v: shared });

    const goodP = good.passes();
    const badP = bad.passes();
    spamResolve();
    expect(await goodP).toBe(true);
    expect(await badP).toBe(false);
  });

  it("re-validating with the same rule object twice is independent", async () => {
    const shared = rule().string().min(3);
    expect(await new Validator({ v: "ab" }, {}, { v: shared }).passes()).toBe(false);
    expect(await new Validator({ v: "abc" }, {}, { v: shared }).passes()).toBe(true);
  });
});

describe("required_if loose scalar compare", () => {
  it("matches a form-encoded '1' against a numeric literal", async () => {
    const rules = {
      type: rule().string(),
      code: rule().string().optional().requiredIf("type", 1),
    };
    const v = new Validator({ type: "1" }, {}, rules);
    expect(await v.passes()).toBe(false);
    expect(v.errors().code).toBeTruthy();
  });

  it("requiredUnless matches loosely too", async () => {
    const rules = {
      type: rule().string(),
      code: rule().string().optional().requiredUnless("type", 1),
    };
    // type === "1" ~ 1, so NOT required.
    expect(await new Validator({ type: "1" }, {}, rules).passes()).toBe(true);
  });
});

describe("confirmed() sibling resolution", () => {
  it("works inside object()", async () => {
    const rules = {
      account: objectRule({
        password: rule().string().required().confirmed(),
        password_confirmation: rule().string().required(),
      }),
    };
    const ok = new Validator(
      { account: { password: "secret", password_confirmation: "secret" } },
      {},
      rules,
    );
    expect(await ok.passes()).toBe(true);

    const bad = new Validator(
      { account: { password: "secret", password_confirmation: "nope" } },
      {},
      rules,
    );
    expect(await bad.passes()).toBe(false);
  });

  it("still works at the top level", async () => {
    const rules = {
      password: rule().string().required().confirmed(),
      password_confirmation: rule().string().required(),
    };
    expect(
      await new Validator({ password: "a", password_confirmation: "a" }, {}, rules).passes(),
    ).toBe(true);
    expect(
      await new Validator({ password: "a", password_confirmation: "b" }, {}, rules).passes(),
    ).toBe(false);
  });
});

describe("string content rules", () => {
  it("alpha", async () => {
    expect(await new Validator({ v: "abcABC" }, {}, { v: rule().string().alpha() }).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: "abc1" }, {}, { v: rule().string().alpha() }).passes()).toBe(
      false,
    );
  });

  it("alphaNum", async () => {
    expect(
      await new Validator({ v: "abc123" }, {}, { v: rule().string().alphaNum() }).passes(),
    ).toBe(true);
    expect(
      await new Validator({ v: "abc-123" }, {}, { v: rule().string().alphaNum() }).passes(),
    ).toBe(false);
  });

  it("digits", async () => {
    expect(await new Validator({ v: "1234" }, {}, { v: rule().digits(4) }).passes()).toBe(true);
    expect(await new Validator({ v: "123" }, {}, { v: rule().digits(4) }).passes()).toBe(false);
  });

  it("digitsBetween", async () => {
    expect(await new Validator({ v: "123" }, {}, { v: rule().digitsBetween(2, 4) }).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: "1" }, {}, { v: rule().digitsBetween(2, 4) }).passes()).toBe(
      false,
    );
  });

  it("json", async () => {
    expect(await new Validator({ v: '{"a":1}' }, {}, { v: rule().json() }).passes()).toBe(true);
    expect(await new Validator({ v: "{bad}" }, {}, { v: rule().json() }).passes()).toBe(false);
  });
});

describe("network rules", () => {
  it("ip / ipv4 / ipv6", async () => {
    expect(await new Validator({ v: "192.168.0.1" }, {}, { v: rule().ipv4() }).passes()).toBe(true);
    expect(await new Validator({ v: "999.0.0.1" }, {}, { v: rule().ipv4() }).passes()).toBe(false);
    expect(await new Validator({ v: "::1" }, {}, { v: rule().ipv6() }).passes()).toBe(true);
    expect(await new Validator({ v: "2001:db8::1" }, {}, { v: rule().ip() }).passes()).toBe(true);
    expect(await new Validator({ v: "192.168.0.1" }, {}, { v: rule().ip() }).passes()).toBe(true);
    expect(await new Validator({ v: "nope" }, {}, { v: rule().ip() }).passes()).toBe(false);
  });

  it("timezone", async () => {
    expect(
      await new Validator({ v: "Australia/Perth" }, {}, { v: rule().timezone() }).passes(),
    ).toBe(true);
    expect(await new Validator({ v: "Mars/Phobos" }, {}, { v: rule().timezone() }).passes()).toBe(
      false,
    );
  });
});

describe("date rules", () => {
  it("date", async () => {
    expect(await new Validator({ v: "2026-01-01" }, {}, { v: rule().date() }).passes()).toBe(true);
    expect(await new Validator({ v: "not-a-date" }, {}, { v: rule().date() }).passes()).toBe(false);
  });

  it("date accepts ISO date-times but rejects Date.parse's loose inputs", async () => {
    const dateRule = { v: rule().date() };
    // Valid ISO shapes.
    expect(await new Validator({ v: "2026-03-15T09:30:00" }, {}, dateRule).passes()).toBe(true);
    expect(await new Validator({ v: "2026-03-15 09:30:00" }, {}, dateRule).passes()).toBe(true);
    expect(await new Validator({ v: "2026-03-15T09:30:00Z" }, {}, dateRule).passes()).toBe(true);
    expect(await new Validator({ v: "2026-03-15T09:30:00+13:00" }, {}, dateRule).passes()).toBe(
      true,
    );

    // Inputs Date.parse would have accepted but Laravel's `date` rejects.
    for (const bad of ["2024", "garbage 2024", "March 15, 2024", "2024-13-40"]) {
      expect(await new Validator({ v: bad }, {}, dateRule).passes()).toBe(false);
    }
  });

  it("dateFormat", async () => {
    expect(
      await new Validator({ v: "2026-01-31" }, {}, { v: rule().dateFormat("YYYY-MM-DD") }).passes(),
    ).toBe(true);
    expect(
      await new Validator({ v: "31/01/2026" }, {}, { v: rule().dateFormat("YYYY-MM-DD") }).passes(),
    ).toBe(false);
  });

  it("after / before with a literal date", async () => {
    const rules = { v: rule().date().after("2026-01-01") };
    expect(await new Validator({ v: "2026-02-01" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "2025-12-01" }, {}, rules).passes()).toBe(false);

    const bRules = { v: rule().date().before("2026-01-01") };
    expect(await new Validator({ v: "2025-12-01" }, {}, bRules).passes()).toBe(true);
  });

  it("afterOrEqual / beforeOrEqual", async () => {
    expect(
      await new Validator(
        { v: "2026-01-01" },
        {},
        { v: rule().date().afterOrEqual("2026-01-01") },
      ).passes(),
    ).toBe(true);
    expect(
      await new Validator(
        { v: "2026-01-01" },
        {},
        { v: rule().date().beforeOrEqual("2026-01-01") },
      ).passes(),
    ).toBe(true);
  });

  it("after can reference another field", async () => {
    const rules = { start: rule().date(), end: rule().date().after("start") };
    expect(
      await new Validator({ start: "2026-01-01", end: "2026-02-01" }, {}, rules).passes(),
    ).toBe(true);
    expect(
      await new Validator({ start: "2026-01-01", end: "2025-01-01" }, {}, rules).passes(),
    ).toBe(false);
  });
});

describe("size and comparison rules", () => {
  it("size on strings, numbers, arrays", async () => {
    expect(await new Validator({ v: "abcde" }, {}, { v: rule().string().size(5) }).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: 5 }, {}, { v: numberRule().size(5) }).passes()).toBe(true);
    expect(await new Validator({ v: [1, 2] }, {}, { v: rule().array().size(2) }).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: "ab" }, {}, { v: rule().string().size(5) }).passes()).toBe(
      false,
    );
  });

  it("gt / gte / lt / lte compare to another field", async () => {
    const rules = { min: numberRule(), max: numberRule().gt("min") };
    expect(await new Validator({ min: 1, max: 5 }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ min: 5, max: 5 }, {}, rules).passes()).toBe(false);

    const gteRules = { min: numberRule(), max: numberRule().gte("min") };
    expect(await new Validator({ min: 5, max: 5 }, {}, gteRules).passes()).toBe(true);

    const ltRules = { a: numberRule(), b: numberRule().lt("a") };
    expect(await new Validator({ a: 5, b: 1 }, {}, ltRules).passes()).toBe(true);
    expect(await new Validator({ a: 1, b: 5 }, {}, ltRules).passes()).toBe(false);
  });
});

describe("accepted / declined", () => {
  it("accepted", async () => {
    expect(await new Validator({ tos: "yes" }, {}, { tos: rule().accepted() }).passes()).toBe(true);
    expect(await new Validator({ tos: true }, {}, { tos: rule().accepted() }).passes()).toBe(true);
    expect(await new Validator({ tos: "no" }, {}, { tos: rule().accepted() }).passes()).toBe(false);
  });

  it("declined", async () => {
    expect(await new Validator({ x: "no" }, {}, { x: rule().declined() }).passes()).toBe(true);
    expect(await new Validator({ x: "yes" }, {}, { x: rule().declined() }).passes()).toBe(false);
  });
});

describe("prohibited rules", () => {
  it("prohibited fails when a value is present", async () => {
    expect(await new Validator({ x: "v" }, {}, { x: rule().prohibited() }).passes()).toBe(false);
    expect(await new Validator({}, {}, { x: rule().prohibited() }).passes()).toBe(true);
  });

  it("prohibitedIf and the field is dropped from validated()", async () => {
    const rules = {
      type: rule().string(),
      x: rule().string().optional().prohibitedIf("type", "guest"),
    };
    const bad = new Validator({ type: "guest", x: "v" }, {}, rules);
    expect(await bad.passes()).toBe(false);

    const ok = new Validator({ type: "member", x: "v" }, {}, rules);
    expect(await ok.passes()).toBe(true);
  });

  it("prohibitedUnless", async () => {
    const rules = {
      type: rule().string(),
      x: rule().string().optional().prohibitedUnless("type", "member"),
    };
    expect(await new Validator({ type: "guest", x: "v" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ type: "member", x: "v" }, {}, rules).passes()).toBe(true);
  });
});

describe("distinct / requiredArrayKeys", () => {
  it("distinct rejects duplicates", async () => {
    expect(
      await new Validator({ v: [1, 2, 3] }, {}, { v: rule().array().distinct() }).passes(),
    ).toBe(true);
    expect(
      await new Validator({ v: [1, 2, 2] }, {}, { v: rule().array().distinct() }).passes(),
    ).toBe(false);
  });

  it("distinct ignoreCase", async () => {
    const rules = { v: rule().array().distinct({ ignoreCase: true }) };
    expect(await new Validator({ v: ["a", "A"] }, {}, rules).passes()).toBe(false);
  });

  it("requiredArrayKeys", async () => {
    const rules = { v: rule().requiredArrayKeys("a", "b") };
    expect(await new Validator({ v: { a: 1, b: 2 } }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: { a: 1 } }, {}, rules).passes()).toBe(false);
  });
});

describe("exclude rules", () => {
  it("exclude drops the field from validated()", async () => {
    expect(
      await pass({ x: "v", y: "keep" }, { x: rule().string().exclude(), y: rule().string() }),
    ).toEqual({
      y: "keep",
    });
  });

  it("excludeIf drops conditionally", async () => {
    const rules = {
      role: rule().string(),
      code: rule().string().optional().excludeIf("role", "guest"),
    };
    expect(await pass({ role: "guest", code: "abc" }, rules)).toEqual({ role: "guest" });
    expect(await pass({ role: "admin", code: "abc" }, rules)).toEqual({
      role: "admin",
      code: "abc",
    });
  });

  it("excludeUnless drops unless condition holds", async () => {
    const rules = {
      role: rule().string(),
      code: rule().string().optional().excludeUnless("role", "admin"),
    };
    expect(await pass({ role: "guest", code: "abc" }, rules)).toEqual({ role: "guest" });
    expect(await pass({ role: "admin", code: "abc" }, rules)).toEqual({
      role: "admin",
      code: "abc",
    });
  });
});

describe("custom messages on list rules", () => {
  it("requiredWith accepts an array form with a message", async () => {
    const rules = {
      a: rule().string().optional(),
      b: rule().string().optional().requiredWith(["a"], "b is needed with a"),
    };
    const v = new Validator({ a: "x" }, {}, rules);
    expect(await v.passes()).toBe(false);
    expect(v.errors().b?.[0]).toBe("b is needed with a");
  });

  it("requiredWith still supports the variadic form", async () => {
    const rules = {
      a: rule().string().optional(),
      b: rule().string().optional().requiredWith("a"),
    };
    expect(await new Validator({ a: "x" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({}, {}, rules).passes()).toBe(true);
  });

  it("mimes accepts an array form with a message", async () => {
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const v = new Validator({}, { doc: file }, { doc: fileRule().mimes(["pdf"], "PDF only") });
    await v.passes();
    expect(v.errors().doc?.[0]).toBe("PDF only");
  });
});

describe("uuid", () => {
  it("accepts any version with an RFC 4122 variant nibble", async () => {
    for (const good of [
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", // v4
      "018e4c7a-9f2b-7c3d-8e1f-1a2b3c4d5e6f", // v7
      "9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D", // case-insensitive
    ]) {
      expect(await new Validator({ v: good }, {}, { v: rule().string().uuid() }).passes()).toBe(
        true,
      );
    }
  });

  it("rejects a wrong variant nibble, and with it the nil and max UUIDs", async () => {
    // A consequence of the `[89ab]` variant check rather than a separate
    // rule: the all-zero and all-f UUIDs are RFC-defined but carry no
    // variant, so they fail. In request input either is far more likely to
    // be an uninitialised value than a deliberate one. Laravel accepts nil;
    // this deliberately does not.
    for (const bad of [
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "9b1deb4d-3b7d-4bad-cbdd-2b0d7b3dcb6d", // variant "c"
    ]) {
      expect(await new Validator({ v: bad }, {}, { v: rule().string().uuid() }).passes()).toBe(
        false,
      );
    }
  });

  it("rejects malformed shapes", async () => {
    for (const bad of [
      "9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d", // unhyphenated
      "{9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d}", // braced
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6", // too short
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6dd", // too long
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6g", // non-hex
      "",
    ]) {
      expect(await new Validator({ v: bad }, {}, { v: rule().string().uuid() }).passes()).toBe(
        false,
      );
    }
  });
});

describe("ulid", () => {
  it("accepts a canonical ULID, in either case", async () => {
    for (const good of ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01arz3ndektsv4rrffq69g5fav"]) {
      expect(await new Validator({ v: good }, {}, { v: rule().string().ulid() }).passes()).toBe(
        true,
      );
    }
  });

  it("rejects the Crockford-excluded letters I, L, O and U", async () => {
    for (const letter of ["I", "L", "O", "U", "i", "l", "o", "u"]) {
      const bad = `0${letter}ARZ3NDEKTSV4RRFFQ69G5FAV`;
      expect(bad).toHaveLength(26);
      expect(await new Validator({ v: bad }, {}, { v: rule().string().ulid() }).passes()).toBe(
        false,
      );
    }
  });

  it("rejects a timestamp that cannot be decoded", async () => {
    // These are 26 legal Crockford characters, so a length-and-charset
    // check passes them. The first character carries the high bits of a
    // 48-bit ms timestamp, so anything above "7" describes a time that
    // cannot exist.
    for (const bad of ["ZZZZZZZZZZZZZZZZZZZZZZZZZZ", "8ZZZZZZZZZZZZZZZZZZZZZZZZZ"]) {
      expect(bad).toHaveLength(26);
      expect(await new Validator({ v: bad }, {}, { v: rule().string().ulid() }).passes()).toBe(
        false,
      );
    }

    // The boundary itself stays valid.
    expect(
      await new Validator(
        { v: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" },
        {},
        { v: rule().string().ulid() },
      ).passes(),
    ).toBe(true);
  });

  it("rejects the wrong length", async () => {
    for (const bad of ["01ARZ3NDEKTSV4RRFFQ69G5FA", "01ARZ3NDEKTSV4RRFFQ69G5FAVV", ""]) {
      expect(await new Validator({ v: bad }, {}, { v: rule().string().ulid() }).passes()).toBe(
        false,
      );
    }
  });
});

describe("url", () => {
  it("accepts http and https", async () => {
    for (const good of [
      "https://example.com",
      "http://example.com/a/b?c=1#d",
      "HTTPS://EXAMPLE.COM",
      "https://user:pass@example.com:8443/x",
    ]) {
      expect(await new Validator({ v: good }, {}, { v: rule().string().url() }).passes()).toBe(
        true,
      );
    }
  });

  it("rejects dangerous schemes by default", async () => {
    // Every one of these parses as a valid absolute URL. A validated URL
    // rendered into an href is the textbook stored-XSS path, so parsing
    // alone is not validation.
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "about:blank",
      "foo:bar",
    ]) {
      expect(await new Validator({ v: bad }, {}, { v: rule().string().url() }).passes()).toBe(
        false,
      );
    }
  });

  it("rejects relative and unparseable values", async () => {
    for (const bad of ["example.com", "//example.com", "/relative", "not a url", ""]) {
      expect(await new Validator({ v: bad }, {}, { v: rule().string().url() }).passes()).toBe(
        false,
      );
    }
  });

  it("narrows the allowed schemes when asked", async () => {
    const httpsOnly = { v: rule().string().url(["https"]) };
    expect(await new Validator({ v: "https://example.com" }, {}, httpsOnly).passes()).toBe(true);
    expect(await new Validator({ v: "http://example.com" }, {}, httpsOnly).passes()).toBe(false);
  });

  it("can opt a non-web scheme back in", async () => {
    const withMailto = { v: rule().string().url(["https", "mailto"]) };
    expect(await new Validator({ v: "mailto:ada@example.com" }, {}, withMailto).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: "javascript:alert(1)" }, {}, withMailto).passes()).toBe(false);
  });

  it("still reports a custom message in either call form", async () => {
    const a = new Validator({ v: "nope" }, {}, { v: rule().string().url("Bad link.") });
    await a.passes();
    expect(a.errors().v?.[0]).toBe("Bad link.");

    const b = new Validator({ v: "nope" }, {}, { v: rule().string().url(["https"], "Bad link.") });
    await b.passes();
    expect(b.errors().v?.[0]).toBe("Bad link.");
  });
});

describe("alphaDash", () => {
  it("accepts letters, numbers, dashes and underscores", async () => {
    expect(
      await new Validator({ v: "abc-123_XYZ" }, {}, { v: rule().string().alphaDash() }).passes(),
    ).toBe(true);
  });

  it("is ASCII-only, unlike Laravel's Unicode-aware rule", async () => {
    // Pinned because it is a deliberate divergence, and because "fixing" it
    // to \p{L} would silently widen every field using this rule.
    for (const bad of ["héllo", "ábc", "日本", "ＡＢＣ"]) {
      expect(await new Validator({ v: bad }, {}, { v: rule().string().alphaDash() }).passes()).toBe(
        false,
      );
    }
  });

  it("rejects a trailing newline", async () => {
    // Guard against a naive port of PHP's `$`, which matches before a final
    // newline and would let "abc\n" through. JS `$` (no `m` flag) does not.
    expect(
      await new Validator({ v: "abc\n" }, {}, { v: rule().string().alphaDash() }).passes(),
    ).toBe(false);
  });

  it("rejects an empty string, and requires no letter", async () => {
    expect(await new Validator({ v: "" }, {}, { v: rule().string().alphaDash() }).passes()).toBe(
      false,
    );
    expect(
      await new Validator({ v: "--__" }, {}, { v: rule().string().alphaDash() }).passes(),
    ).toBe(true);
  });
});

describe("lowercase / uppercase", () => {
  it("compares the value against its own case conversion", async () => {
    expect(await new Validator({ v: "abc" }, {}, { v: rule().string().lowercase() }).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: "aBc" }, {}, { v: rule().string().lowercase() }).passes()).toBe(
      false,
    );
    expect(await new Validator({ v: "ABC" }, {}, { v: rule().string().uppercase() }).passes()).toBe(
      true,
    );
    expect(await new Validator({ v: "AbC" }, {}, { v: rule().string().uppercase() }).passes()).toBe(
      false,
    );
  });

  it("passes a caseless string on both rules", async () => {
    // A string with no case cannot be the wrong case, so both rules accept
    // it. Surprising enough to pin. A reader may expect uppercase() to
    // demand at least one letter.
    for (const caseless of ["123", "日本語", "😀", "-_-"]) {
      expect(
        await new Validator({ v: caseless }, {}, { v: rule().string().lowercase() }).passes(),
      ).toBe(true);
      expect(
        await new Validator({ v: caseless }, {}, { v: rule().string().uppercase() }).passes(),
      ).toBe(true);
    }
  });

  it('treats "" as missing, so the presence rule decides, not the case rule', async () => {
    // Not a case check at all: the default presence is `required`, and an
    // empty string counts as absent. The failure says "is required", which
    // is worth pinning because the obvious reading of a `lowercase()`
    // failure on "" would be that the rule rejected it.
    const required = new Validator({ v: "" }, {}, { v: rule().string().lowercase() });
    expect(await required.passes()).toBe(false);
    expect(required.errors().v?.[0]).toMatch(/required/);

    expect(
      await new Validator({ v: "" }, {}, { v: rule().string().optional().lowercase() }).passes(),
    ).toBe(true);
  });

  it("handles non-ASCII case correctly", async () => {
    expect(
      await new Validator({ v: "ünïcode" }, {}, { v: rule().string().lowercase() }).passes(),
    ).toBe(true);
    expect(
      await new Validator({ v: "ÜNÏCODE" }, {}, { v: rule().string().uppercase() }).passes(),
    ).toBe(true);
    expect(await new Validator({ v: "абв" }, {}, { v: rule().string().lowercase() }).passes()).toBe(
      true,
    );
  });

  it("fails both rules for a titlecase character", async () => {
    // U+01C5 is neither upper nor lower, so unlike a caseless string it
    // satisfies neither rule.
    expect(await new Validator({ v: "ǅ" }, {}, { v: rule().string().lowercase() }).passes()).toBe(
      false,
    );
    expect(await new Validator({ v: "ǅ" }, {}, { v: rule().string().uppercase() }).passes()).toBe(
      false,
    );
  });

  it("uses locale-invariant conversion", async () => {
    // toUpperCase(), not toLocaleUpperCase(): the Turkish dotless ı
    // uppercases to "I" everywhere, so behaviour cannot shift with the
    // host locale. A "fix" to the locale-aware form would break this.
    expect(await new Validator({ v: "ı" }, {}, { v: rule().string().lowercase() }).passes()).toBe(
      true,
    );
    // ß uppercases to "SS". A lowercase ß can never satisfy uppercase().
    expect(await new Validator({ v: "ß" }, {}, { v: rule().string().uppercase() }).passes()).toBe(
      false,
    );
    expect(await new Validator({ v: "ß" }, {}, { v: rule().string().lowercase() }).passes()).toBe(
      true,
    );
  });

  it("rejects a non-string", async () => {
    expect(await new Validator({ v: ["AB"] }, {}, { v: rule().lowercase() }).passes()).toBe(false);
  });
});

describe("enum", () => {
  // The shape TypeScript actually compiles a numeric enum to: both
  // directions in one object. Written out literally because that is the
  // whole point of the test, `enum Priority { Low, High }` looks like it
  // has two members and has four entries.
  const NumericPriority = { Low: 0, High: 1, 0: "Low", 1: "High" } as const;
  const StringStatus = { Draft: "draft", Live: "live" } as const;

  it("accepts a string enum's values and rejects its keys", async () => {
    const rules = { v: rule().enum(StringStatus) };

    expect(await new Validator({ v: "draft" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "live" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "Draft" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ v: "archived" }, {}, rules).passes()).toBe(false);
  });

  it("accepts a numeric enum's values", async () => {
    const rules = { v: rule().enum(NumericPriority) };

    expect(await new Validator({ v: 0 }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: 1 }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: 2 }, {}, rules).passes()).toBe(false);
  });

  it("rejects a numeric enum's reverse-mapping keys", async () => {
    // `Object.values({ Low: 0, High: 1, 0: "Low", 1: "High" })` is
    // `["Low", "High", 0, 1]`, so a naive membership check accepts the KEY
    // "High" as a member, outside the declared `E[keyof E]` type, and a
    // value the enum can never actually hold.
    const rules = { v: rule().enum(NumericPriority) };

    expect(await new Validator({ v: "Low" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ v: "High" }, {}, rules).passes()).toBe(false);
  });

  it("does not coerce, matching the documented strictness", async () => {
    // The docs promise `enum()` is strict where a loose rule would accept
    // "1" for 1. Form-encoded input needs a coercing rule first.
    expect(await new Validator({ v: "1" }, {}, { v: rule().enum(NumericPriority) }).passes()).toBe(
      false,
    );
    expect(
      await new Validator({ v: "1" }, {}, { v: rule().integer().enum(NumericPriority) }).passes(),
    ).toBe(true);
  });

  it("keeps a string enum whose keys look numeric", async () => {
    // The reverse-mapping filter must not eat this: "0" is a key and
    // "zero" is its value, but "zero" is not itself a key mapping back to
    // 0, so there is no round trip and nothing to strip.
    const Weird = { "0": "zero", "1": "one" } as const;

    expect(await new Validator({ v: "zero" }, {}, { v: rule().enum(Weird) }).passes()).toBe(true);
    expect(await new Validator({ v: 0 }, {}, { v: rule().enum(Weird) }).passes()).toBe(false);
  });
});

describe("same / different", () => {
  it("same() compares against another field", async () => {
    const rules = {
      password: rule().string().required(),
      other: rule().string().required().same("password"),
    };

    expect(await new Validator({ password: "secret", other: "secret" }, {}, rules).passes()).toBe(
      true,
    );
    expect(await new Validator({ password: "secret", other: "typo" }, {}, rules).passes()).toBe(
      false,
    );
  });

  it('same() is strict, so 1 does not satisfy "1"', async () => {
    const rules = { a: rule().optional(), b: rule().optional().same("a") };

    expect(await new Validator({ a: 1, b: "1" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ a: 1, b: 1 }, {}, rules).passes()).toBe(true);
  });

  it("different() is the inverse", async () => {
    const rules = {
      current: rule().string().required(),
      next: rule().string().required().different("current"),
    };

    expect(await new Validator({ current: "old", next: "new" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ current: "old", next: "old" }, {}, rules).passes()).toBe(false);
  });

  it("names the other field in the message", async () => {
    const v = new Validator(
      { password: "secret", confirm: "typo" },
      {},
      { confirm: rule().string().same("password") },
    );
    await v.passes();

    expect(v.errors().confirm?.[0]).toMatch(/password/);
  });
});

describe("between and lte", () => {
  it("between() bounds a number inclusively", async () => {
    const rules = { v: numberRule().between(10, 20) };

    for (const good of [10, 15, 20]) {
      expect(await new Validator({ v: good }, {}, rules).passes()).toBe(true);
    }

    for (const bad of [9, 21]) {
      expect(await new Validator({ v: bad }, {}, rules).passes()).toBe(false);
    }
  });

  it("between() measures a string's length", async () => {
    const rules = { v: rule().string().between(3, 5) };

    expect(await new Validator({ v: "abc" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "abcde" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "ab" }, {}, rules).passes()).toBe(false);
    expect(await new Validator({ v: "abcdef" }, {}, rules).passes()).toBe(false);
  });

  it("lte() completes the gt/gte/lt/lte set", async () => {
    const rules = { a: numberRule(), b: numberRule().lte("a") };

    expect(await new Validator({ a: 5, b: 4 }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ a: 5, b: 5 }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ a: 5, b: 6 }, {}, rules).passes()).toBe(false);
  });
});

describe("filled and present", () => {
  it("filled() only complains when the key exists but is empty", async () => {
    const rules = { v: rule().string().optional().filled() };

    expect(await new Validator({}, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "x" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "" }, {}, rules).passes()).toBe(false);
  });

  it("present() demands the key but allows it to be empty", async () => {
    // The mirror image of filled(), and the pair is easy to confuse.
    // Note it is NOT combined with optional() here. See the next test.
    const rules = { v: rule().nullable().present() };

    expect(await new Validator({ v: "" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({}, {}, rules).passes()).toBe(false);
  });

  it("optional() defeats present(), which reads like it should not", async () => {
    // A trap worth pinning. `optional()` skips every remaining step when
    // the key is missing, so `present()` never runs and the combination
    // silently asserts nothing at all. It is a contradiction ("may be
    // absent" + "must be present") that fails open rather than erroring.
    expect(await new Validator({}, {}, { v: rule().optional().present() }).passes()).toBe(true);

    // Order does not rescue it either.
    expect(await new Validator({}, {}, { v: rule().present().optional() }).passes()).toBe(true);
  });
});

describe("requiredWithout and unless", () => {
  it("requiredWithout() fires when the other field is absent", async () => {
    const rules = {
      email: rule().string().optional(),
      phone: rule().string().optional().requiredWithout("email"),
    };

    expect(await new Validator({ email: "a@b.com" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ phone: "123" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({}, {}, rules).passes()).toBe(false);
  });

  it("unless() applies its branch when the condition is false", async () => {
    // The condition is evaluated once at BUILD time, against the rule,
    // not per-request against the data. So this composes rules, it does
    // not branch on payload. (`requiredIf`/`prohibitedIf` are the
    // data-driven ones.)
    const applied = {
      v: rule()
        .string()
        .optional()
        .unless(false, (r) => r.min(5)),
    };
    const skipped = {
      v: rule()
        .string()
        .optional()
        .unless(true, (r) => r.min(5)),
    };

    expect(await new Validator({ v: "abc" }, {}, applied).passes()).toBe(false);
    expect(await new Validator({ v: "abcdef" }, {}, applied).passes()).toBe(true);
    expect(await new Validator({ v: "abc" }, {}, skipped).passes()).toBe(true);
  });

  it("unless() takes the otherwise branch when the condition is true", async () => {
    const rules = {
      v: rule()
        .string()
        .optional()
        .unless(
          true,
          (r) => r.min(5),
          (r) => r.max(2),
        ),
    };

    expect(await new Validator({ v: "ab" }, {}, rules).passes()).toBe(true);
    expect(await new Validator({ v: "abc" }, {}, rules).passes()).toBe(false);
  });
});

describe("distinct strict mode", () => {
  it("compares loosely by default and strictly on request", async () => {
    // The `strict` branch had no coverage; only ignoreCase did.
    const loose = { v: rule().array(rule()).distinct() };
    const strict = { v: rule().array(rule()).distinct({ strict: true }) };

    expect(await new Validator({ v: [1, "1"] }, {}, loose).passes()).toBe(false);
    expect(await new Validator({ v: [1, "1"] }, {}, strict).passes()).toBe(true);
    expect(await new Validator({ v: [1, 1] }, {}, strict).passes()).toBe(false);
  });
});
