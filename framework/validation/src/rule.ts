import type { ModelLike, Presence, RuleStep, ValueType } from "./types.js";
import { ValidationRule } from "./validation-rule.js";
import { setDefaultAttributes, setDefaultErrors, type DefaultErrorMap } from "./messages.js";
import { setPresenceResolver } from "./presence-resolver.js";
import type { PresenceResolver } from "./types.js";

export type WhenCondition<T, P extends Presence> = boolean | ((rule: Rule<T, P>) => boolean);
export type WhenBranch<T, P extends Presence> =
  Rule<any, any> | Rule<any, any>[] | ((rule: Rule<T, P>) => void);

/**
 * Accept either `(["a", "b"], message?)` or a variadic `("a", "b", …)`.
 * When the first argument is an array we treat the second as an optional
 * message; otherwise every argument is a list entry.
 */
function normalizeListArgs(args: [string[], string?] | string[]): {
  values: string[];
  message?: string;
} {
  if (Array.isArray(args[0])) {
    return { values: args[0], message: args[1] as string | undefined };
  }

  return { values: args as string[] };
}

function tableAndColumn(
  tableOrModel: string | ModelLike,
  column?: string,
): { table: string; column: string } {
  if (typeof tableOrModel === "string") {
    return { table: tableOrModel, column: column ?? "id" };
  }

  return { table: tableOrModel.table, column: column ?? tableOrModel.primaryKeyColumn ?? "id" };
}

/**
 * Fluent validation rule. Every chained call appends a step (Laravel /
 * laravel-rules behaviour). Type-level, the last type-setting call wins
 * (`string` / `number` / `boolean` / `email`); presence is a separate
 * type parameter so `.optional()` / `.required()` stay reversible.
 */
export class Rule<T = unknown, P extends Presence = "required"> {
  private steps: RuleStep[] = [];
  private presence: Presence = "required";
  private valueType: ValueType | undefined;
  private attributeDisplay: string | undefined;
  private bailFlag = false;
  private sometimesFlag = false;

  static make(): Rule<unknown, "required"> {
    return new Rule();
  }

  /**
   * Deep-copy this rule so a module-scope rule can be reused across
   * concurrent validations without leaking steps or state. Steps are
   * copied shallowly (their `params`/`itemRule`/`objectShape` are treated
   * as immutable inputs), and nested item/shape rules are cloned so a
   * mutating chain call on the copy never touches the original.
   */
  clone(): Rule<T, P> {
    const copy = new Rule<T, P>();
    copy.steps = this.steps.map((step) => {
      const next: RuleStep = { ...step };

      if (step.params) {
        next.params = { ...step.params };
      }

      if (step.custom) {
        next.custom = step.custom.clone();
      }

      if (step.itemRule) {
        next.itemRule = step.itemRule.clone();
      }

      if (step.objectShape) {
        const shape: Record<string, Rule<any, any>> = {};

        for (const [key, child] of Object.entries(step.objectShape)) {
          shape[key] = child.clone();
        }

        next.objectShape = shape;
      }

      return next;
    });
    copy.presence = this.presence;
    copy.valueType = this.valueType;
    copy.attributeDisplay = this.attributeDisplay;
    copy.bailFlag = this.bailFlag;
    copy.sometimesFlag = this.sometimesFlag;

    return copy;
  }

  static setDefaultErrors(map: DefaultErrorMap): void {
    setDefaultErrors(map);
  }

  static setDefaultAttributes(map: Record<string, string>): void {
    setDefaultAttributes(map);
  }

  static setPresenceResolver(resolver: PresenceResolver | undefined): void {
    setPresenceResolver(resolver);
  }

  /** @internal */
  getSteps(): RuleStep[] {
    return this.steps;
  }

  /** @internal */
  getPresence(): Presence {
    return this.presence;
  }

  /** @internal */
  getValueType(): ValueType | undefined {
    return this.valueType;
  }

  /** @internal */
  getAttribute(): string | undefined {
    return this.attributeDisplay;
  }

  /** @internal */
  shouldBail(): boolean {
    return this.bailFlag;
  }

  /** @internal */
  isSometimes(): boolean {
    return this.sometimesFlag;
  }

  string(message?: string): Rule<string, P> {
    this.valueType = "string";
    this.steps.push({ name: "string", message });

    return this as unknown as Rule<string, P>;
  }

  number(message?: string): Rule<number, P> {
    this.valueType = "numeric";
    this.steps.push({ name: "numeric", message });

    return this as unknown as Rule<number, P>;
  }

