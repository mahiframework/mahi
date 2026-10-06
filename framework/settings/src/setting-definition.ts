import type { DateTime } from "@mahiframework/datetime";
import type { Rule } from "@mahiframework/validation";

/**
 * What a setting holds, and the only thing that decides how its value is
 * encoded to and decoded from the `value` column.
 *
 * A closed union, not an open string. Every arm needs a decoder, a
 * validation rule and a CLI parser, so a new arm is a change to this
 * package rather than something an app can invent — which is also what
 * lets `InferSettingType` map each one to a TypeScript type.
 *
 * `datetime` is listed separately from `string` because a `DateTime` is
 * what callers want in hand, and the ISO round-trip belongs in one place
 * rather than at every call site. `json` and `array` differ only in
 * which shape the rule asserts.
 */
export type SettingType = "string" | "number" | "boolean" | "datetime" | "json" | "array";

/** The TypeScript type each `SettingType` resolves to. */
export type InferSettingType<T extends SettingType> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "datetime"
        ? DateTime
        : T extends "array"
          ? unknown[]
          : unknown;

/**
 * One setting: what it is called, what it holds, and what it is when
 * nobody has set it.
 *
 * ## Why `type` and `rules` are both here
 *
 * They answer different questions. `type` decides STORAGE — how the
 * value is encoded into the `value` column and decoded back out — and is
 * what the inference types read. `rules` only CONSTRAINS a value that is
 * already of the right type.
 *
 * So a definition never repeats its own type:
 *
 *     { name: "import_batch_size", type: "number",
 *       rules: () => Rule.make().min(1).max(1000), defaultValue: () => 100 }
 *
 * The registry prepends the type's own rule (`.integer()` here) before
 * validating, so `rules` is optional and additive. Omitting it validates
 * the type and nothing else.
 *
 * ## Why both are thunks
 *
 * `Rule` is mutable: every chain call pushes onto the instance and
 * returns `this`. A shared instance would accumulate steps across
 * validations. A thunk yields a fresh rule per call.
 *
 * `defaultValue` is a thunk for the adjacent reason — an object or array
 * default returned by reference would be shared by every caller that
 * read it, and mutating one would change the default for all of them.
 */
export interface SettingDefinition<T = unknown> {
  /**
   * Unique across the whole application, not just within a category.
   *
   * Prefer a prefixed name (`import_feature_enabled`, not `enabled`), so
   * two features cannot collide. A duplicate throws
   * `DuplicateSettingError` at boot.
   */
  name: string;

  /**
   * A grouping for an admin UI and `settings:list`.
   *
   * Purely presentational, and deliberately so: it carries NO uniqueness
   * semantics. A key that means different things depending on its
   * category is exactly the ambiguity the global-uniqueness rule exists
   * to prevent.
   */
  category?: string;

  /** What this setting does, for an admin UI and `settings:list --verbose`. */
  description?: string;

  type: SettingType;

  /**
   * Extra constraints, on top of the type's own rule.
   *
   * `exists()` and `unique()` are not usable here: both throw rather
   * than fail when no presence resolver is registered, and a setting is
   * read from CLI commands and queue workers where the database may not
   * be booted.
   */
  rules?: () => Rule<any, any>;

  /** The value when no row exists. Called each time, so it may be a fresh object. */
  defaultValue: () => T;
}

/**
 * The application's settings, as a map of key to value type.
 *
 * Empty here, filled in by the application through module augmentation —
 * the same mechanism `ProviderHooks` uses:
 *
 *     declare module "@mahiframework/settings" {
 *       interface AppSettings {
 *         import_feature_enabled: boolean;
 *         import_batch_size: number;
 *       }
 *     }
 *
 * With that in place `Setting.get("import_batch_size")` is a `number`
 * and a misspelled key is a compile error.
 *
 * Augmenting is optional. With no augmentation, `SettingKey` widens to
 * `string` and every value to `unknown`, so the package stays usable
 * rather than becoming uncallable — the cost is that nothing is checked.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional: an empty interface is the only shape an application can declaration-merge into, which is the whole mechanism here. `object` or `unknown` would not be augmentable, and `Record<string, unknown>` would defeat the point by accepting every key.
export interface AppSettings {}

/**
 * A valid setting key: the augmented keys when there are any, else any
 * string.
 *
 * The `extends never` test is what makes augmentation optional. An
 * un-augmented `AppSettings` has no keys, and a `keyof` of that is
 * `never` — which as a parameter type would reject every call.
 */
export type SettingKey = keyof AppSettings extends never ? string : keyof AppSettings & string;

/** What the setting at `K` holds, or `unknown` when it was never declared. */
export type SettingValue<K extends string> = K extends keyof AppSettings ? AppSettings[K] : unknown;

/**
 * The actor behind a write.
 *
 * A model (anything with `getKey()` or an `id`), a bare key, or `null`.
 * Distinct from `undefined` at the call sites that accept it: omitting
 * the argument means "whoever is authenticated right now", while an
 * explicit `null` means "deliberately unattributed", which is what a
 * CLI command or a migration wants.
 */
export type SettingActor = object | string | number | bigint | null;
