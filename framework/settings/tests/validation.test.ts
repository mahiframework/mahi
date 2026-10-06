import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB } from "@mahiframework/database";
import { Rule, ValidationException } from "@mahiframework/validation";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("type validation", () => {
  it("rejects a value of the wrong type", async () => {
    const error = await captureError(harness.registry.set("app_name", 42));

    expect(error).toBeInstanceOf(ValidationException);
    expect((error as ValidationException).errors["app_name"]).toEqual([
      "The app name field must be a string.",
    ]);
  });

  it("names the field using the setting's own key", async () => {
    // The setting name IS the validator key, so `humanize()` produces a
    // readable message with no per-setting label to maintain.
    const error = await captureError(harness.registry.set("import_batch_size", "not a number"));

    expect((error as ValidationException).errors["import_batch_size"]).toEqual([
      "The import batch size field must be a number.",
    ]);
  });

  it("rejects null, since a setting always has a value", async () => {
    // "Unset" is expressed by deleting the row, not by storing a null.
    // Allowing both would be a third state to reconcile on every read.
    const error = await captureError(harness.registry.set("app_name", null));

    expect(error).toBeInstanceOf(ValidationException);
  });

  it("surfaces as a 422 through the HTTP error handler", () => {
    // Not an HTTP test — just pinning that the exception this throws is
    // the one the handler already renders with a per-field bag, which is
    // what lets an app's settings endpoint report form errors without
    // this package knowing about HTTP.
    const exception = new ValidationException({ app_name: ["nope"] });

    expect(exception.status).toBe(422);
  });
});

describe("definition rules", () => {
  it("applies a definition's own constraints on top of the type", async () => {
    const error = await captureError(harness.registry.set("import_batch_size", 5000));

    expect((error as ValidationException).errors["import_batch_size"]).toEqual([
      "The import batch size field must not be greater than 1000.",
    ]);
  });

  it("accepts a value inside the constraints", async () => {
    await harness.registry.set("import_batch_size", 500);

    expect(await harness.registry.get("import_batch_size")).toBe(500);
  });

  it("reports only the type failure when the type is wrong", async () => {
    // The validator skips constraint steps once a type step fails, so a
    // caller is not told a string is "less than 1" as well as "not a
    // number".
    const error = await captureError(harness.registry.set("import_batch_size", "abc"));

    expect((error as ValidationException).errors["import_batch_size"]).toHaveLength(1);
  });

  it("builds a fresh rule per validation, so steps do not accumulate", async () => {
    // `Rule` is mutable: every chain call pushes onto the instance. A
    // definition sharing one instance would grow its step list on every
    // write, so `rules` is a thunk. Three writes, each reporting exactly
    // one error, is what proves it.
    for (const attempt of [2000, 3000, 4000]) {
      const error = await captureError(harness.registry.set("import_batch_size", attempt));

      expect((error as ValidationException).errors["import_batch_size"]).toHaveLength(1);
    }
  });
});

describe("batch writes", () => {
  it("writes nothing when any value in the batch is invalid", async () => {
    // Validation happens for the whole batch before any row is written,
    // so a rejected field in an admin form cannot leave the store
    // half-updated.
    const error = await captureError(
      harness.registry.setMany({ app_name: "Valid", import_batch_size: 99_999 }),
    );

    expect(error).toBeInstanceOf(ValidationException);
    expect(await DB.table("settings").get()).toHaveLength(0);
    expect(await harness.registry.get("app_name")).toBe("Mahi");
  });

  it("reports every invalid field at once", async () => {
    const error = await captureError(
      harness.registry.setMany({ app_name: 1, import_batch_size: "x" }),
    );

    expect(Object.keys((error as ValidationException).errors).sort()).toEqual([
      "app_name",
      "import_batch_size",
    ]);
  });

  it("writes every value when all of them pass", async () => {
    await harness.registry.setMany({ app_name: "Valid", import_batch_size: 7 });

    expect(await harness.registry.get("app_name")).toBe("Valid");
    expect(await harness.registry.get("import_batch_size")).toBe(7);
  });
});

describe("empty values", () => {
  it("accepts an empty string, which a required rule would reject", async () => {
    // The type rules are `optional()`, not `required()`, precisely
    // because `required` fails on `isEmpty()` — which counts `""` and
    // `[]` as empty. Both are legitimate setting values.
    const harnessWithString = await createHarness({
      definitions: [{ name: "banner", type: "string", defaultValue: () => "hello" }],
    });

    await harnessWithString.registry.set("banner", "");

    expect(await harnessWithString.registry.get("banner")).toBe("");

    harnessWithString.cleanup();
  });

  it("lets a definition opt into requiring a non-empty value", async () => {
    // The default is permissive; a setting that genuinely must not be
    // blank says so in its own rules.
    const strict = await createHarness({
      definitions: [
        {
          name: "support_email",
          type: "string",
          rules: () => Rule.make().required(),
          defaultValue: () => "help@example.test",
        },
      ],
    });

    expect(await captureError(strict.registry.set("support_email", ""))).toBeInstanceOf(
      ValidationException,
    );

    strict.cleanup();
  });
});
