import type { RuleStep, ValueType } from "./types.js";
import type { Rule } from "./rule.js";
import { attributeName, defaultMessage, interpolate } from "./messages.js";
import { getPresenceResolver } from "./presence-resolver.js";
import { ValidationException } from "./validation-exception.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * 26 Crockford base32 characters (I, L, O and U excluded), with the first
 * constrained to `0-7`.
 *
 * That leading constraint matters. A ULID's first 10 characters
 * encode a 48-bit millisecond timestamp, and base32 char 1 carries its
 * high bits, so anything above `7` describes a timestamp larger than
 * 2^48-1, which cannot be decoded. `ZZZZZZZZZZZZZZZZZZZZZZZZZZ` is 26
 * legal characters and still not a ULID.
 */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const ALPHA_DASH_RE = /^[A-Za-z0-9_-]+$/;
/**
 * Schemes `url()` accepts unless the caller names their own.
 *
 * Deliberately just the two web schemes. `mailto:`, `tel:` and friends are
 * legitimate but are not what a bare `url()` means, and admitting them by
 * default would also admit the dangerous ones by the same logic. There is
 * no principled line between `mailto:` and `javascript:` other than an
 * explicit list.
 */
const DEFAULT_URL_SCHEMES = ["http", "https"];
const ALPHA_RE = /^[A-Za-z]+$/;
const ALPHA_NUM_RE = /^[A-Za-z0-9]+$/;
const DIGITS_RE = /^\d+$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))$/;
const ACCEPTED_VALUES = new Set(["yes", "on", "1", "true", 1, true]);
const DECLINED_VALUES = new Set(["no", "off", "0", "false", 0, false]);
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
]);
const BOOLEAN_TRUTHY = new Set([true, 1, "1", "true", "on", "yes"]);
const BOOLEAN_FALSY = new Set([false, 0, "0", "false", "off", "no"]);

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

function isMissing(value: unknown): boolean {
  return value === undefined;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === "string" && value.trim() === "") {
    return true;
  }

  if (Array.isArray(value) && value.length === 0) {
    return true;
  }

  if (isFile(value) && value.size === 0) {
    return true;
  }

  return false;
}

function hasKey(
  data: Record<string, unknown>,
  files: Record<string, File | File[]>,
  key: string,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(data, key) ||
    Object.prototype.hasOwnProperty.call(files, key)
  );
}

function getDot(data: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) {
    return data[path];
  }

  let current: unknown = data;

  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * The "size" of a value for the size rules (min/max/between/size/gt-lte).
 *
 * For a numeric value this is the number itself, which is `NaN` when the
 * value doesn't actually parse as a number (e.g. a `numeric`-typed field
 * that failed its `numeric` step but wasn't bailed on). Callers MUST treat
 * `NaN` as a failure: `NaN < min` and `NaN > max` are both false, so
 * without an explicit guard a non-numeric string would silently satisfy
 * every size bound.
 */
function sizeOf(value: unknown, valueType: ValueType | undefined): number {
  if (valueType === "numeric" || valueType === "integer" || typeof value === "number") {
    return Number(value);
  }

  if (valueType === "array" || Array.isArray(value)) {
    return Array.isArray(value) ? value.length : 0;
  }

  if (valueType === "file" || isFile(value)) {
    return isFile(value) ? value.size / 1024 : 0;
  }

  return String(value ?? "").length;
}

function sizeType(valueType: ValueType | undefined, value: unknown): string {
  if (valueType === "numeric" || valueType === "integer" || typeof value === "number") {
    return "numeric";
  }

  if (valueType === "array" || Array.isArray(value)) {
    return "array";
  }

  if (valueType === "file" || isFile(value)) {
    return "file";
  }

  return "string";
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }

  return undefined;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }

  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (BOOLEAN_TRUTHY.has(value as never)) {
    return true;
  }

  if (BOOLEAN_FALSY.has(value as never)) {
    return false;
  }

  return undefined;
}

