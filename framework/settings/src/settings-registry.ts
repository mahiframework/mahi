import { CACHE_TOKEN, EVENTS_TOKEN, type Application } from "@mahiframework/core";
import type { CacheManager } from "@mahiframework/cache";
import { DB } from "@mahiframework/database";
import { Validator } from "@mahiframework/validation";
import { resolveActor } from "./actor.js";
import { DuplicateSettingError, UnknownSettingError } from "./errors.js";
import { SettingUpdated } from "./events/setting-updated.js";
import { SettingRecord } from "./models/setting-record.model.js";
import type { ResolvedSettingsConfig } from "./settings-config.js";
import type { SettingActor, SettingDefinition } from "./setting-definition.js";
import { decode, encode, settingRule } from "./value-codec.js";

/**
 * The declared settings, their stored values, and the cache over them.
 *
 * ## The resolution chain is two links, not three
 *
 * A setting is its stored row if there is one, else the default its
 * definition declares. There is deliberately no caller-supplied
 * fallback: every definition already carries a default, so a second one
 * at the call site could only ever disagree with it, and which of the
 * two won would depend on whether a row happened to exist.
 *
 * ## An unknown key throws
 *
 * On reads as well as writes. A typo'd key is otherwise
 * indistinguishable from a setting nobody has customised, which is the
 * one distinction declaring settings up front buys. `has()` answers "is
 * this defined" for a caller that genuinely does not know.
 *
 * ## What is cached, and in what form
 *
 * One key holding every stored row as `{ key: encodedValue }` — the
 * encoded strings, exactly as the column holds them, decoded only after
 * they cross back. That is not incidental: `FileCacheStore` and
 * `RedisCacheStore` persist with `JSON.stringify` while
 * `ArrayCacheStore` passes anything through, so a payload that is not
 * JSON-safe fails only once an app switches store — in production.
 * Strings are safe by construction.
 *
 * Definitions are NOT cached. They come from code, are rebuilt at every
 * boot, and a cached `defaultValue` thunk would be meaningless anyway.
 */
export class SettingsRegistry {
  private readonly declared = new Map<string, SettingDefinition>();

  constructor(
    private readonly app: Application,
    private readonly config: ResolvedSettingsConfig,
  ) {}

  // ------------------------------------------------------------ definitions

  /**
   * Declare settings. Called at boot with each provider's `settings()`.
   *
   * A duplicate name throws rather than overwriting. Names are unique
   * across the whole application, not per category, and a shadowed
   * definition carries its own type and default — so letting the second
   * win would turn a naming collision into a validation failure on an
   * unrelated write, long after the cause.
   */
  define(definitions: readonly SettingDefinition[]): void {
    for (const definition of definitions) {
      if (this.declared.has(definition.name)) {
        throw new DuplicateSettingError(definition.name);
      }

      this.declared.set(definition.name, definition);
    }
  }

  /** Every declared setting, in declaration order. */
  definitions(): ReadonlyMap<string, SettingDefinition> {
    return this.declared;
  }

  /** The definition for `key`, or throw. */
  definition(key: string): SettingDefinition {
    const definition = this.declared.get(key);

    if (definition === undefined) {
      throw new UnknownSettingError(key);
    }

    return definition;
  }

  /**
   * Whether `key` is DECLARED — not whether it is stored.
   *
   * The question a caller asks before `get()`, to avoid the throw. For
   * "has this been customised", see `isCustomised()`.
   */
  has(key: string): boolean {
    return this.declared.has(key);
  }

  /** Every declared category, sorted, with un-categorised settings last. */
  categories(): string[] {
    const found = new Set<string>();

    for (const definition of this.declared.values()) {
      found.add(definition.category ?? "");
    }

    return [...found].sort();
  }

  // ----------------------------------------------------------------- reading

