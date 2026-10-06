import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB } from "@mahiframework/database";
import { DateTime } from "@mahiframework/datetime";
import { UnknownSettingError } from "../src/errors.js";
import { createHarness, captureError, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("reading", () => {
  it("falls back to the declared default when nothing is stored", async () => {
    expect(await harness.registry.get("app_name")).toBe("Mahi");
    expect(await harness.registry.get("import_batch_size")).toBe(100);
    expect(await harness.registry.get("import_feature_enabled")).toBe(false);
  });

  it("calls defaultValue() per read, so an object default is never shared", async () => {
    const first = (await harness.registry.get("branding")) as Record<string, string>;
    const second = (await harness.registry.get("branding")) as Record<string, string>;

    first["primary"] = "#ffffff";

    // The whole reason `defaultValue` is a thunk: a shared reference
    // would let one caller's mutation become everybody's default, for
    // the lifetime of the process.
    expect(second["primary"]).toBe("#000000");
  });

  it("prefers a stored value over the default", async () => {
    await harness.registry.set("app_name", "Acme");

    expect(await harness.registry.get("app_name")).toBe("Acme");
  });

  it("stores false, zero and the empty string as themselves", async () => {
    // The case a bare column would collapse into something
    // indistinguishable from "no row", which is why the value is a JSON
    // envelope.
    await harness.registry.setMany({
      import_feature_enabled: false,
      import_batch_size: 1,
      app_name: "",
    });

    expect(await harness.registry.get("import_feature_enabled")).toBe(false);
    expect(await harness.registry.get("import_batch_size")).toBe(1);
    expect(await harness.registry.get("app_name")).toBe("");

    // And each is genuinely a stored row, not a default that happens to
    // match.
    expect(await harness.registry.isCustomised("app_name")).toBe(true);
  });

  it("throws on an unknown key rather than reading as unset", async () => {
    // A typo is otherwise indistinguishable from "nobody has customised
    // this", which is the one distinction declaring settings buys.
    const error = await captureError(harness.registry.get("app_nmae"));

    expect(error).toBeInstanceOf(UnknownSettingError);
    expect((error as UnknownSettingError).key).toBe("app_nmae");
  });

  it("answers all() for every declared setting, not every stored one", async () => {
    await harness.registry.set("app_name", "Acme");

    const all = await harness.registry.all();

    expect(all["app_name"]).toBe("Acme");
    // Declared but never stored: present, at its default.
    expect(all["import_batch_size"]).toBe(100);
    expect(Object.keys(all).sort()).toEqual([
      "allowed_domains",
      "app_name",
      "branding",
      "import_batch_size",
      "import_feature_enabled",
      "maintenance_until",
    ]);
  });

  it("omits a stored row whose definition no longer exists from all()", async () => {
    // A setting removed from code leaves its row behind. `all()` keys on
    // declarations, so the orphan cannot resurface as a phantom setting
    // with no type to decode it by.
    await DB.table("settings").insert({
      key: "removed_setting",
      value: '"stale"',
      edited_by_user_id: null,
      created_at: DateTime.now().toISOString(),
      updated_at: DateTime.now().toISOString(),
    });
    await harness.registry.forgetCache();

    expect(Object.keys(await harness.registry.all())).not.toContain("removed_setting");
  });

  it("distinguishes declared from customised", async () => {
    expect(harness.registry.has("app_name")).toBe(true);
    expect(harness.registry.has("nonsense")).toBe(false);

    expect(await harness.registry.isCustomised("app_name")).toBe(false);

    await harness.registry.set("app_name", "Acme");

    expect(await harness.registry.isCustomised("app_name")).toBe(true);
  });
});

describe("writing", () => {
  it("writes one row per setting and overwrites on re-set", async () => {
    await harness.registry.set("app_name", "First");
    await harness.registry.set("app_name", "Second");

    const rows = await DB.table("settings").where("key", "app_name").get();

    // `key` is the primary key, so re-setting overwrites rather than
    // accumulating.
    expect(rows).toHaveLength(1);
    expect(await harness.registry.get("app_name")).toBe("Second");
  });

  it("stores the coerced value, so normalisation is permanent", async () => {
    // `number` and `boolean` coerce, which is what makes an HTML form
    // post work. The coerced value is what lands in the column, so the
    // conversion is not re-done on every read.
    await harness.registry.setMany({ import_batch_size: "250", import_feature_enabled: "on" });

    expect(await harness.registry.get("import_batch_size")).toBe(250);
    expect(await harness.registry.get("import_feature_enabled")).toBe(true);

    const row = await DB.table("settings").where("key", "import_batch_size").first();

    expect((row as { value: string }).value).toBe("250");
  });

  it("throws on an unknown key rather than storing it", async () => {
    const error = await captureError(harness.registry.set("app_nmae", "x"));

    expect(error).toBeInstanceOf(UnknownSettingError);
    expect(await DB.table("settings").get()).toHaveLength(0);
  });

  it("round-trips a datetime as a DateTime", async () => {
    const when = DateTime.parse("2026-03-04T05:06:07Z", "UTC");

    await harness.registry.set("maintenance_until", when);

    const read = await harness.registry.get("maintenance_until");

    expect(read).toBeInstanceOf(DateTime);
    expect((read as DateTime).toISOString()).toBe(when.toISOString());
  });

  it("normalises a zoned datetime to UTC before storing", async () => {
    // `toISOString()` renders in the instance's own zone, so a value
    // built elsewhere would otherwise round-trip through a different
    // instant on two engines out of three.
    const perth = DateTime.parse("2026-03-04T05:06:07Z", "UTC").inTimezone("Australia/Perth");

    await harness.registry.set("maintenance_until", perth);

    const row = await DB.table("settings").where("key", "maintenance_until").first();

    expect((row as { value: string }).value).toContain("2026-03-04T05:06:07");
    expect((row as { value: string }).value).toContain("Z");
  });

  it("round-trips arrays and json objects", async () => {
    await harness.registry.setMany({
      allowed_domains: ["a.test", "b.test"],
      branding: { primary: "#112233", logo: null },
    });

    expect(await harness.registry.get("allowed_domains")).toEqual(["a.test", "b.test"]);
    expect(await harness.registry.get("branding")).toEqual({ primary: "#112233", logo: null });
  });

  it("stores an empty array as a customised value, not a default", async () => {
    // `required` presence counts `[]` as empty, which is why the type
    // rules are `optional()`. An empty allow-list is a meaningful
    // setting, not an absent one.
    await harness.registry.set("allowed_domains", []);

    expect(await harness.registry.isCustomised("allowed_domains")).toBe(true);
    expect(await harness.registry.get("allowed_domains")).toEqual([]);
  });

  it("writes nothing when setMany is given nothing", async () => {
    await harness.registry.setMany({});

    expect(await DB.table("settings").get()).toHaveLength(0);
  });
});

describe("forget", () => {
  it("deletes the row and reverts to the default", async () => {
    await harness.registry.set("app_name", "Acme");
    await harness.registry.forget("app_name");

    expect(await harness.registry.get("app_name")).toBe("Mahi");
    expect(await harness.registry.isCustomised("app_name")).toBe(false);
    expect(await DB.table("settings").get()).toHaveLength(0);
  });

  it("is a no-op when nothing was stored", async () => {
    await harness.registry.forget("app_name");

    expect(await harness.registry.get("app_name")).toBe("Mahi");
  });

  it("throws on an unknown key", async () => {
    expect(await captureError(harness.registry.forget("nonsense"))).toBeInstanceOf(
      UnknownSettingError,
    );
  });
});
