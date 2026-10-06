/**
 * Compile-time assertions for the typed-key layer, which is the half of
 * this package's contract the runtime tests structurally cannot cover.
 * `tsc` is the assertion; nothing here runs.
 *
 * The guarantees pinned here:
 *  - An app's `declare module` augmentation makes `get()` return the
 *    declared type rather than `unknown`.
 *  - A misspelled key is a compile error at `get()` and at `set()`.
 *  - `set()` rejects a value of the wrong type for the key.
 *  - `InferSettingType` maps every `SettingType` to the right TS type.
 *  - `SettingDefinition<T>` carries its value type through
 *    `defaultValue`.
 *
 * Each `@ts-expect-error` fails the build if the line beneath it ever
 * starts compiling again — which is the point: a regression that widened
 * `SettingKey` back to `string` would otherwise be invisible.
 */

import { expectTypeOf } from "vitest";
import type { DateTime } from "@mahiframework/datetime";
import { Setting } from "../src/settings-facade.js";
import type {
  InferSettingType,
  SettingDefinition,
  SettingKey,
  SettingValue,
} from "../src/setting-definition.js";

// Exactly what an application writes in its own code. Declaring it in a
// test file is what puts the augmented path under test at all: without
// an augmentation, `AppSettings` has no keys, `SettingKey` widens to
// `string`, and every `@ts-expect-error` below would itself become an
// error for being unused — which is what makes these assertions
// load-bearing rather than decorative.
//
// NOTE: a module augmentation is global to the compilation, so this
// applies to every file in `tsconfig.test.json` — including the runtime
// suites. It therefore mirrors `testDefinitions()` in the fixture
// exactly, so a facade call in another test file is typed as that
// fixture describes it rather than failing for a key this file forgot.
// Keep the two in step.
declare module "../src/setting-definition.js" {
  interface AppSettings {
    app_name: string;
    import_batch_size: number;
    import_feature_enabled: boolean;
    maintenance_until: DateTime | null;
    allowed_domains: unknown[];
    branding: { primary: string };
  }
}

// ----------------------------------------------------------------- the keys

// `SettingKey` narrows to the declared keys, so a typo cannot be passed
// anywhere one is expected.
expectTypeOf<SettingKey>().toEqualTypeOf<
  | "app_name"
  | "import_batch_size"
  | "import_feature_enabled"
  | "maintenance_until"
  | "allowed_domains"
  | "branding"
>();

expectTypeOf<SettingValue<"import_batch_size">>().toEqualTypeOf<number>();
expectTypeOf<SettingValue<"maintenance_until">>().toEqualTypeOf<DateTime | null>();
expectTypeOf<SettingValue<"branding">>().toEqualTypeOf<{ primary: string }>();

// --------------------------------------------------------------------- get

// The payoff: a declared key reads back as its declared type, with no
// generic argument and no cast at the call site.
expectTypeOf(Setting.get("import_feature_enabled")).resolves.toEqualTypeOf<boolean>();
expectTypeOf(Setting.get("import_batch_size")).resolves.toEqualTypeOf<number>();
expectTypeOf(Setting.get("app_name")).resolves.toEqualTypeOf<string>();
expectTypeOf(Setting.get("maintenance_until")).resolves.toEqualTypeOf<DateTime | null>();

// @ts-expect-error -- a misspelled key is rejected, not read as `unknown`
void Setting.get("import_batch_sze");

// --------------------------------------------------------------------- set

void Setting.set("import_feature_enabled", true);
void Setting.set("import_batch_size", 250);
void Setting.set("branding", { primary: "#000000" });

// @ts-expect-error -- a boolean setting does not take a string
void Setting.set("import_feature_enabled", "true");

// @ts-expect-error -- a number setting does not take a string
void Setting.set("import_batch_size", "250");

// @ts-expect-error -- a misspelled key is rejected on write too
void Setting.set("app_nmae", "Mahi");

// @ts-expect-error -- an object setting is checked structurally
void Setting.set("branding", { primary: 0 });

// The actor argument is optional and accepts a model, a bare key, or an
// explicit null.
void Setting.set("app_name", "Mahi", null);
void Setting.set("app_name", "Mahi", 123n);
void Setting.set("app_name", "Mahi", { id: 1 });

// ------------------------------------------------------ forget / isCustomised

void Setting.forget("app_name");
expectTypeOf(Setting.isCustomised("app_name")).resolves.toEqualTypeOf<boolean>();

// @ts-expect-error -- still key-checked
void Setting.forget("nonsense");

// `has()` deliberately takes a plain `string`: it is the call a caller
// makes when they do NOT know whether a key is declared, so narrowing it
// to declared keys would make it useless.
expectTypeOf(Setting.has).parameter(0).toEqualTypeOf<string>();

// ------------------------------------------------------- InferSettingType

expectTypeOf<InferSettingType<"string">>().toEqualTypeOf<string>();
expectTypeOf<InferSettingType<"number">>().toEqualTypeOf<number>();
expectTypeOf<InferSettingType<"boolean">>().toEqualTypeOf<boolean>();
expectTypeOf<InferSettingType<"datetime">>().toEqualTypeOf<DateTime>();
expectTypeOf<InferSettingType<"array">>().toEqualTypeOf<unknown[]>();
expectTypeOf<InferSettingType<"json">>().toEqualTypeOf<unknown>();

// ------------------------------------------------------ SettingDefinition

// The value type flows through `defaultValue`, so a definition whose
// default disagrees with its own generic is rejected.
const typed: SettingDefinition<number> = {
  name: "import_batch_size",
  type: "number",
  defaultValue: () => 100,
};
expectTypeOf(typed.defaultValue).returns.toEqualTypeOf<number>();

const untyped: SettingDefinition = {
  name: "anything",
  type: "json",
  defaultValue: () => ({ shape: "free" }),
};
expectTypeOf(untyped.defaultValue).returns.toEqualTypeOf<unknown>();

// @ts-expect-error -- `type` is a closed union, not an open string
const badType: SettingDefinition = { name: "x", type: "colour", defaultValue: () => 1 };
void badType;

// @ts-expect-error -- `defaultValue` is a thunk, not a bare value
const bareDefault: SettingDefinition<number> = { name: "x", type: "number", defaultValue: 1 };
void bareDefault;

// @ts-expect-error -- `name` and `type` are both required
const incomplete: SettingDefinition = { name: "x" };
void incomplete;
