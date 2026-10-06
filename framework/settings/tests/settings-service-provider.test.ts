import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, CACHE_TOKEN, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { ModelCreated, ModelDeleted, ModelUpdated } from "@mahiframework/database";
import { InvalidateSettingsCacheListener } from "../src/listeners/invalidate-settings-cache.listener.js";
import { SettingRecord } from "../src/models/setting-record.model.js";
import { SettingsRegistry } from "../src/settings-registry.js";
import { SettingsServiceProvider } from "../src/settings-service-provider.js";
import { SETTINGS_TOKEN } from "../src/tokens.js";

let app: Application;
let provider: SettingsServiceProvider;

beforeEach(() => {
  app = new Application();
  setCurrentApp(app);
  provider = new SettingsServiceProvider(app);
});

afterEach(() => clearCurrentApp());

describe("registration", () => {
  it("binds the registry as a singleton", () => {
    provider.register();

    const first = app.make<SettingsRegistry>(SETTINGS_TOKEN);

    expect(first).toBeInstanceOf(SettingsRegistry);
    expect(app.make<SettingsRegistry>(SETTINGS_TOKEN)).toBe(first);
  });

  it("boots with no config at all", () => {
    // `config.get`, not `config.require`: installing the package and
    // configuring nothing must give working defaults rather than a boot
    // failure.
    provider.register();

    expect(() => app.make<SettingsRegistry>(SETTINGS_TOKEN)).not.toThrow();
  });

  it("does not clobber config the app already set", () => {
    // Defaults are applied in `resolveConfig()` with `??`, never through
    // `config.merge()` — which deep-merges the INCOMING values last and
    // would silently overwrite the app's own config rather than layering
    // under it.
    app.config.set("settings", { cache: { key: "app.chosen.key" } });

    provider.register();
    app.make<SettingsRegistry>(SETTINGS_TOKEN);

    expect(app.config.get("settings")).toEqual({ cache: { key: "app.chosen.key" } });
  });

  it("re-exports the token from the provider module", () => {
    expect(SETTINGS_TOKEN).toBe("settings");
  });
});

describe("hooks", () => {
  it("ships the migration under a name matching its file", () => {
    // The name lands in the `migrations` table and orders execution, so
    // drift from the filename re-runs the migration for an app that
    // already migrated.
    expect(provider.migrationSources()).toEqual([
      { name: "0001_create_settings_table", migration: expect.anything() },
    ]);
  });

  it("registers the model so a queued job can carry one", () => {
    expect(provider.models()).toEqual([SettingRecord]);
  });

  it("subscribes the cache listener to the three write events", () => {
    // Individually, not a `"model.*"` pattern: that would also match
    // `retrieved`, which fires on every row read in the application, so
    // the listener would sit on the hottest path only to filter itself
    // out. `ModelSaved` is skipped because it fires alongside both
    // `ModelCreated` and `ModelUpdated`.
    expect(provider.listeners()).toEqual([
      [ModelCreated, InvalidateSettingsCacheListener],
      [ModelUpdated, InvalidateSettingsCacheListener],
      [ModelDeleted, InvalidateSettingsCacheListener],
    ]);
  });

  it("registers every command", () => {
    expect(provider.commands().map((command) => command.name)).toEqual([
      "SettingsListCommand",
      "SettingsGetCommand",
      "SettingsSetCommand",
      "SettingsForgetCommand",
      "SettingsCacheResetCommand",
    ]);
  });
});

describe("the cache listener", () => {
  it("ignores an event for another model", async () => {
    // Filtered on model identity, so an app writing any other model does
    // not pay an invalidation per row. Nothing is bound at `CACHE_TOKEN`
    // here, so a listener that failed to filter would throw.
    const listener = new InvalidateSettingsCacheListener(app);

    await expect(
      listener.handle(new ModelCreated(SettingsRegistry as never, {} as never, "created")),
    ).resolves.toBeUndefined();
  });

  it("does not swallow a failure to invalidate", async () => {
    // The opposite of the call `activity-logs` makes. A missing audit row
    // is a lost record, but a cache still serving the old value is the
    // application behaving contrary to its own configuration — a feature
    // left on after being turned off. Better the write fails loudly and
    // is retried than succeeds while leaving the cache lying.
    //
    // Nothing is bound at `CACHE_TOKEN`, so `forgetCache()` throws.
    provider.register();

    const listener = new InvalidateSettingsCacheListener(app);

    await expect(
      listener.handle(new ModelCreated(SettingRecord as never, {} as never, "created")),
    ).rejects.toThrow();

    expect(app.has(CACHE_TOKEN)).toBe(false);
  });
});