  numeric(message?: string): Rule<number, P> {
    return this.number(message);
  }

  integer(message?: string): Rule<number, P> {
    this.valueType = "integer";
    this.steps.push({ name: "integer", message });

    return this as unknown as Rule<number, P>;
  }

  boolean(message?: string): Rule<boolean, P> {
    this.valueType = "boolean";
    this.steps.push({ name: "boolean", message });

    return this as unknown as Rule<boolean, P>;
  }

  email(message?: string): Rule<string, P> {
    this.valueType = "string";
    this.steps.push({ name: "email", message });

    return this as unknown as Rule<string, P>;
  }

  array<I = unknown>(item?: Rule<I, any>, message?: string): Rule<I[], P> {
    this.valueType = "array";
    this.steps.push({ name: "array", itemRule: item, message });

    return this as unknown as Rule<I[], P>;
  }

  file(message?: string): Rule<File, P> {
    this.valueType = "file";
    this.steps.push({ name: "file", message });

    return this as unknown as Rule<File, P>;
  }

  image(message?: string): Rule<File, P> {
    this.valueType = "file";
    this.steps.push({ name: "image", message });

    return this as unknown as Rule<File, P>;
  }

  /**
   * With a `shape`: validate each declared key and return **only** those
   * keys. With no `shape`: assert the value is a non-null, non-array,
   * non-`File` object and return it **unchanged**.
   *
   * The no-shape form mirrors `array()` with no item rule, and is for a
   * bag whose schema is not known until another field has been read (a
   * driver's config, a webhook payload keyed by its event type). Without
   * it there is no way to spell "an object": `object({})` declares an
   * empty shape, so it strips every key, which is silent data loss for
   * anyone who meant "any object".
   */
  object(message?: string): Rule<Record<string, unknown>, P>;
  object<S extends Record<string, Rule<any, any>>>(
    shape: S,
    message?: string,
  ): Rule<{ [K in keyof S]: import("./types.js").InferRule<S[K]> }, P>;
  object(shapeOrMessage?: Record<string, Rule<any, any>> | string, message?: string): Rule<any, P> {
    this.valueType = "object";

    if (shapeOrMessage === undefined || typeof shapeOrMessage === "string") {
      // `objectShape` left absent, not `{}`: the validator distinguishes
      // "no shape given" (pass the contents through) from "empty shape
      // given" (strip everything), and `{}` is the latter.
      this.steps.push({ name: "object", message: shapeOrMessage });

      return this as unknown as Rule<Record<string, unknown>, P>;
    }

    this.steps.push({ name: "object", objectShape: shapeOrMessage, message });

    return this as unknown as Rule<any, P>;
  }

  required(message?: string): Rule<T, "required"> {
    this.presence = "required";
    this.steps.push({ name: "required", message });

    return this as unknown as Rule<T, "required">;
  }

  optional(): Rule<T, "optional"> {
    this.presence = "optional";
    this.steps.push({ name: "optional" });

    return this as unknown as Rule<T, "optional">;
  }

  nullable(): Rule<T, "nullable"> {
    this.presence = "nullable";
    this.steps.push({ name: "nullable" });

    return this as unknown as Rule<T, "nullable">;
  }

  nullish(): Rule<T, "nullish"> {
    this.presence = "nullish";
    this.steps.push({ name: "nullish" });

    return this as unknown as Rule<T, "nullish">;
  }

  sometimes(): Rule<T, "optional"> {
    // Order-independent: a flag consulted at run time, not a presence
    // mutation. `sometimes().required()` and `required().sometimes()`
    // therefore behave identically. A missing key is skipped, a present
    // one runs every other rule.
    this.sometimesFlag = true;
    this.steps.push({ name: "sometimes" });

    return this as unknown as Rule<T, "optional">;
  }

  filled(message?: string): this {
    this.steps.push({ name: "filled", message });

    return this;
  }

  present(message?: string): this {
    this.steps.push({ name: "present", message });

    return this;
  }

  min(value: number, message?: string): this {
    this.steps.push({ name: "min", params: { min: value }, message });

    return this;
  }

  max(value: number, message?: string): this {
    this.steps.push({ name: "max", params: { max: value }, message });

    return this;
  }

  between(min: number, max: number, message?: string): this {
    this.steps.push({ name: "between", params: { min, max }, message });

    return this;
  }

  regex(pattern: RegExp, message?: string): this {
    this.steps.push({ name: "regex", params: { pattern }, message });

    return this;
  }

