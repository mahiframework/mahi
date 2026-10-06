import { Facade } from "@mahiframework/facades";
import type { SettingsRegistry } from "./settings-registry.js";
import type {
  AppSettings,
  SettingActor,
  SettingDefinition,
  SettingKey,
  SettingValue,
} from "./setting-definition.js";
import { SETTINGS_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `SettingsRegistry` singleton bound at
 * `SETTINGS_TOKEN`.
 *
 *   if (await Setting.get("import_feature_enabled")) { ... }
 *   await Setting.set("import_batch_size", 250);
 *
 * Named `Setting` (singular) rather than `Settings`, even though it
 * fronts a registry of many: `Setting.get("x")` reads as "the setting
 * x", which is what the call means. The model takes the compound name
 * `SettingRecord` so this one is free — the facade is what application
 * code touches constantly, so it gets the good name.
 *
 * ## This is the typed surface
 *
 * `SettingsRegistry` is keyed on `string` and returns `unknown`: it is
 * the runtime engine, and its callers include this package's own CLI
 * commands, where a key arrives as an argv string that cannot be
 * narrowed at compile time. The narrowing lives HERE, where application
 * code calls in with a literal and the app's own `AppSettings`
 * augmentation can do its work:
 *
 *     declare module "@mahiframework/settings" {
 *       interface AppSettings { import_batch_size: number }
 *     }
 *
 * With that in place `Setting.get("import_batch_size")` is a `number`
 * and a misspelled key is a compile error. With no augmentation at all
 * the keys widen to `string` and the values to `unknown`, so the package
 * stays usable — it just checks nothing.
 *
 * The casts below are confined to this boundary and are the only ones in
 * the package. They are what buys an app key-checked, correctly-typed
 * settings without the engine pretending to a type safety it cannot have.
 *
 * `Setting.instance()` comes from the `Facade` mixin and returns the
 * registry itself, for a caller that genuinely holds a runtime string.
 *
 * Prefer constructor-injecting `SettingsRegistry` (via `SETTINGS_TOKEN`)
 * where that is practical; use this only where threading
 * `app`/`SettingsRegistry` through is genuinely inconvenient, the same
 * guidance as `app()` itself.
 */
export class Setting extends Facade<SettingsRegistry>(() => SETTINGS_TOKEN) {
  // ----------------------------------------------------------------- reading

  /** A setting's value: its stored row if there is one, else its default. */
  static get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return this.instance().get(key) as Promise<SettingValue<K>>;
  }

  /** Every declared setting and its effective value. */
  static all(): Promise<Record<string, unknown>> {
    return this.instance().all();
  }

  /** Whether `key` is declared. Not whether it is stored — see `isCustomised`. */
  static has(key: string): boolean {
    return this.instance().has(key);
  }

  /** Whether a row exists for `key`, i.e. whether it differs from its default. */
  static isCustomised(key: SettingKey): Promise<boolean> {
    return this.instance().isCustomised(key);
  }

  // ----------------------------------------------------------------- writing

  /**
   * Validate and store one setting.
   *
   * `editedBy` omitted means "whoever is authenticated right now"; an
   * explicit `null` means "deliberately unattributed".
   */
  static set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    editedBy?: SettingActor,
  ): Promise<void> {
    return this.instance().set(key, value, editedBy);
  }

  /**
   * Validate and store several settings, all-or-nothing.
   *
   * `Partial<AppSettings>` when the app has augmented it, so a batch
   * built from a validated request body is key- and value-checked too —
   * which is the shape an admin settings form actually posts.
   */
  static setMany(values: Partial<AppSettings>, editedBy?: SettingActor): Promise<void> {
    return this.instance().setMany(values as Record<string, unknown>, editedBy);
  }

  /** Delete a setting's row, reverting it to its declared default. */
  static forget(key: SettingKey): Promise<void> {
    return this.instance().forget(key);
  }

  // ------------------------------------------------------------- definitions

  /** Every declared setting, in declaration order. */
  static definitions(): ReadonlyMap<string, SettingDefinition> {
    return this.instance().definitions();
  }

  /** The definition for `key`, or throw `UnknownSettingError`. */
  static definition(key: string): SettingDefinition {
    return this.instance().definition(key);
  }

  /** Every declared category, sorted. */
  static categories(): string[] {
    return this.instance().categories();
  }

  // ------------------------------------------------------------------- cache

  /** Drop the cached map. */
  static forgetCache(): Promise<void> {
    return this.instance().forgetCache();
  }
}
