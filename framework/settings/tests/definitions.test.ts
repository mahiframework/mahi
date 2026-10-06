import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahiframework/core";
import { DuplicateSettingError, UnknownSettingError } from "../src/errors.js";
import type { SettingDefinition } from "../src/setting-definition.js";
import { resolveConfig } from "../src/settings-config.js";
import { SettingsRegistry } from "../src/settings-registry.js";
import { SettingsServiceProvider } from "../src/settings-service-provider.js";
import { SETTINGS_TOKEN } from "../src/tokens.js";
import { createHarness, definingProvider, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

describe("the settings() hook", () => {
  it("collects definitions from every registered provider", async () => {
    const multi = await createHarness({ definitions: [] });

    // The fixture's defining provider contributed nothing, so anything
    // present came from elsewhere — which is the point: this asserts the
    // hook is what fills the registry, not the harness.
    expect([...multi.registry.definitions().keys()]).toEqual([]);

    multi.cleanup();
  });

  it("collects from a provider registered AFTER this one", async () => {
    // The guarantee `boot()` exists for. A provider listed later in
    // `config/app.ts` has not been constructed during `register()`, so
    // collecting there would silently drop its settings.
    const app = new Application();

    app.register(SettingsServiceProvider);
    app.register(
      definingProvider([{ name: "late_setting", type: "string", defaultValue: () => "x" }]),
    );
    await app.bootstrap();

    expect(app.make<SettingsRegistry>(SETTINGS_TOKEN).has("late_setting")).toBe(true);

    clearCurrentApp();
  });

  it("ignores a provider that declares no settings", async () => {
    const app = new Application();

    app.register(SettingsServiceProvider);
    app.register(class extends ServiceProvider {});
    await app.bootstrap();

    expect(app.make<SettingsRegistry>(SETTINGS_TOKEN).definitions().size).toBe(0);

    clearCurrentApp();
  });

  it("throws at boot when two providers claim the same name", async () => {
    // Names are unique across the whole application, not per category.
    // A shadowed definition carries its own type and default, so letting
    // the second win would turn a naming collision into a validation
    // failure on an unrelated write, long after the cause.
    const duplicate: SettingDefinition = {
      name: "shared_name",
      type: "string",
      defaultValue: () => "x",
    };

    const app = new Application();
    app.register(SettingsServiceProvider);
    app.register(definingProvider([duplicate]));
    app.register(definingProvider([{ ...duplicate, type: "number", defaultValue: () => 1 }]));

    await expect(app.bootstrap()).rejects.toThrow(DuplicateSettingError);

    clearCurrentApp();
  });

  it("throws on a duplicate within one provider's own list", async () => {
    const registry = new SettingsRegistry(new Application(), resolveConfig());

    expect(() =>
      registry.define([
        { name: "same", type: "string", defaultValue: () => "a" },
        { name: "same", type: "string", defaultValue: () => "b" },
      ]),
    ).toThrow(DuplicateSettingError);
  });
});

describe("introspection", () => {
  it("returns definitions in declaration order", () => {
    expect([...harness.registry.definitions().keys()]).toEqual([
      "app_name",
      "import_batch_size",
      "import_feature_enabled",
      "maintenance_until",
      "allowed_domains",
      "branding",
    ]);
  });

  it("exposes one definition with its metadata intact", () => {
    const definition = harness.registry.definition("app_name");

    expect(definition.category).toBe("general");
    expect(definition.description).toBe("The application's display name.");
    expect(definition.type).toBe("string");
    expect(definition.defaultValue()).toBe("Mahi");
  });

  it("throws for a key nothing declared", () => {
    expect(() => harness.registry.definition("nonsense")).toThrow(UnknownSettingError);
  });

  it("lists categories, sorted, with un-categorised settings as an empty string", () => {
    // `category` is presentational and carries no uniqueness semantics,
    // so an un-categorised setting is a real case rather than an error.
    expect(harness.registry.categories()).toEqual(["", "general", "import"]);
  });
});