  alpha(message?: string): this {
    this.steps.push({ name: "alpha", message });

    return this;
  }

  alphaNum(message?: string): this {
    this.steps.push({ name: "alpha_num", message });

    return this;
  }

  alphaDash(message?: string): this {
    this.steps.push({ name: "alpha_dash", message });

    return this;
  }

  digits(count: number, message?: string): this {
    this.steps.push({ name: "digits", params: { digits: count }, message });

    return this;
  }

  digitsBetween(min: number, max: number, message?: string): this {
    this.steps.push({ name: "digits_between", params: { min, max }, message });

    return this;
  }

  json(message?: string): this {
    this.steps.push({ name: "json", message });

    return this;
  }

  ip(message?: string): this {
    this.steps.push({ name: "ip", message });

    return this;
  }

  ipv4(message?: string): this {
    this.steps.push({ name: "ipv4", message });

    return this;
  }

  ipv6(message?: string): this {
    this.steps.push({ name: "ipv6", message });

    return this;
  }

  timezone(message?: string): this {
    this.steps.push({ name: "timezone", message });

    return this;
  }

  date(message?: string): this {
    this.steps.push({ name: "date", message });

    return this;
  }

  dateFormat(format: string, message?: string): this {
    this.steps.push({ name: "date_format", params: { format }, message });

    return this;
  }

  after(date: string, message?: string): this {
    this.steps.push({ name: "after", params: { date }, message });

    return this;
  }

  afterOrEqual(date: string, message?: string): this {
    this.steps.push({ name: "after_or_equal", params: { date }, message });

    return this;
  }

  before(date: string, message?: string): this {
    this.steps.push({ name: "before", params: { date }, message });

    return this;
  }

  beforeOrEqual(date: string, message?: string): this {
    this.steps.push({ name: "before_or_equal", params: { date }, message });

    return this;
  }

  startsWith(prefix: string | string[], message?: string): this {
    const values = Array.isArray(prefix) ? prefix : [prefix];
    this.steps.push({ name: "starts_with", params: { values }, message });

    return this;
  }

  endsWith(suffix: string | string[], message?: string): this {
    const values = Array.isArray(suffix) ? suffix : [suffix];
    this.steps.push({ name: "ends_with", params: { values }, message });

    return this;
  }

  lowercase(message?: string): this {
    this.steps.push({ name: "lowercase", message });

    return this;
  }

  uppercase(message?: string): this {
    this.steps.push({ name: "uppercase", message });

    return this;
  }

  confirmed(message?: string): this {
    this.steps.push({ name: "confirmed", message });

    return this;
  }

  in(values: readonly unknown[], message?: string): this {
    this.steps.push({ name: "in", params: { values: [...values] }, message });

    return this;
  }

  notIn(values: readonly unknown[], message?: string): this {
    this.steps.push({ name: "not_in", params: { values: [...values] }, message });

    return this;
  }

  same(other: string, message?: string): this {
    this.steps.push({ name: "same", params: { other }, message });

    return this;
  }

  different(other: string, message?: string): this {
    this.steps.push({ name: "different", params: { other }, message });

    return this;
  }

  multipleOf(value: number, message?: string): this {
    this.steps.push({ name: "multiple_of", params: { value }, message });

    return this;
  }

  size(value: number, message?: string): this {
    this.steps.push({ name: "size", params: { size: value }, message });

    return this;
  }

  gt(other: string, message?: string): this {
    this.steps.push({ name: "gt", params: { other }, message });

    return this;
  }

  gte(other: string, message?: string): this {
    this.steps.push({ name: "gte", params: { other }, message });

    return this;
  }

  lt(other: string, message?: string): this {
    this.steps.push({ name: "lt", params: { other }, message });

    return this;
  }

  lte(other: string, message?: string): this {
    this.steps.push({ name: "lte", params: { other }, message });

    return this;
  }

  accepted(message?: string): this {
    this.steps.push({ name: "accepted", message });

    return this;
  }

  declined(message?: string): this {
    this.steps.push({ name: "declined", message });

    return this;
  }

  prohibited(message?: string): this {
    this.steps.push({ name: "prohibited", message });

    return this;
  }

  prohibitedIf(other: string, value: unknown, message?: string): this {
    this.steps.push({ name: "prohibited_if", params: { other, value }, message });

    return this;
  }

  prohibitedUnless(other: string, value: unknown, message?: string): this {
    this.steps.push({ name: "prohibited_unless", params: { other, value }, message });

    return this;
  }