  /**
   * A setting's value: its stored row if there is one, else its default.
   *
   * Keyed on `string`, not `SettingKey`, and returning `unknown`. This
   * class is the runtime engine, and its callers include this package's
   * own CLI commands, where the key arrives as an argv string that
   * cannot be narrowed at compile time. The typed surface is the
   * `Setting` facade, which is what application code uses and where the
   * `AppSettings` augmentation does its work.
   *
   * Validating at the boundary rather than trusting the type is also
   * what makes an unknown key a thrown `UnknownSettingError` instead of
   * `undefined`.
   */
  async get(key: string): Promise<unknown> {
    const definition = this.definition(key);
    const stored = (await this.stored())[key];

    if (stored === undefined) {
      return definition.defaultValue();
    }

    return decode(key, definition.type, stored);
  }

  /**
   * Every declared setting and its effective value.
   *
   * Keyed on every DECLARED setting, not every stored one, so a setting
   * nobody has customised still appears with its default — which is what
   * an admin screen listing settings needs, and what a stored row for a
   * since-deleted definition must not produce.
   */
  async all(): Promise<Record<string, unknown>> {
    const stored = await this.stored();
    const values: Record<string, unknown> = {};

    for (const [key, definition] of this.declared) {
      const raw = stored[key];

      values[key] =
        raw === undefined ? definition.defaultValue() : decode(key, definition.type, raw);
    }

    return values;
  }

  /** Whether a row exists for `key`, i.e. whether it differs from its default. */
  async isCustomised(key: string): Promise<boolean> {
    this.definition(key);

    return (await this.stored())[key] !== undefined;
  }

  // ----------------------------------------------------------------- writing

  /**
   * Validate and store one setting.
   *
   * `editedBy` is tri-state: omitted means "whoever is authenticated
   * right now", an explicit `null` means "deliberately unattributed".
   * A write from a CLI command or a queue worker has no ambient actor
   * and stores null rather than throwing.
   *
   * Untyped for the reason `get()` records: the key may be an argv
   * string. The value is checked against the definition's rules either
   * way, so the type is a convenience the facade adds rather than the
   * thing keeping bad data out.
   */
  async set(key: string, value: unknown, editedBy?: SettingActor): Promise<void> {
    await this.setMany({ [key]: value }, editedBy);
  }

  /**
   * Validate and store several settings.
   *
   * Every value is validated BEFORE any is written, so a rejected field
   * in an admin form cannot leave the store half-updated. The cache is
   * forgotten once, after all of them, rather than per setting.
   *
   * Events are dispatched last, for the same reason: a listener that
   * reads another setting back should see the whole batch, not the part
   * of it that happened to be written first.
   */
  async setMany(values: Record<string, unknown>, editedBy?: SettingActor): Promise<void> {
    const entries = Object.entries(values);

    if (entries.length === 0) {
      return;
    }

    // Validate everything first. `validate()` throws `ValidationException`,
    // which the HTTP error handler already renders as a 422 with a
    // per-field bag — so a settings form endpoint gets correct error
    // responses without this package knowing about HTTP.
    const validated = await this.validate(entries);
    const actor = resolveActor(editedBy);
    const previous = this.config.events ? await this.all() : {};

    for (const [key, value] of validated) {
      await SettingRecord.updateOrCreate(
        { key },
        { value: encode(key, this.definition(key).type, value), edited_by_user_id: actor },
      );
    }

    await this.forgetCache();

    for (const [key, value] of validated) {
      await this.dispatch(new SettingUpdated(key, value, previous[key], actor));
    }
  }

  /**
   * Delete a setting's row, reverting it to its declared default.
   *
   * Not `set(key, null)`: a setting is either stored or it is its
   * default, and a null standing in for "unset" would be a third state
   * to reconcile on every read. Deleting the row says it exactly.
   *
   * A no-op when nothing was stored, so it is safe to call blindly.
   */
  async forget(key: string): Promise<void> {
    const definition = this.definition(key);
    const previous = this.config.events ? await this.get(key) : undefined;
    const deleted = await DB.table<SettingRow>("settings").where("key", key).delete();

    if (deleted === 0) {
      return;
    }

    await this.forgetCache();
    await this.dispatch(new SettingUpdated(key, definition.defaultValue(), previous, null));
  }

  // ------------------------------------------------------------- the cache

