import { DateTime } from "@mahiframework/datetime";
import { Rule, ValidationRule } from "@mahiframework/validation";
import { SettingDecodeError, SettingsError } from "./errors.js";
import type { SettingType } from "./setting-definition.js";

/**
 * The storage and validation boundary for a setting's value.
 *
 * ## Everything is a JSON envelope
 *
 * The `value` column is `text` holding JSON, not the raw value. A bare
 * column would collapse `false`, `0`, `""` and `null` into something
 * indistinguishable from "no row", which is the one distinction this
 * package exists to make: a setting is either stored or it is its
 * default, and `false` is a perfectly good stored value.
 *
 * ## Why the cached form is the encoded form
 *
 * `FileCacheStore` and `RedisCacheStore` persist with `JSON.stringify`,
 * which throws on a `bigint`, while `ArrayCacheStore` passes one through
 * happily — so a value that is not JSON-safe is invisible in tests and
 * fatal in production. Encoding happens before the cache boundary and
 * decoding after it, which means the cached payload is a map of plain
 * strings and there is exactly one place this can be got wrong.
 *
 * `encode()` is therefore also where a non-serialisable value is
 * rejected, at the point the caller can still be told which setting it
 * was.
 */

/**
 * The rule a value is validated against: the declared type's own
 * assertion, plus whatever the definition adds.
 *
 * ## Composition order, and why it is not `typeRule().rule(extra)`
 *
 * `Rule.rule(other)` merges the other rule's STEPS, but presence is a
 * field on the instance rather than a step — so merging a definition's
 * `Rule.make().required()` into a base rule silently drops the
 * `required` and keeps the base's presence. The definition's rule is
 * therefore the one built on, with the type's steps merged into IT, so
 * a definition that declares a presence keeps it.
 *
 * The type's steps still run first: `Rule.rule()` appends, and the
 * validator skips constraint steps once a type step fails. So a caller
 * passing a string where a number belongs is told it is not a number,
 * not that it is "less than 1".
 *
 * ## Why the default presence is `optional`, never `required`
 *
 * A `required` presence fails on `isEmpty()`, which counts `""` and `[]`
 * as empty — and an empty string or an empty allow-list is a legitimate
 * setting value. `optional()` skips only `undefined`, which the registry
 * never passes through. A setting that genuinely must not be blank opts
 * in with `rules: () => Rule.make().required()`.
 *
 * `null` deliberately has no arm and so fails whichever type step
 * follows. A setting always has a value; "unset" is expressed by
 * deleting the row (`forget()`), which reverts it to its default. That
 * keeps the three-way null / absent / default ambiguity out of the API.
 *
 * `number` and `boolean` coerce (`"5"` → `5`, `"on"` → `true`), which is
 * what makes `settings:set` and an HTML form post work without the
 * caller parsing first. The coerced value is what gets stored, so the
 * normalisation is permanent rather than per-read.
 */
export function settingRule(type: SettingType, extra?: () => Rule<any, any>): Rule<any, any> {
  const base = extra?.() ?? Rule.make().optional();

  return base.rule(typeSteps(type));
}

/** The steps asserting a value is of its declared type. */
function typeSteps(type: SettingType): Rule<any, any> {
  switch (type) {
    case "string":
      return Rule.make().string();
    case "number":
      return Rule.make().number();
    case "boolean":
      return Rule.make().boolean();
    case "datetime":
      // NOT `date()`. That rule's `parseDate()` accepts an ISO string, a
      // `Date` or an epoch number — but not a `DateTime`, which is the
      // type a caller holding a date in this framework actually has, and
      // the type `get()` hands back. Validating `set(key, await get(key))`
      // must not fail.
      return Rule.make().rule(new IsDateTimeLike());
    case "array":
      return Rule.make().array();
    case "json":
      // No type step: any JSON-serialisable value passes. `encode()` is
      // what rejects one that is not.
      return Rule.make();
  }
}

/**
 * A validated value as it goes into the `value` column.
 *
 * A `DateTime` is normalised to UTC first, for the reason `DateTimeCast`
 * records: `toISOString()` renders in the instance's own zone, so a
 * value built in a non-UTC zone would otherwise round-trip through a
 * different instant.
 */
export function encode(key: string, type: SettingType, value: unknown): string {
  const payload =
    type === "datetime" ? toDateTime(key, value).setTimezone("UTC").toISOString() : value;

  try {
    return JSON.stringify(payload) ?? "null";
  } catch (error) {
    // `JSON.stringify` throws on a `bigint` and on a circular structure.
    // Both are programmer errors, but neither names the setting, which
    // is the only thing that makes them actionable.
    throw new SettingsError(
      `The value for "${key}" cannot be stored: ${error instanceof Error ? error.message : String(error)}. A setting's value must be JSON-serialisable.`,
    );
  }
}