function mimeSubtype(file: File): string {
  const type = file.type.toLowerCase();
  const slash = type.indexOf("/");

  return slash === -1 ? type : type.slice(slash + 1);
}

function fileExtension(file: File): string {
  const name = file.name;
  const dot = name.lastIndexOf(".");

  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export class Validator {
  private errorBag: Record<string, string[]> = {};
  private validatedData: Record<string, unknown> = {};
  private passed: boolean | undefined;

  private rules: Record<string, Rule<any, any>>;

  constructor(
    private data: Record<string, unknown>,
    private files: Record<string, File | File[]>,
    rules: Record<string, Rule<any, any>>,
  ) {
    // Clone every rule so a module-scope rule shared across requests can't
    // leak steps or custom-rule state between concurrent validations.
    const cloned: Record<string, Rule<any, any>> = {};

    for (const [field, rule] of Object.entries(rules)) {
      cloned[field] = rule.clone();
    }

    this.rules = cloned;
  }

  async passes(): Promise<boolean> {
    if (this.passed !== undefined) {
      return this.passed;
    }

    this.errorBag = {};
    this.validatedData = {};

    for (const [field, rule] of Object.entries(this.rules)) {
      const result = await this.validateField(field, rule, this.data, this.files);

      if (result.skip) {
        continue;
      }

      if (result.errors.length > 0) {
        this.errorBag[field] = [...(this.errorBag[field] ?? []), ...result.errors];
        // Nested validators may have already written dotted keys.
        continue;
      }

      if (result.include) {
        this.setValidated(field, result.value);
      }
    }

    this.passed = Object.keys(this.errorBag).length === 0;

    return this.passed;
  }

  errors(): Record<string, string[]> {
    return this.errorBag;
  }

  validated(): Record<string, unknown> {
    if (this.passed === undefined) {
      throw new Error("validated() was called before passes(). Await passes() first.");
    }

    if (!this.passed) {
      throw new ValidationException(this.errorBag);
    }

    return this.validatedData;
  }

  private setValidated(field: string, value: unknown): void {
    if (!field.includes(".")) {
      this.validatedData[field] = value;

      return;
    }

    const parts = field.split(".");
    let cursor: Record<string, unknown> = this.validatedData;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = cursor[part];

      if (next === undefined || typeof next !== "object" || next === null) {
        const following = parts[i + 1];
        const nest: Record<string, unknown> | unknown[] =
          following !== undefined && /^\d+$/.test(following) ? [] : {};
        cursor[part] = nest;
      }

      cursor = cursor[part] as Record<string, unknown>;
    }

    cursor[parts[parts.length - 1]!] = value;
  }

  private addError(field: string, message: string): void {
    (this.errorBag[field] ??= []).push(message);
  }

  private async validateField(
    field: string,
    rule: Rule<any, any>,
    data: Record<string, unknown>,
    files: Record<string, File | File[]>,
    explicit?: { value: unknown; present: boolean },
  ): Promise<{ skip: boolean; include: boolean; value: unknown; errors: string[] }> {
    const presence = rule.getPresence();
    const display = rule.getAttribute();
    let value: unknown =
      explicit !== undefined
        ? explicit.value
        : files[field] !== undefined
          ? files[field]
          : getDot(data, field);
    const present =
      explicit !== undefined
        ? explicit.present
        : hasKey(data, files, field) || (field.includes(".") && getDot(data, field) !== undefined);
    const errors: string[] = [];
    let valueType = rule.getValueType();

    const fail = (
      step: RuleStep,
      extras: Record<string, string | number | undefined> = {},
      overrideMessage?: string,
    ): void => {
      const type = sizeType(valueType, value);
      const template = overrideMessage ?? step.message ?? defaultMessage(step.name, type);
      errors.push(
        interpolate(template, {
          attribute: attributeName(field, display),
          min: step.params?.["min"] as number | undefined,
          max: step.params?.["max"] as number | undefined,
          value: (step.params?.["value"] as string | number | undefined) ?? String(value ?? ""),
          other: humanizeOther(step.params?.["other"] as string | undefined),
          values: formatValues(step.params?.["values"]),
          ...extras,
        }),
      );
    };

    const missing = isMissing(value) || (!present && value === undefined);

    // exclude*, drop the field from validated() entirely (no errors) when
    // the condition holds. Evaluated first so an excluded field never runs
    // any other rule.
    for (const step of rule.getSteps()) {
      if (step.name === "exclude") {
        return { skip: true, include: false, value, errors: [] };
      }

      if (
        step.name === "exclude_if" &&
        looseEquals(this.data[step.params?.["other"] as string], step.params?.["value"])
      ) {
        return { skip: true, include: false, value, errors: [] };
      }

      if (
        step.name === "exclude_unless" &&
        !looseEquals(this.data[step.params?.["other"] as string], step.params?.["value"])
      ) {
        return { skip: true, include: false, value, errors: [] };
      }
    }

    // prohibited*. The field must be missing/empty when the condition
    // holds; a present, non-empty value is an error.
    for (const step of rule.getSteps()) {
      const prohibited =
        step.name === "prohibited" ||
        (step.name === "prohibited_if" &&
          looseEquals(this.data[step.params?.["other"] as string], step.params?.["value"])) ||
        (step.name === "prohibited_unless" &&
          !looseEquals(this.data[step.params?.["other"] as string], step.params?.["value"]));

      if (prohibited && !missing && !isEmpty(value)) {
        fail({ name: "prohibited", message: step.message }, {}, step.message);

        return { skip: false, include: false, value, errors };
      }

      if (prohibited) {
        // Prohibited and absent/empty: nothing further to validate.
        return { skip: true, include: false, value, errors: [] };
      }
    }

    // Conditional required* steps can force a required failure even on a
    // field declared optional()/sometimes(), so they run before the
    // missing-key skips below.
    for (const step of rule.getSteps()) {
      let triggered = false;

      if (
        step.name === "required_if" &&
        looseEquals(this.data[step.params?.["other"] as string], step.params?.["value"])
      ) {
        triggered = true;
      } else if (
        step.name === "required_unless" &&
        !looseEquals(this.data[step.params?.["other"] as string], step.params?.["value"])
      ) {
        triggered = true;
      } else if (step.name === "required_with") {
        const others = step.params?.["others"] as string[];
        triggered = others.some((key) => !isMissing(this.data[key]) && !isEmpty(this.data[key]));
      } else if (step.name === "required_without") {
        const others = step.params?.["others"] as string[];
        triggered = others.some((key) => isMissing(this.data[key]) || isEmpty(this.data[key]));
      }

      if (triggered && (missing || isEmpty(value))) {
        fail({ name: "required", message: step.message });

        return { skip: false, include: false, value, errors };
      }
    }

    // `sometimes()` is order-independent: a missing key is skipped
    // regardless of where `.sometimes()` sits in the chain or what
    // presence (`required`/`optional`) was declared alongside it.
    if (rule.isSometimes() && missing) {
      return { skip: true, include: false, value, errors: [] };
    }

    if (presence === "optional" || presence === "nullish") {
      if (missing) {
        return { skip: true, include: false, value, errors: [] };
      }
    }

    if (presence === "nullable" || presence === "nullish") {
      if (value === null) {
        return { skip: false, include: true, value: null, errors: [] };
      }
    }

    if (presence === "required" && (missing || isEmpty(value))) {
      fail({ name: "required", message: this.presenceMessage(rule, "required") });

      return { skip: false, include: false, value, errors };
    }

    let typeFailed = false;
    let nestedFailed = false;

    for (const step of rule.getSteps()) {
      if (
        step.name === "required" ||
        step.name === "optional" ||
        step.name === "nullable" ||
        step.name === "nullish" ||
        step.name === "sometimes" ||
        step.name === "exclude" ||
        (step.name.startsWith("required_") && step.name !== "required_array_keys") ||
        step.name.startsWith("prohibited") ||
        step.name.startsWith("exclude_")
      ) {
        continue;
      }

      if (typeFailed && isConstraint(step.name)) {
        continue;
      }

      const outcome = await this.runStep(step, field, value, data, files, valueType);

      if (outcome.status === "fail") {
        fail(step, outcome.extras ?? {}, outcome.extras?.["message"] as string | undefined);

        if (isTypeStep(step.name)) {
          typeFailed = true;
        }

        if (rule.shouldBail()) {
          break;
        }

        continue;
      }

      if (outcome.status === "skip_field") {
        return { skip: true, include: false, value, errors: [] };
      }

      if (outcome.value !== undefined) {
        value = outcome.value;
      }

      if (outcome.valueType) {
        valueType = outcome.valueType;
      }

      if (outcome.nestedErrors) {
        nestedFailed = true;

        for (const [nestedField, nestedMessages] of Object.entries(outcome.nestedErrors)) {
          this.errorBag[nestedField] = [...(this.errorBag[nestedField] ?? []), ...nestedMessages];
        }

        if (rule.shouldBail()) {
          break;
        }
      }
    }

    return { skip: false, include: errors.length === 0 && !nestedFailed, value, errors };
  }

  private presenceMessage(rule: Rule<any, any>, name: string): string | undefined {
    return rule.getSteps().find((step) => step.name === name)?.message;
  }

  private async runStep(
    step: RuleStep,
    field: string,
    value: unknown,
    data: Record<string, unknown>,
    files: Record<string, File | File[]>,
    valueType: ValueType | undefined,
  ): Promise<{
    status: "pass" | "fail" | "skip_field";
    value?: unknown;
    valueType?: ValueType;
    extras?: Record<string, string | number | undefined>;
    nestedErrors?: Record<string, string[]>;
  }> {
    switch (step.name) {
      case "string": {
        if (typeof value !== "string") {
          return { status: "fail" };
        }

        return { status: "pass", value, valueType: "string" };
      }
      case "numeric": {
        const n = parseNumber(value);

        if (n === undefined) {
          return { status: "fail" };
        }

        return { status: "pass", value: n, valueType: "numeric" };
      }
      case "integer": {
        const n = parseInteger(value);

        if (n === undefined) {
          return { status: "fail" };
        }

        return { status: "pass", value: n, valueType: "integer" };
      }
      case "boolean": {
        const b = parseBoolean(value);

        if (b === undefined) {
          return { status: "fail" };
        }

        return { status: "pass", value: b, valueType: "boolean" };
      }
      case "email": {
        if (typeof value !== "string" || !EMAIL_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass", value, valueType: "string" };
      }
      case "array": {
        const arr = isFile(value) ? [value] : value;

        if (!Array.isArray(arr)) {
          return { status: "fail" };
        }

        if (!step.itemRule) {
          return { status: "pass", value: arr, valueType: "array" };
        }

        const items: unknown[] = [];
        const nestedErrors: Record<string, string[]> = {};

        for (let i = 0; i < arr.length; i++) {
          const itemField = `${field}.${i}`;
          const result = await this.validateField(itemField, step.itemRule, data, files, {
            value: arr[i],
            present: true,
          });

          if (result.errors.length > 0) {
            nestedErrors[itemField] = result.errors;
          } else if (result.include) {
            items.push(result.value);
          } else if (!result.skip) {
            items.push(arr[i]);
          }
        }

        if (Object.keys(nestedErrors).length > 0) {
          return { status: "pass", value: arr, valueType: "array", nestedErrors };
        }

        return { status: "pass", value: items, valueType: "array" };
      }
      case "object": {
        if (value === null || typeof value !== "object" || Array.isArray(value) || isFile(value)) {
          return { status: "fail" };
        }

        // No shape declared: the type assertion above is the whole rule,
        // and the contents pass through untouched. Mirrors `array()` with
        // no item rule. An empty shape (`object({})`) is a declaration
        // that the object has no keys, and still strips them all.
        if (step.objectShape === undefined) {
          return { status: "pass", value, valueType: "object" };
        }

        const shape = step.objectShape;
        const input = value as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        const nestedErrors: Record<string, string[]> = {};

        for (const [key, child] of Object.entries(shape)) {
          const childField = `${field}.${key}`;
          const result = await this.validateField(childField, child, data, files, {
            value: input[key],
            present: Object.prototype.hasOwnProperty.call(input, key),
          });

          if (result.errors.length > 0) {
            nestedErrors[childField] = result.errors;
          } else if (result.include) {
            output[key] = result.value;
          }
        }

        if (Object.keys(nestedErrors).length > 0) {
          return { status: "pass", value: output, valueType: "object", nestedErrors };
        }

        return { status: "pass", value: output, valueType: "object" };
      }
      case "file": {
        if (!isFile(value)) {
          return { status: "fail" };
        }

        return { status: "pass", value, valueType: "file" };
      }
      case "image": {
        if (!isFile(value) || !IMAGE_MIMES.has(value.type.toLowerCase())) {
          return { status: "fail" };
        }

        return { status: "pass", value, valueType: "file" };
      }
      case "min": {
        const size = sizeOf(value, valueType);

        if (Number.isNaN(size) || size < (step.params?.["min"] as number)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "max": {
        const size = sizeOf(value, valueType);

        if (Number.isNaN(size) || size > (step.params?.["max"] as number)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "between": {
        const size = sizeOf(value, valueType);

        if (
          Number.isNaN(size) ||
          size < (step.params?.["min"] as number) ||
          size > (step.params?.["max"] as number)
        ) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "regex": {
        const pattern = step.params?.["pattern"] as RegExp;

        if (typeof value !== "string" || !pattern.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "alpha": {
        if (typeof value !== "string" || !ALPHA_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "alpha_num": {
        if (typeof value !== "string" || !ALPHA_NUM_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "alpha_dash": {
        if (typeof value !== "string" || !ALPHA_DASH_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "digits": {
        const digits = step.params?.["digits"] as number;
        const str = typeof value === "number" ? String(value) : value;

        if (typeof str !== "string" || !DIGITS_RE.test(str) || str.length !== digits) {
          return { status: "fail", extras: { digits } };
        }

        return { status: "pass" };
      }
      case "digits_between": {
        const min = step.params?.["min"] as number;
        const max = step.params?.["max"] as number;
        const str = typeof value === "number" ? String(value) : value;

        if (
          typeof str !== "string" ||
          !DIGITS_RE.test(str) ||
          str.length < min ||
          str.length > max
        ) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "size": {
        const size = sizeOf(value, valueType);

        if (Number.isNaN(size) || size !== (step.params?.["size"] as number)) {
          return { status: "fail", extras: { size: step.params?.["size"] as number } };
        }

        return { status: "pass" };
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const other = step.params?.["other"] as string;
        const otherRaw = getDot(data, other);
        const a = sizeOf(value, valueType);
        const b = sizeOf(otherRaw, sizeType(undefined, otherRaw) as ValueType);

        if (Number.isNaN(a) || Number.isNaN(b)) {
          return { status: "fail", extras: { value: b, other: humanizeOther(other) } };
        }

        const ok =
          step.name === "gt"
            ? a > b
            : step.name === "gte"
              ? a >= b
              : step.name === "lt"
                ? a < b
                : a <= b;

        if (!ok) {
          return { status: "fail", extras: { value: b, other: humanizeOther(other) } };
        }

        return { status: "pass" };
      }
      case "json": {
        if (typeof value !== "string") {
          return { status: "fail" };
        }

        try {
          JSON.parse(value);
        } catch {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "ip": {
        if (typeof value !== "string" || (!IPV4_RE.test(value) && !IPV6_RE.test(value))) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "ipv4": {
        if (typeof value !== "string" || !IPV4_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "ipv6": {
        if (typeof value !== "string" || !IPV6_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "timezone": {
        if (typeof value !== "string" || !isValidTimezone(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "date": {
        if (parseDate(value) === undefined) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "date_format": {
        const format = step.params?.["format"] as string;

        if (typeof value !== "string" || !matchesDateFormat(value, format)) {
          return { status: "fail", extras: { format } };
        }

        return { status: "pass" };
      }
      case "after":
      case "after_or_equal":
      case "before":
      case "before_or_equal": {
        const target = step.params?.["date"] as string;
        const a = parseDate(value);
        const b = parseDate(getDot(data, target)) ?? parseDate(target);

        if (a === undefined || b === undefined) {
          return { status: "fail", extras: { date: target } };
        }

        const ok =
          step.name === "after"
            ? a > b
            : step.name === "after_or_equal"
              ? a >= b
              : step.name === "before"
                ? a < b
                : a <= b;

        if (!ok) {
          return { status: "fail", extras: { date: target } };
        }

        return { status: "pass" };
      }
      case "accepted": {
        if (!ACCEPTED_VALUES.has(value as never)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "declined": {
        if (!DECLINED_VALUES.has(value as never)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "distinct": {
        if (!Array.isArray(value)) {
          return { status: "pass" };
        }

        const strict = step.params?.["strict"] as boolean;
        const ignoreCase = step.params?.["ignoreCase"] as boolean;
        const seen = new Set<unknown>();

        for (const item of value) {
          const key = strict
            ? item
            : ignoreCase && typeof item === "string"
              ? item.toLowerCase()
              : String(item);

          if (seen.has(key)) {
            return { status: "fail" };
          }

          seen.add(key);
        }

        return { status: "pass" };
      }
      case "required_array_keys": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return { status: "fail" };
        }

        const keys = step.params?.["keys"] as string[];
        const obj = value as Record<string, unknown>;

        for (const key of keys) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            return { status: "fail", extras: { values: keys.join(", ") } };
          }
        }

        return { status: "pass" };
      }
      case "starts_with": {
        const values = step.params?.["values"] as string[];

        if (typeof value !== "string" || !values.some((prefix) => value.startsWith(prefix))) {
          return { status: "fail", extras: { values: values.join(", ") } };
        }

        return { status: "pass" };
      }
      case "ends_with": {
        const values = step.params?.["values"] as string[];

        if (typeof value !== "string" || !values.some((suffix) => value.endsWith(suffix))) {
          return { status: "fail", extras: { values: values.join(", ") } };
        }

        return { status: "pass" };
      }
      case "lowercase": {
        if (typeof value !== "string" || value !== value.toLowerCase()) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "uppercase": {
        if (typeof value !== "string" || value !== value.toUpperCase()) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "confirmed": {
        // Resolve `<field>_confirmation` as a sibling of the field: the
        // last path segment gets the suffix, so it works at the top level
        // and inside object()/array() nesting alike.
        const dot = field.lastIndexOf(".");
        const confirmationField =
          dot === -1
            ? `${field}_confirmation`
            : `${field.slice(0, dot)}.${field.slice(dot + 1)}_confirmation`;
        const other = getDot(data, confirmationField);

        if (other !== value) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "in": {
        const values = step.params?.["values"] as unknown[];

        // Non-scalars (arrays/objects) can never legitimately be "in" a
        // list of scalars, String([…]) coercion would let ["admin"] pass
        // in(["admin"]) and reach validated(). Reject them outright.
        if (!isScalar(value)) {
          return { status: "fail" };
        }

        // Strict identity, matching `enum`. The old bidirectional
        // String() coercion let a number 1 satisfy in(["1"]) and a string
        // "1" satisfy in([1]), with typed JSON bodies that quietly admits
        // the wrong type. Declare the type step (.numeric()/.integer())
        // first if the value needs coercing before this compares.
        if (!values.includes(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "not_in": {
        const values = step.params?.["values"] as unknown[];

        if (!isScalar(value)) {
          return { status: "fail" };
        }

        if (values.includes(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "same": {
        const other = step.params?.["other"] as string;

        if (value !== data[other]) {
          return { status: "fail", extras: { other: humanizeOther(other) } };
        }

        return { status: "pass" };
      }
      case "different": {
        const other = step.params?.["other"] as string;

        if (value === data[other]) {
          return { status: "fail", extras: { other: humanizeOther(other) } };
        }

        return { status: "pass" };
      }
      case "multiple_of": {
        const n = parseNumber(value);
        const divisor = step.params?.["value"] as number;

        if (n === undefined || divisor === 0 || n % divisor !== 0) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "uuid": {
        if (typeof value !== "string" || !UUID_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "ulid": {
        if (typeof value !== "string" || !ULID_RE.test(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "url": {
        if (typeof value !== "string") {
          return { status: "fail" };
        }

        let parsed: URL;

        try {
          parsed = new URL(value);
        } catch {
          return { status: "fail" };
        }

        // Parsing alone is not enough. `new URL()` happily accepts
        // `javascript:alert(1)`, `data:text/html,<script>` and
        // `file:///etc/passwd`, every one of which is a valid absolute
        // URL and none of which is safe to put in an `href` or to fetch.
        // A validated URL that a template then renders is the textbook
        // stored-XSS delivery path, so the allow-list is the default and
        // the caller opts *out* by naming the schemes they want.
        const allowed = (step.params?.["schemes"] as string[] | undefined) ?? DEFAULT_URL_SCHEMES;

        if (!allowed.includes(parsed.protocol.replace(/:$/, "").toLowerCase())) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "enum": {
        const values = step.params?.["values"] as unknown[];

        if (!values.includes(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "mimes": {
        if (!isFile(value)) {
          return { status: "fail" };
        }

        const allowed = (step.params?.["values"] as string[]).map((type) => type.toLowerCase());
        const subtype = mimeSubtype(value);
        const full = value.type.toLowerCase();

        if (!allowed.includes(subtype) && !allowed.includes(full)) {
          return { status: "fail", extras: { values: allowed.join(", ") } };
        }

        return { status: "pass" };
      }
      case "extensions": {
        if (!isFile(value)) {
          return { status: "fail" };
        }

        const allowed = (step.params?.["values"] as string[]).map((ext) =>
          ext.toLowerCase().replace(/^\./, ""),
        );

        if (!allowed.includes(fileExtension(value))) {
          return { status: "fail", extras: { values: allowed.join(", ") } };
        }

        return { status: "pass" };
      }
      case "filled": {
        if (hasKey(data, files, field) && isEmpty(value)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "present": {
        if (!hasKey(data, files, field)) {
          return { status: "fail" };
        }

        return { status: "pass" };
      }
      case "exists": {
        const resolver = getPresenceResolver();

        if (!resolver) {
          throw new Error(
            "exists() requires a presence resolver. Register one via Rule.setPresenceResolver().",
          );
        }

        const ok = await resolver.exists(
          step.params?.["table"] as string,
          step.params?.["column"] as string,
          value,
        );

        return { status: ok ? "pass" : "fail" };
      }
      case "unique": {
        const resolver = getPresenceResolver();

        if (!resolver) {
          throw new Error(
            "unique() requires a presence resolver. Register one via Rule.setPresenceResolver().",
          );
        }

        const ignoreId = step.params?.["ignoreId"];
        const ignore =
          ignoreId === undefined || ignoreId === null
            ? undefined
            : { column: (step.params?.["ignoreColumn"] as string) ?? "id", id: ignoreId };
        const unique = await resolver.unique(
          step.params?.["table"] as string,
          step.params?.["column"] as string,
          value,
          ignore,
        );

        return { status: unique ? "pass" : "fail" };
      }
      case "custom": {
        const custom = step.custom;

        if (!custom) {
          return { status: "pass" };
        }

        custom.reset();
        await custom.run(field, value);

        if (custom.failed()) {
          return { status: "fail", extras: { message: custom.message() } };
        }

        return { status: "pass" };
      }
      default:
        return { status: "pass" };
    }
  }
}

function isTypeStep(name: string): boolean {
  return [
    "string",
    "numeric",
    "integer",
    "boolean",
    "email",
    "array",
    "object",
    "file",
    "image",
  ].includes(name);
}

function isConstraint(name: string): boolean {
  return !isTypeStep(name) && name !== "custom";
}

function formatValues(values: unknown): string | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  return values.map(String).join(", ");
}

function humanizeOther(other?: string): string | undefined {
  return other?.replace(/_/g, " ");
}

/**
 * A strict ISO-8601 calendar date, optionally with a time and offset:
 *   2024-03-15
 *   2024-03-15T09:30
 *   2024-03-15T09:30:00
 *   2024-03-15T09:30:00.123
 *   2024-03-15 09:30:00        (space separator, as SQL emits)
 *   2024-03-15T09:30:00Z
 *   2024-03-15T09:30:00+13:00
 */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Parse a value for the date rules to a millisecond timestamp, or
 * `undefined` when it isn't a valid date.
 *
 * Strings must be strict ISO-8601 (see `ISO_DATE_RE`). The old
 * implementation handed the raw string to `Date.parse`, which is
 * implementation-defined and wildly permissive: `Date.parse("2024")`,
 * `Date.parse("garbage 2024")` and assorted locale strings all "succeed",
 * so the `date`/`after`/`before` rules passed inputs Laravel rejects.
 * Gating on the ISO shape first makes the rule deterministic across
 * engines without pulling a date library into this dependency-free package.
 */
function parseDate(value: unknown): number | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (!ISO_DATE_RE.test(trimmed)) {
    return undefined;
  }

  const ms = Date.parse(trimmed);

  return Number.isNaN(ms) ? undefined : ms;
}

const DATE_FORMAT_TOKENS: Record<string, string> = {
  YYYY: "(\\d{4})",
  MM: "(0[1-9]|1[0-2])",
  DD: "(0[1-9]|[12]\\d|3[01])",
  HH: "([01]\\d|2[0-3])",
  mm: "([0-5]\\d)",
  ss: "([0-5]\\d)",
};

function matchesDateFormat(value: string, format: string): boolean {
  // Build a regex from a small token vocabulary; anything else is treated
  // as a literal. Keeps the dependency-free package free of a date lib
  // while covering the common `YYYY-MM-DD`/`HH:mm:ss` shapes.
  const tokenRe = /YYYY|MM|DD|HH|mm|ss/g;
  let pattern = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(format)) !== null) {
    pattern += escapeRegex(format.slice(lastIndex, match.index));
    pattern += DATE_FORMAT_TOKENS[match[0]];
    lastIndex = tokenRe.lastIndex;
  }

  pattern += escapeRegex(format.slice(lastIndex));

  return new RegExp(`^${pattern}$`).test(value);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });

    return true;
  } catch {
    return false;
  }
}

function isScalar(value: unknown): value is string | number | boolean {
  const t = typeof value;

  return t === "string" || t === "number" || t === "boolean";
}

/** Loose scalar comparison. `"1"` matches `1`, `true` matches `"true"`. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }

  if (isScalar(a) && isScalar(b)) {
    return String(a) === String(b);
  }

  return false;
}