  /**
   * Drop the cached map.
   *
   * Called by every write here, and by the model-event listener for
   * writes that bypass this class (a seeder calling
   * `SettingRecord.create()`, an admin screen going straight to the
   * ORM). Forgets exactly one key — `@mahiframework/cache` has no tags,
   * so there is no flush-by-pattern, and `flush()` would take out the
   * app's entire cache.
   */
  async forgetCache(): Promise<void> {
    await this.cache().store(this.config.cacheStore).forget(this.config.cacheKey);
  }

  /**
   * Every stored row as `{ key: encodedValue }`, from cache or the
   * database.
   *
   * `remember()` treats `undefined` as its miss sentinel, so the loader
   * must never return it — this one returns `{}` for an app that has
   * customised nothing, which would otherwise re-query on every read.
   */
  private async stored(): Promise<Record<string, string>> {
    return this.cache()
      .store(this.config.cacheStore)
      .remember<Record<string, string>>(
        this.config.cacheKey,
        () => this.load(),
        this.config.cacheTtlSeconds,
      );
  }

  /**
   * Read every stored row. One query, no model hydration.
   *
   * `DB.table` rather than `SettingRecord.query()`: the values are kept
   * encoded until they are asked for, so hydrating a model per row would
   * build timestamps and casts nothing here reads.
   */
  private async load(): Promise<Record<string, string>> {
    const rows = await DB.table<SettingRow>("settings").select("key", "value").get();
    const map: Record<string, string> = {};

    for (const row of rows) {
      map[row.key] = row.value;
    }

    return map;
  }

  // ------------------------------------------------------------- internals

  /**
   * Validate every pending value against its definition.
   *
   * One `Validator` for the whole batch, keyed on the setting names, so
   * `humanize()` turns `import_batch_size` into "The import batch size
   * field must be at least 1" for free. A batch also means a rule that
   * references a sibling field (`gt("other_setting")`) works, which it
   * could not if each value were validated alone.
   *
   * The composition itself lives in `settingRule()`, which has to build
   * on the definition's rule rather than merge into the type's — see
   * there for why a presence declared by a definition would otherwise be
   * dropped.
   *
   * Returns the validated values, which matters for `number` and
   * `boolean`: those coerce (`"5"` → `5`), and it is the coerced value
   * that gets stored, so the normalisation is permanent rather than
   * re-done on every read.
   */
  private async validate(entries: [string, unknown][]): Promise<[string, unknown][]> {
    const rules: Record<string, ReturnType<typeof settingRule>> = {};
    const data: Record<string, unknown> = {};

    for (const [key, value] of entries) {
      const definition = this.definition(key);

      rules[key] = settingRule(definition.type, definition.rules);
      data[key] = value;
    }

    const validator = new Validator(data, {}, rules);

    if (!(await validator.passes())) {
      // Throws `ValidationException`, carrying the per-field bag.
      validator.validated();
    }

    const validated = validator.validated();

    // Read back through `entries` rather than `Object.entries(validated)`:
    // the write order is the caller's, and a `json` setting legitimately
    // set to `undefined`-adjacent values must still be keyed from what
    // was asked for.
    return entries.map(([key]) => [key, validated[key]]);
  }

  /** Fire an event, when events are bound and enabled. */
  private async dispatch(event: SettingUpdated): Promise<void> {
    if (!this.config.events || !this.app.has(EVENTS_TOKEN)) {
      return;
    }

    await this.app.make<EventDispatcherLike>(EVENTS_TOKEN).dispatch(event);
  }

  private cache(): CacheManager {
    return this.app.make<CacheManager>(CACHE_TOKEN);
  }
}

/**
 * The full shape of a `settings` row.
 *
 * Declared in full even though `load()` selects two columns:
 * `QueryBuilder<TRow>` types `where()` against `TRow`'s keys, so a
 * partial interface would reject a `where("edited_by_user_id", ...)`
 * added later.
 */
interface SettingRow {
  key: string;
  value: string;
  edited_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The shape read off the `EventDispatcher`, resolved by string token so
 * a dispatch never forces `@mahiframework/events` to be installed.
 */
interface EventDispatcherLike {
  dispatch(event: object): Promise<void>;
}