/**
 * A stored column value back into its declared type.
 *
 * Throws rather than falling back to the default. A row that says one
 * thing while the application reads another is a configuration change
 * nobody asked for, and the usual cause — a definition's `type` changed
 * after a value was written — is worth surfacing loudly at the point the
 * stale row is read.
 */
export function decode(key: string, type: SettingType, stored: string): unknown {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new SettingDecodeError(
      key,
      type,
      `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  switch (type) {
    case "string":
      return expect(key, type, parsed, typeof parsed === "string", "a string");
    case "number":
      return expect(
        key,
        type,
        parsed,
        typeof parsed === "number" && Number.isFinite(parsed),
        "a finite number",
      );
    case "boolean":
      return expect(key, type, parsed, typeof parsed === "boolean", "a boolean");
    case "array":
      return expect(key, type, parsed, Array.isArray(parsed), "an array");
    case "datetime": {
      expect(key, type, parsed, typeof parsed === "string", "an ISO 8601 string");
      const parsedDate = DateTime.parseSafe(parsed as string, "UTC");

      if (parsedDate === null) {
        throw new SettingDecodeError(key, type, `"${String(parsed)}" is not a parsable date`);
      }

      return parsedDate;
    }
    case "json":
      // Anything JSON holds is valid, including `null`.
      return parsed;
  }
}

/**
 * Parse a string off the command line into the declared type.
 *
 * Only `settings:set` uses this. Everything else arrives already typed,
 * or as a JSON request body the validator coerces.
 *
 * `json` and `array` take JSON text, so an array is `'["a","b"]'` rather
 * than a comma-separated list: a setting whose values can contain commas
 * would otherwise have no way to say so.
 */
export function parseInput(key: string, type: SettingType, input: string): unknown {
  switch (type) {
    case "string":
      return input;
    case "number": {
      const parsed = Number(input);

      if (!Number.isFinite(parsed)) {
        throw new SettingsError(`"${input}" is not a number, which "${key}" requires.`);
      }

      return parsed;
    }
    case "boolean": {
      const normalised = input.trim().toLowerCase();

      if (["true", "1", "yes", "on"].includes(normalised)) {
        return true;
      }

      if (["false", "0", "no", "off"].includes(normalised)) {
        return false;
      }

      throw new SettingsError(
        `"${input}" is not a boolean, which "${key}" requires. Use true/false, 1/0, yes/no or on/off.`,
      );
    }
    case "datetime":
      return input;
    case "json":
    case "array":
      try {
        return JSON.parse(input);
      } catch (error) {
        throw new SettingsError(
          `"${key}" takes JSON, and this is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
  }
}

/**
 * A value for display in `settings:list` / `settings:get`.
 *
 * Deliberately not `encode()`: that is the storage format, and a string
 * setting showing as `"hello"` with the quotes is noise in a table.
 */
export function display(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value instanceof DateTime) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value) ?? String(value);
}

/**
 * A validated `datetime` value as a `DateTime`.
 *
 * `date()` passes an ISO string, a `Date` or an epoch number through
 * unchanged, so all three reach here and all three are accepted — but a
 * caller who already holds a `DateTime` is the common case and costs
 * nothing.
 */
function toDateTime(key: string, value: unknown): DateTime {
  if (value instanceof DateTime) {
    return value;
  }

  const parsed =
    value instanceof Date
      ? DateTime.parseSafe(value.toISOString(), "UTC")
      : typeof value === "string" || typeof value === "number"
        ? DateTime.parseSafe(value, "UTC")
        : null;

  if (parsed === null) {
    throw new SettingsError(`The value for "${key}" is not a date.`);
  }

  return parsed;
}

/** Assert a decoded shape, naming what was expected. */
function expect(
  key: string,
  type: SettingType,
  value: unknown,
  condition: boolean,
  expected: string,
): unknown {
  if (!condition) {
    throw new SettingDecodeError(key, type, `expected ${expected}, got ${describe(value)}`);
  }

  return value;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  return `a ${typeof value}`;
}

/**
 * Anything `toDateTime()` can convert: a `DateTime`, a `Date`, an ISO
 * string or an epoch number.
 *
 * A custom rule rather than the built-in `date()` because that one's
 * `parseDate()` has no `DateTime` arm, so the type this framework
 * actually passes around would fail its own type check — and
 * `set(key, await get(key))`, which is what an admin form round trip
 * amounts to, would be rejected.
 *
 * Shares the conversion with `toDateTime()` rather than re-implementing
 * it, so "what counts as a date" cannot drift between the rule that
 * accepts a value and the encoder that stores it.
 */
class IsDateTimeLike extends ValidationRule {
  run(attribute: string, value: unknown): this {
    try {
      toDateTime(attribute, value);

      return this.pass();
    } catch {
      return this.fail(`The ${attribute.replace(/_/g, " ")} field must be a date.`);
    }
  }
}
