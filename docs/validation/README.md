# Validation

`@mahiframework/validation` provides a fluent `Rule` builder, a `Validator` that
runs it, and a `ValidationException` the HTTP layer renders as a 422. The
package has no dependency on HTTP or the database. It runs in jobs, CLI
commands, and tests as readily as in a request.

```ts
import { Request, rule } from "@mahiframework/http";

export class RegisterRequest extends Request {
  rules() {
    return {
      name: rule().string().required().min(1),
      email: rule().string().email().required().unique(User, "email"),
      password: rule().string().required().min(8),
    } as const;
  }
}
```

The point of departure from Laravel is that rules are **objects, not
strings**. `"required|string|min:8"` can't be type-checked, can't be
refactored, and can't tell you what `validated()` returns. A `Rule` chain
carries its own type, so `request.validated()` is `{ name: string; email:
string; password: string }` with no cast and no separate DTO.

## Building rules

`rule()` starts a chain. Every call appends a step and returns the rule, so
order is preserved, but at the **type** level, the last type-setting call
wins, and presence is tracked in a separate type parameter so
`.optional()` / `.required()` stay reversible.

```ts
class Rule<T = unknown, P extends Presence = "required">
```

`Presence` is `"required" | "optional" | "nullable" | "nullish"`.

Four shortcut factories skip the first call:

| Factory | Equivalent to |
|---|---|
| `rule()` | `Rule.make()`: `Rule<unknown, "required">` |
| `stringRule(message?)` | `rule().string(message)` |
| `numberRule(message?)` | `rule().number(message)` |
| `booleanRule(message?)` | `rule().boolean(message)` |
| `fileRule(message?)` | `rule().file(message)` |
| `objectRule(shape?)` | `rule().object(shape)` |

Nearly every method takes an optional trailing `message` to override the
default error for that step.

### Type rules

These set the value type and coerce the validated output.

| Method | Output type | Accepts |
|---|---|---|
| `string(message?)` | `string` | Only an actual `string`: no coercion |
| `number(message?)` | `number` | A finite number, or a numeric string |
| `numeric(message?)` | `number` | Alias for `number()` |
| `integer(message?)` | `number` | An integer, or a `/^-?\d+$/` string |
| `boolean(message?)` | `boolean` | `true`/`1`/`"1"`/`"true"`/`"on"`/`"yes"` and their falsy counterparts `false`/`0`/`"0"`/`"false"`/`"off"`/`"no"` |
| `email(message?)` | `string` | A string matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| `array<I>(item?)` | `I[]` | An array. A lone `File` is wrapped into `[file]`. `item` validates each element. |
| `object(shape, message?)` | Inferred from `shape` | A non-null, non-array, non-`File` object. `shape` validates each declared key. |
| `object(message?)` | `Record<string, unknown>` | Same, but with no shape the contents pass through unchanged |
| `file(message?)` | `File` | A Web `File` instance |
| `image(message?)` | `File` | A `File` whose MIME is jpeg/png/gif/webp/bmp/svg+xml |

Coercion is real: `numberRule()` on `"5"` puts the **number** `5` into
`validated()`, and `rule().boolean()` on `"on"` puts `true`.

> `string()` does **not** coerce. A JSON number `5` fails
> `stringRule()` with "The s field must be a string." That's intentional,
> silently stringifying means a client sending the wrong type never finds
> out.

### Presence rules

| Method | Result type | Behaviour |
|---|---|---|
| `required(message?)` | `T` | Fails when missing **or empty** |
| `optional()` | `T \| undefined` | Skipped entirely when missing; omitted from `validated()` |
| `nullable()` | `T \| null` | An explicit `null` short-circuits the remaining steps and is kept |
| `nullish()` | `T \| null \| undefined` | Both of the above |
| `sometimes()` | `T \| undefined` | Skipped when missing, but **order-independent**, unlike `optional()`, see below |
| `filled(message?)` | `this` | When the key **is** present, it must not be empty |
| `present(message?)` | `this` | The key must exist, but may be empty |