  distinct(options?: { strict?: boolean; ignoreCase?: boolean }, message?: string): this {
    this.steps.push({
      name: "distinct",
      params: { strict: options?.strict ?? false, ignoreCase: options?.ignoreCase ?? false },
      message,
    });

    return this;
  }

  requiredArrayKeys(...keys: string[]): this {
    this.steps.push({ name: "required_array_keys", params: { keys } });

    return this;
  }

  exclude(): this {
    this.steps.push({ name: "exclude" });

    return this;
  }

  excludeIf(other: string, value: unknown): this {
    this.steps.push({ name: "exclude_if", params: { other, value } });

    return this;
  }

  excludeUnless(other: string, value: unknown): this {
    this.steps.push({ name: "exclude_unless", params: { other, value } });

    return this;
  }

  uuid(message?: string): this {
    this.steps.push({ name: "uuid", message });

    return this;
  }

  ulid(message?: string): this {
    this.steps.push({ name: "ulid", message });

    return this;
  }

  /**
   * A valid absolute URL whose scheme is allowed.
   *
   * Defaults to `http`/`https` only. `new URL()` alone accepts
   * `javascript:`, `data:` and `file:`, so a bare parse check would let a
   * stored-XSS payload through validation and into an `href`.
   *
   *   rule().string().url()                        // http, https
   *   rule().string().url(["https"])               // https only
   *   rule().string().url(["http", "https", "mailto"])
   *
   * Pass a message as the second argument, or as the first when not
   * narrowing the schemes.
   */
  url(message?: string): this;
  url(schemes: string[], message?: string): this;
  url(schemesOrMessage?: string[] | string, message?: string): this {
    const schemes = Array.isArray(schemesOrMessage) ? schemesOrMessage : undefined;
    const text = Array.isArray(schemesOrMessage) ? message : schemesOrMessage;

    this.steps.push({
      name: "url",
      message: text,
      ...(schemes ? { params: { schemes: schemes.map((s) => s.toLowerCase()) } } : {}),
    });

    return this;
  }

  /**
   * One of a TypeScript enum's member values.
   *
   * Strict, no coercion, so a numeric enum rejects the string `"1"`. Put a
   * coercing type rule first (`rule().integer().enum(Priority)`) when the
   * input arrives form-encoded.
   *
   * Note the member *values*, not its keys. That distinction is invisible
   * for a string enum but not for a numeric one, which TypeScript compiles
   * with a reverse mapping:
   *
   *   enum Priority { Low, High }
   *   // → { Low: 0, High: 1, 0: "Low", 1: "High" }
   *   Object.values(Priority)  // ["Low", "High", 0, 1]
   *
   * A bare `Object.values()` therefore admits `"Low"` and `"High"`, keys,
   * not values, and outside the declared `E[keyof E]` return type. See
   * `enumMemberValues()`.
   */
  enum<E extends Record<string, string | number>>(
    tsEnum: E,
    message?: string,
  ): Rule<E[keyof E], P> {
    this.steps.push({ name: "enum", params: { values: enumMemberValues(tsEnum) }, message });

    return this as unknown as Rule<E[keyof E], P>;
  }

  mimes(types: string[], message?: string): this;
  mimes(...types: string[]): this;
  mimes(...args: [string[], string?] | string[]): this {
    const { values, message } = normalizeListArgs(args);
    this.steps.push({ name: "mimes", params: { values }, message });

    return this;
  }

  extensions(exts: string[], message?: string): this;
  extensions(...exts: string[]): this;
  extensions(...args: [string[], string?] | string[]): this {
    const { values, message } = normalizeListArgs(args);
    this.steps.push({ name: "extensions", params: { values }, message });

    return this;
  }

  requiredIf(other: string, value: unknown, message?: string): this {
    this.steps.push({ name: "required_if", params: { other, value }, message });

    return this;
  }

  requiredUnless(other: string, value: unknown, message?: string): this {
    this.steps.push({ name: "required_unless", params: { other, value }, message });

    return this;
  }

  requiredWith(others: string[], message?: string): this;
  requiredWith(...others: string[]): this;
  requiredWith(...args: [string[], string?] | string[]): this {
    const { values, message } = normalizeListArgs(args);
    this.steps.push({ name: "required_with", params: { others: values }, message });

    return this;
  }

  requiredWithout(others: string[], message?: string): this;
  requiredWithout(...others: string[]): this;
  requiredWithout(...args: [string[], string?] | string[]): this {
    const { values, message } = normalizeListArgs(args);
    this.steps.push({ name: "required_without", params: { others: values }, message });

    return this;
  }