> **`optional()` defeats `present()`.** `optional()` skips every remaining
> step when the key is missing, so `present()` never runs and the pair
> asserts nothing at all, in either order. It is a contradiction ("may be
> absent" + "must be present") that fails open rather than erroring. Use
> `nullable().present()` if you want "the key must appear, but its value
> may be empty".

"Empty" for `required()` means `undefined`, `null`, `""` (after trimming),
`[]`, or a zero-byte `File`.

The distinction between `optional()` and `nullable()` is which absence
you're allowing. `optional()` permits the key to be missing; `nullable()`
permits it to be explicitly `null`. A PATCH endpoint that must distinguish
"don't change the bio" from "clear the bio" needs `nullish()`:

```ts
bio: rule().string().max(280).nullish(),   // string | null | undefined
```

```ts
if (bio !== undefined) updates.bio = bio;  // null clears it, undefined skips it
```

> **`nullable()` is not Laravel's `nullable`.** In Laravel, `nullable|string`
> passes when the key is **absent**, `nullable` there means "null *or*
> missing is fine". In Mahi, presence is a type-carrying dimension, so the
> four presence rules split that into two axes:
>
> | Mahi | Missing key | Explicit `null` | Inferred type |
> |---|---|---|---|
> | `optional()` / `sometimes()` | skipped | runs remaining rules (fails `string()`) | `T \| undefined` |
> | `nullable()` | **fails required** | kept, skips remaining rules | `T \| null` |
> | `nullish()` | skipped | kept, skips remaining rules | `T \| null \| undefined` |
>
> The Laravel `nullable` you're reaching for is Mahi's **`nullish()`**, it
> allows both a missing key and an explicit `null`. `nullable()` keeps the
> stricter, type-honest meaning "the key must be present, but its value may
> be `null`", matching its inferred `T | null`. If you port `nullable|string`
> literally you'll get a spurious 422 on a missing key; use `nullish()`.

> **`sometimes()` is order-independent.** `sometimes().required()` and
> `required().sometimes()` behave identically: a missing key is skipped, a
> present key runs every other rule (including `required`, so a present-but-
> empty value fails). It matches Laravel's `sometimes`, "validate only when
> present", regardless of chain position.

### Size constraints

`min`, `max`, and `between` measure different things depending on the
value type:

| Value type | Measured |
|---|---|
| `numeric` / `integer` / a JS number | The number itself |
| `array` | `length` |
| `file` | Size in **kilobytes** |
| Anything else | String length |

```ts
rule().string().min(1).max(280);              // 1–280 characters
numberRule().min(1).max(100);                 // the value 1–100
fileRule().image().max(5120);                 // ≤ 5 MB
rule().array(fileRule().image()).max(4);      // ≤ 4 items
```

| Method | |
|---|---|
| `min(value, message?)` | |
| `max(value, message?)` | |
| `between(min, max, message?)` | |

The default message picks the right wording, "at least 5 characters"
versus "at least 5 kilobytes", from the resolved value type.

### String constraints

| Method | Checks |
|---|---|
| `regex(pattern, message?)` | A `RegExp` (not a string) against a string value |
| `alpha(message?)` | `/^[A-Za-z]+$/` |
| `alphaNum(message?)` | `/^[A-Za-z0-9]+$/` |
| `alphaDash(message?)` | `/^[A-Za-z0-9_-]+$/` |
| `digits(count, message?)` | Exactly `count` digits (a number or an all-digit string) |
| `digitsBetween(min, max, message?)` | Between `min` and `max` digits |
| `startsWith(prefix \| prefixes, message?)` | Any listed prefix |
| `endsWith(suffix \| suffixes, message?)` | Any listed suffix |
| `lowercase(message?)` | `value === value.toLowerCase()` |
| `uppercase(message?)` | `value === value.toUpperCase()` |
| `uuid(message?)` | RFC 4122 v-agnostic with an `[89ab]` variant nibble, so the nil and max UUIDs are **rejected** |
| `ulid(message?)` | 26 Crockford base32 characters, first one `0-7` (a larger value is an undecodable timestamp) |
| `url(schemes?, message?)` | An absolute URL whose scheme is allowed, `http`/`https` by default |
| `json(message?)` | Parses as `JSON.parse(…)` |
| `ip(message?)` | A valid IPv4 or IPv6 address |
| `ipv4(message?)` | A valid IPv4 address |
| `ipv6(message?)` | A valid IPv6 address |
| `timezone(message?)` | A valid IANA timezone (checked via `Intl.DateTimeFormat`) |

```ts
username: rule()
  .string()
  .required()
  .regex(/^[a-z0-9_]{3,20}$/, "Usernames must be 3-20 lowercase letters, numbers, or underscores.")
  .unique(User, "username"),
```

> **`url()` allow-lists schemes, and you usually want that.** `new URL()`
> alone accepts `javascript:alert(1)`, `data:text/html,…` and
> `file:///etc/passwd`, all valid absolute URLs, none safe in an `href` or
> as a fetch target. A bare `url()` therefore permits only `http` and
> `https`; name your own to widen or narrow it:
>
> ```ts
> rule().string().url()                        // http, https
> rule().string().url(["https"])               // https only
> rule().string().url(["https", "mailto"])     // opt one back in
> ```
>
> This is stricter than Laravel's default and deliberately so: the failure
> mode is a stored-XSS payload that passed validation.

> **`alphaDash()` is ASCII-only.** Laravel's equivalent accepts Unicode
> letters; this one does not, so `"héllo"` fails. Use an explicit
> `regex(/^[\p{L}\p{N}_-]+$/u)` if you need the wider set.

> **`lowercase()` / `uppercase()` compare against the value's own case
> conversion**, so a string with no case at all (`"123"`, `"日本語"`, an
> emoji) satisfies **both**. They use the locale-invariant
> `toLowerCase()`/`toUpperCase()`, so behaviour does not shift with the host
> locale, but note a lowercase `ß` can never satisfy `uppercase()`, since
> its uppercase form is the two-character `"SS"`.

### Date constraints

| Method | Checks |
|---|---|
| `date(message?)` | A `Date`, an epoch number, or a **strict ISO-8601 string**, not `Date.parse`, which accepts `"2024"` and other partials |
| `dateFormat(format, message?)` | Matches a token format built from `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss` (anything else is a literal) |
| `after(date, message?)` | Later than `date`: a literal date string **or another field name** |
| `afterOrEqual(date, message?)` | Later than or equal to `date` |
| `before(date, message?)` | Earlier than `date` |
| `beforeOrEqual(date, message?)` | Earlier than or equal to `date` |

The comparison argument to `after`/`before` is resolved against the input
data first (so `after("start")` compares to the `start` field) and falls
back to parsing it as a literal date.

```ts
{
  start: rule().date().required(),
  end: rule().date().required().after("start"),
}
```

`dateFormat` is deliberately dependency-free. It covers the common
`YYYY-MM-DD` / `HH:mm:ss` shapes without pulling in a date library. For
anything more exotic, validate with a custom rule.

### Value constraints

| Method | Checks |
|---|---|
| `in(values, message?)` | A **scalar** value that's in the list (non-scalars are rejected) |
| `notIn(values, message?)` | A scalar value that isn't in the list |
| `enum(tsEnum, message?)` | The value is one of `Object.values(tsEnum)`. Narrows the type to `E[keyof E]`. |
| `same(other, message?)` | Strictly equals `data[other]` |
| `different(other, message?)` | Doesn't |
| `confirmed(message?)` | Equals the sibling `<field>_confirmation` (resolved relative to the parent, so it works inside `object()`/`array()`) |
| `multipleOf(value, message?)` | `n % divisor === 0` |
| `size(value, message?)` | Exact size, number value, string length, array length, or file KB |
| `gt(other, message?)` | Size greater than the `other` field's size |
| `gte(other, message?)` | Greater than or equal |
| `lt(other, message?)` | Less than |
| `lte(other, message?)` | Less than or equal |
| `accepted(message?)` | One of `"yes"`, `"on"`, `"1"`, `1`, `"true"`, `true` |
| `declined(message?)` | One of `"no"`, `"off"`, `"0"`, `0`, `"false"`, `false` |
| `distinct(options?, message?)` | An array with no duplicate items (`{ strict, ignoreCase }`) |
| `requiredArrayKeys(...keys)` | An object that contains every listed key |

> **`in()` rejects non-scalars.** An array or object value never passes
> `in()` / `notIn()`, previously `["admin"]` could slip through `in(["admin"])`
> via `String()` coercion and reach `validated()`. Coerce to a scalar with a
> type rule first if you need loose matching.

> **`in()` and `enum()` are both strict.** Both use
> `values.includes(value)`, so `in([1])` and a numeric `enum()` each
> **reject** the string `"1"`. Put a coercing type rule first
> (`rule().integer().in([1, 2])`, `rule().integer().enum(Priority)`) when
> the input arrives form-encoded. `in()` was once loose, matching on
> `String(candidate) === String(value)`, but that let a number `1` satisfy
> `in(["1"])` and vice versa, so the coercion now has to be asked for.

> **`enum()` matches values, not keys.** Invisible for a string enum,
> significant for a numeric one, because TypeScript compiles the latter
> with a reverse mapping:
>
> ```ts
> enum Priority { Low, High }
> // compiles to { Low: 0, High: 1, 0: "Low", 1: "High" }
> ```
>
> `Object.values(Priority)` is therefore `["Low", "High", 0, 1]`. `enum()`
> strips the reverse entries and accepts only `0` and `1`, the strings
> `"Low"` and `"High"` are rejected, as they must be, since they fall
> outside the `E[keyof E]` type the rule narrows to.

`confirmed()` looks for the `_confirmation` suffix in the raw data bag, not
the rules. You don't declare `password_confirmation` as a field, and it
won't appear in `validated()`.

### Conditional presence

| Method | Requires the field when |
|---|---|
| `requiredIf(other, value, message?)` | `data[other]` loosely equals `value` |
| `requiredUnless(other, value, message?)` | `data[other]` doesn't loosely equal `value` |
| `requiredWith(others[], message?)` / `requiredWith(...others)` | Any listed key is present and non-empty |
| `requiredWithout(others[], message?)` / `requiredWithout(...others)` | Any listed key is missing or empty |

These are evaluated **before** the presence/skip logic, so they force a
failure on a field otherwise declared `optional()` or `sometimes()`.

`requiredIf`/`requiredUnless` use a **loose scalar comparison**
(`String(a) === String(b)`), so a form-encoded `"1"` matches a numeric `1`.

`requiredWith`/`requiredWithout` accept either a spread list or an array
plus an optional message: `requiredWith(["a", "b"], "Needed together.")`.

### Prohibited and excluded fields

| Method | Effect |
|---|---|
| `prohibited(message?)` | The field must be missing or empty |
| `prohibitedIf(other, value, message?)` | Prohibited when `data[other]` loosely equals `value` |
| `prohibitedUnless(other, value, message?)` | Prohibited unless `data[other]` loosely equals `value` |
| `exclude()` | Always drop the field from `validated()` (no error) |
| `excludeIf(other, value)` | Drop when `data[other]` loosely equals `value` |
| `excludeUnless(other, value)` | Drop unless `data[other]` loosely equals `value` |

`prohibited*` errors when the field carries a value; `exclude*` silently
strips it from the validated output, useful for fields you accept but never
want to persist under certain conditions.

### File constraints

| Method | Checks |
|---|---|
| `mimes(types[], message?)` / `mimes(...types)` | The MIME subtype (`"png"`) or full type (`"image/png"`), case-insensitive |
| `extensions(exts[], message?)` / `extensions(...exts)` | The filename extension, with or without a leading dot |
| `max(kilobytes)` | Size, in KB |

`mimes` and `extensions` take either a spread list or an array plus an
optional custom message.

```ts
avatar: fileRule().image().max(5120).optional(),
document: fileRule().mimes("pdf", "docx").max(10240),
images: rule().array(fileRule().image().max(5120)).max(4).optional(),
```

Files reach the validator through its second constructor argument, a form
request passes `this.allFiles()`, so a file field validates even though
it never appears in `all()`.

### Database presence

| Method | Checks |
|---|---|
| `exists(tableOrModel, column?, message?)` | A row exists with `column = value` |
| `unique(tableOrModel, column?, message?)` | No row exists with `column = value` |
| `ignore(id, column = "id")` | Exclude a row from the most recent `unique()` |

The first argument is a table name or a model class (anything with
`{ table, primaryKeyColumn? }`. `primaryKeyColumn` is the read-only alias
every model exposes for its configured `primaryKey`). The column defaults
to the model's primary key, or `"id"`.

```ts
email: rule().string().email().required().unique(User, "email"),
parentId: rule().nullable().exists(Post, "id"),

// Updating: don't collide with the row being updated
email: rule().string().email().unique(User, "email").ignore(currentUser.id),
```

`ignore()` walks backwards through the steps to find the last `unique()`
and attaches the exclusion to it, so it must come after the `unique()` call
it modifies.

See [the presence resolver](#the-presence-resolver) for how these reach the
database.

### Composition and control

| Method | Effect |
|---|---|
| `when(cond, then, otherwise?)` | Apply a branch when `cond` (a boolean or `(rule) => boolean`) holds |
| `unless(cond, then, otherwise?)` | The inverse |
| `with(fn)` | Call `fn(this)` and continue the chain |
| `rule(custom)` | Splice in a `ValidationRule`, another `Rule`, or an array of either |
| `as(attribute)` | Override the display name in error messages |
| `bail()` | Stop after the first failing step for this field |

A branch may be a `Rule`, an array of rules, or a `(rule) => void` callback.
Splicing a `Rule` in copies its steps (and its `as()` name and `bail()`
flag) into this one.

`as()` changes only the `:attribute` substitution, the **error bag key
stays the field name**:

```ts
{ email_address: stringRule().required().as("email") }
// → { "email_address": ["The email field is required."] }
```

`bail()` is per-field. Without it, every applicable step runs and you get
every message:

```ts
stringRule().min(10).uuid()          // → ["…at least 10 characters.", "…a valid UUID."]
stringRule().bail().min(10).uuid()   // → ["…at least 10 characters."]
```

There's one automatic bail you don't control: **when a type step fails,
subsequent constraint steps are skipped.** A number where a string was
expected produces "must be a string" alone, not that plus a nonsensical
"must be at least 10 characters".

## Nested rules

### Arrays

`array(itemRule)` validates every element. Failures are reported under
**dotted, indexed keys**:

```ts
{ tags: rule().array(stringRule().required()) }
// input { tags: ["ok", ""] }
// → { "tags.1": ["The tags 1 field is required."] }
```

### Objects

`object(shape)` validates a nested structure and infers its type:

```ts
{
  meta: objectRule({
    title: stringRule().required(),
    priority: numberRule().integer().min(1).optional(),
  }),
}
// input { meta: { title: "" } }
// → { "meta.title": ["The meta title field is required."] }
```

`validated().meta` is `{ title: string; priority: number | undefined }`.

Keys not in the shape are **stripped** from the validated output, same as at
the top level.

### Objects of unknown shape

Call `object()` with **no shape** for a bag whose schema isn't known at
rule-declaration time, and the contents pass through unchanged. It still
asserts the value is a non-null, non-array, non-`File` object, and the
inferred type is `Record<string, unknown>`:

```ts
{
  driver_key: rule().string().required().in(installedDriverKeys()),
  // checked later, against the chosen driver's own field schema
  config: rule().object().optional(),
}
// input { driver_key: "s3", config: { bucket: "backups", region: "ap-southeast-2" } }
// validated().config → { bucket: "backups", region: "ap-southeast-2" }
```

This mirrors `array()` with no item rule. The two read alike on purpose:

```ts
rule().array().optional()     // → ["a", "b"]                 contents preserved
rule().object().optional()    // → { host: "example.test" }   contents preserved
rule().object({}).optional()  // → {}                         every key stripped
```

> **`object({})` is not the shapeless form.** An empty shape is a
> declaration that the object has no keys, so it strips every one, and
> the rule still passes. If you mean "any object", omit the argument.

Validating a shapeless bag against a schema chosen by another field is a
second validation pass; see
[`passedValidation()`](../requests/#passedvalidation).

### Dotted rule keys

A top-level rule key may itself use dot notation to reach into nested input:

```ts
{ "meta.title": stringRule().required() }
// input { meta: { title: "hi" } }
// validated() → { meta: { title: "hi" } }
```

The validator resolves the path for reading and rebuilds the nesting in
`validated()`, creating an array when the next segment is numeric. Prefer
`object()` when you're validating a whole nested structure, it gives a
better inferred type, and dotted keys for reaching a single deep field.

## The `Validator`

```ts
new Validator(
  data: Record<string, unknown>,
  files: Record<string, File | File[]>,
  rules: Record<string, Rule<any, any>>,
)
```

| Method | Returns |
|---|---|
| `passes()` | `Promise<boolean>`: **memoized**, a second call returns the first result |
| `errors()` | `Record<string, string[]>` |
| `validated()` | `Record<string, unknown>`: **throws** if called before `passes()` or after a failure |

`validated()` is strict by design: calling it before awaiting `passes()`
throws (you'd otherwise read an empty object), and calling it after a
failed validation throws a `ValidationException` carrying the error bag
rather than handing back a partially-built, unsafe object.

```ts
import { Validator, rule } from "@mahiframework/validation";

const validator = new Validator({ name: "Ada" }, {}, {
  name: rule().string().required(),
  age: rule().integer().min(18).optional(),
});

if (await validator.passes()) {
  validator.validated();   // { name: "Ada" }
} else {
  validator.errors();
}
```

Two behaviours to note:

- **Unknown keys are stripped.** `validated()` contains only fields you
  declared rules for. Passing it straight to `Model.create()` is safe by
  construction, an attacker adding `{ "isAdmin": true }` to the payload
  gets it dropped, not persisted.
- **Missing optional fields are omitted**, not set to `undefined`. So
  `"age" in validated()` is `false`, which is what makes the
  `if (name !== undefined)` partial-update pattern work.

Inside HTTP you rarely construct this yourself.
`Request.validate()` does it with `new Validator(this.all(),
this.allFiles(), rules)`. See [form requests](../requests/#form-requests).

## `ValidationException`

```ts
export class ValidationException extends Error {
  readonly status = 422;
  constructor(public readonly errors: Record<string, string[]>);
}
```

Thrown by `Request.validateOrFail()`. Which is what the
[controller pipeline](../controllers/#the-per-request-pipeline) calls. The
central error handler renders it as `422`:

```json
{
  "message": "Validation failed",
  "errors": {
    "body": ["The body field is required."],
    "images.0": ["The images.0 field must be an image."]
  }
}
```

The top-level `message` is always the literal `"Validation failed"`. The
per-field detail lives entirely in `errors`. Every value is an array, even
for a single message, so clients never have to branch on the shape.

## Typed output

This is the reason rules are objects.

```ts
type InferRule<R> = R extends Rule<infer T, infer P>
  ? P extends "optional"  ? T | undefined
  : P extends "nullable"  ? T | null
  : P extends "nullish"   ? T | null | undefined
  : T
  : never;

type InferRules<T> = { [K in keyof T]: InferRule<T[K]> };
```

`Rule<T, P>` carries the value type in `T` and the presence in `P`.
`InferRule` maps the pair to a TypeScript type; `InferRules` does it across
a whole rules object.

`Request.validated()` returns `InferRules<RulesOf<this>>`, where `RulesOf`
extracts the return type of the subclass's own `rules()` method. So:

```ts
export class CreatePostRequest extends Request {
  rules() {
    return {
      body: rule().string().required().min(1).max(280),
      images: rule().array(fileRule().image().max(5120)).max(4).optional(),
    } as const;
  }
}

const { body, images } = request.validated();
// body:   string
// images: File[] | undefined
```

> **Use `as const`.** Without it TypeScript widens the object literal and
> the per-key rule types are lost, collapsing `validated()` to something
> useless. End every `rules()` with `as const`.

Note the chain order doesn't matter for the type, `.required()` and
`.optional()` set `P` wherever they appear, and the last type-setting call
sets `T`. `rule().string().required()` and `rule().required().string()`
both give `Rule<string, "required">`.

## Error messages

### Defaults

Every rule has a default template with `:attribute`, `:min`, `:max`,
`:value`, `:other`, `:values`, `:digits`, `:size`, `:date`, and `:format`
placeholders. Interpolation is a single pass over `:token` names, so a
shorter token (`:value`) never clobbers a longer one (`:values`). `min`,
`max`, `between`, `size`, `gt`, `gte`, `lt`, and `lte` have four variants
each, selected by the resolved value type:

```ts
min: {
  string:  "The :attribute field must be at least :min characters.",
  numeric: "The :attribute field must be at least :min.",
  file:    "The :attribute field must be at least :min kilobytes.",
  array:   "The :attribute field must have at least :min items.",
}
```

`:attribute` defaults to the field name with `_` and `.` replaced by
spaces. `first_name` becomes "first name", `meta.title` becomes "meta
title".

### Per-rule override

The optional trailing argument on almost every method:

```ts
username: rule()
  .string()
  .regex(/^[a-z0-9_]{3,20}$/, "Usernames must be 3-20 lowercase letters, numbers, or underscores."),
```

### Global overrides

```ts
import { Rule } from "@mahiframework/validation";

Rule.setDefaultErrors({
  required: "Please provide a value for :attribute.",
  min: { string: ":attribute needs at least :min characters." },
});

Rule.setDefaultAttributes({
  email_address: "email address",
  dob: "date of birth",
});
```

`setDefaultErrors` **merges over** the built-in map, so you only supply what
you're changing. `setDefaultAttributes` **replaces** the attribute map
wholesale. Both are process-global, call them once from a provider's
`boot()`. `resetDefaults()` restores the built-ins, which is what test
suites want in a `beforeEach`.

Precedence for a given failure: the step's own `message` → the global
`errors` entry for that rule (and value type) → `"The :attribute field is
invalid."`.

Precedence for `:attribute`: the rule's `as()` → the global `attributes`
entry → `humanize(fieldName)`.

## Custom rules

Extend `ValidationRule` for logic the built-ins can't express:

```ts
import { ValidationRule } from "@mahiframework/validation";

class ValidPostTitle extends ValidationRule {
  run(attribute: string, value: unknown): this {
    if (typeof value === "string" && value.includes("spam")) {
      return this.fail("The title looks like spam.");
    }
    return this.pass();
  }
}

{ title: rule().string().required().rule(new ValidPostTitle()) }
```

`run()` may be async. Explicit `pass()` / `fail(message)` replace Laravel's
three historical rule shapes with one interface. Each `Validator` clones
the rules it's handed (including custom `ValidationRule` instances), and the
validator calls `reset()` before each `run()`, so a single module-scope rule
is safe to reuse across fields **and across concurrent requests**, one
request's `await` inside `run()` can't observe another's pass/fail state.

## The presence resolver

`exists()` and `unique()` need database access, which `@mahiframework/validation`
deliberately doesn't have. It would make every consumer of the package
depend on the ORM. Instead there's a single injection point:

```ts
export interface PresenceResolver {
  exists(table: string, column: string, value: unknown): Promise<boolean>;
  unique(
    table: string,
    column: string,
    value: unknown,
    ignore?: { column: string; id: unknown },
  ): Promise<boolean>;
}
```

`@mahiframework/database`'s `DatabaseServiceProvider.boot()` calls
`registerValidationPresenceResolver()`, which implements both against the
default connection's Kysely instance and installs it via
`Rule.setPresenceResolver()`. It's registered in the database provider,
not the HTTP one, so jobs and CLI commands get `exists`/`unique` without
spinning up HTTP.

Using either rule with no resolver registered **throws**:

```
exists() requires a presence resolver. Register one via Rule.setPresenceResolver().
```

Not a validation failure, a thrown error, so it surfaces as a 500 rather
than silently rejecting every value as invalid. If you see this in a test,
the test isn't booting `DatabaseServiceProvider`; register a stub:

```ts
Rule.setPresenceResolver({
  async exists() { return true; },
  async unique() { return true; },
});
```

`setPresenceResolver(undefined)` clears it.

### Cost

Each `exists()`/`unique()` step is one `SELECT … LIMIT 1` at validation
time. `unique()` with `ignore` adds a `WHERE ignoreColumn != id`. They run
per-field and are not batched, so a rules object with several of them means
several round trips before the handler starts. Worth knowing on a hot
endpoint; unremarkable on registration.

## Related

- [Requests](../requests/): form requests, `rules()`, `validated()`, `prepareForValidation()`
- [Controllers](../controllers/): where validation runs in the request pipeline
- [Responses](../responses/): the 422 body shape
- [Models](../models/): the `table` and `primaryKeyColumn` that `unique`/`exists` read
- [Database](../database/): the presence resolver's connection