  exists(tableOrModel: string | ModelLike, column?: string, message?: string): this {
    const { table, column: col } = tableAndColumn(tableOrModel, column);
    this.steps.push({ name: "exists", params: { table, column: col }, message });

    return this;
  }

  unique(tableOrModel: string | ModelLike, column?: string, message?: string): this {
    const { table, column: col } = tableAndColumn(tableOrModel, column);
    this.steps.push({ name: "unique", params: { table, column: col }, message });

    return this;
  }

  ignore(id: unknown, column = "id"): this {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i];

      if (step?.name === "unique") {
        step.params = { ...step.params, ignoreId: id, ignoreColumn: column };
        break;
      }
    }

    return this;
  }

  when(cond: WhenCondition<T, P>, then: WhenBranch<T, P>, otherwise?: WhenBranch<T, P>): this {
    const pass = typeof cond === "function" ? cond(this) : cond;
    this.applyBranch(pass ? then : otherwise);

    return this;
  }

  unless(cond: WhenCondition<T, P>, then: WhenBranch<T, P>, otherwise?: WhenBranch<T, P>): this {
    const pass = typeof cond === "function" ? cond(this) : cond;
    this.applyBranch(pass ? otherwise : then);

    return this;
  }

  with(fn: (rule: this) => void): this {
    fn(this);

    return this;
  }

  rule(custom: ValidationRule | Rule<any, any> | Array<ValidationRule | Rule<any, any>>): this {
    const items = Array.isArray(custom) ? custom : [custom];

    for (const item of items) {
      if (item instanceof ValidationRule) {
        this.steps.push({ name: "custom", custom: item });
      } else {
        this.steps.push(...item.getSteps());

        if (item.getAttribute() && !this.attributeDisplay) {
          this.attributeDisplay = item.getAttribute();
        }

        if (item.shouldBail()) {
          this.bailFlag = true;
        }

        if (item.isSometimes()) {
          this.sometimesFlag = true;
        }
      }
    }

    return this;
  }

  as(attribute: string): this {
    this.attributeDisplay = attribute;

    return this;
  }

  bail(): this {
    this.bailFlag = true;

    return this;
  }

  private applyBranch(branch?: WhenBranch<T, P>): void {
    if (!branch) {
      return;
    }

    if (typeof branch === "function") {
      branch(this);

      return;
    }

    this.rule(branch);
  }
}

/**
 * A TypeScript enum's member values, with a numeric enum's reverse-mapping
 * entries removed.
 *
 * TypeScript compiles `enum Priority { Low, High }` to an object carrying
 * both directions, `{ Low: 0, High: 1, 0: "Low", 1: "High" }`, so
 * `Object.values()` yields `["Low", "High", 0, 1]` and a naive membership
 * check accepts the key `"High"` as though it were a value.
 *
 * A reverse entry is identifiable without guessing: its key is the string
 * form of a number, and the value it points at is itself a key of the same
 * object that maps back to it. Checking the round trip rather than just
 * "is the key numeric" keeps a legitimate string enum like
 * `{ "0": "zero" }` intact, since `zero` is not a key.
 *
 * String enums have no reverse mapping and pass through unchanged.
 */
function enumMemberValues(tsEnum: Record<string, string | number>): unknown[] {
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(tsEnum)) {
    const isReverseEntry =
      /^\d+$/.test(key) && typeof value === "string" && tsEnum[value] === Number(key);

    if (!isReverseEntry) {
      values.push(value);
    }
  }

  return values;
}

export function rule(): Rule<unknown, "required"> {
  return Rule.make();
}

export function numberRule(message?: string): Rule<number, "required"> {
  return rule().number(message);
}

export function booleanRule(message?: string): Rule<boolean, "required"> {
  return rule().boolean(message);
}

export function stringRule(message?: string): Rule<string, "required"> {
  return rule().string(message);
}

export function fileRule(message?: string): Rule<File, "required"> {
  return rule().file(message);
}

export function objectRule(message?: string): Rule<Record<string, unknown>, "required">;
export function objectRule<S extends Record<string, Rule<any, any>>>(
  shape: S,
  message?: string,
): Rule<{ [K in keyof S]: import("./types.js").InferRule<S[K]> }, "required">;
export function objectRule(
  shapeOrMessage?: Record<string, Rule<any, any>> | string,
  message?: string,
): Rule<any, "required"> {
  return typeof shapeOrMessage === "object"
    ? rule().object(shapeOrMessage, message)
    : rule().object(shapeOrMessage);
}
