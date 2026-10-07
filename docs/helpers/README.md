# Helpers

`@mahiframework/core` ships the utility layer everything else is built on: string
and array manipulation, an ordered-map `Collection`, locale-aware number
formatting, type-checked dot-notation access into nested data, and a
handful of Laravel's global helpers. Three small standalone packages sit
alongside it, `@mahiframework/pipeline`, `@mahiframework/process`, `@mahiframework/tui`, each
usable without the framework.

```ts
import { Str, Arr, Collection, Num, data_get, collect } from "@mahiframework/core";

Str.slug("Héllo, World!");                      // "hello-world"
Arr.wrap(maybeArray);                            // always an array
collect(users).groupBy("role").keys().all();     // ["admin", "member"]
Num.fileSize(2_400_000);                         // "2 MB"
data_get(config, "database.connections.sqlite"); // typed, compile-checked
```

Nothing here touches the container, the config repository, or the
application. These are pure functions and value objects, import them
anywhere, including inside a `config/*.ts` file that runs before
`bootstrap()`. (Two exceptions read or write the filesystem rather than
the container: the path helpers and `TempFile`. Neither needs an
`Application` either.)

## `Str`

A frozen object of pure string functions. No `Stringable` wrapper, no
fluent chain, Laravel's `Str::of()` exists because PHP has no method
chaining on scalars, which isn't a problem TypeScript has.

### Case conversion

All four case converters go through one private `splitWords()`:

```ts
function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // camelCase → camel Case
    .split(/[\s\-_]+/)                         // split on space, dash, underscore
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}
```

That's why the conversions **round-trip**. Every converter first
decomposes its input into the same lowercase word list, then reassembles
it, so the input spelling is irrelevant:

```ts
Str.camel("foo-bar");     // "fooBar"
Str.camel("foo_bar_baz"); // "fooBarBaz"
Str.camel("FooBar");      // "fooBar"

Str.snake("fooBar");      // "foo_bar"
Str.snake("foo-bar");     // "foo_bar"

Str.kebab("fooBar");      // "foo-bar"
Str.kebab("foo_bar");     // "foo-bar"

Str.studly("foo-bar");    // "FooBar"
Str.studly("foo_bar");    // "FooBar"
```

The word-boundary regex only fires on a **lowercase-or-digit followed by
an uppercase**. So `"HTTPResponse"` splits as one word `"httpresponse"`,
not `"http response"`, consecutive capitals are not a boundary. If you
need acronym-aware splitting, do it yourself before calling.

| Method | Signature | Result |
|---|---|---|
| `camel` | `(value)` | `fooBarBaz` |
| `snake` | `(value)` | `foo_bar_baz` |
| `kebab` | `(value)` | `foo-bar-baz` |
| `studly` | `(value)` | `FooBarBaz` |

`Str.kebab()` is what the `make:*` generators use to derive filenames.
`make:job SendWelcomeEmail` writes `send-welcome-email.job.ts`. See
[Console](../console/).

### `slug`

```ts
slug(value: string, separator = "-"): string
```

Unicode-normalises to NFKD, strips combining marks, lowercases, then
replaces every run of non-`[a-z0-9]` with `separator` and trims separators
off both ends.

```ts
Str.slug("  Héllo, World!  ");   // "hello-world"
Str.slug("Hello World", "_");    // "hello_world"
```

**This is ASCII-only by construction.** The `[^a-z0-9]+` replacement means
a Cyrillic or CJK title slugs to the empty string. That's the honest
outcome, transliterating scripts the framework has no table for would
produce confidently wrong output. If you need non-Latin slugs, transliterate
before calling, or key on an ID instead.

### Truncation

```ts
limit(value: string, length: number, suffix = "..."): string
words(value: string, words = 100, end = "..."): string
```

`limit()` counts **characters**; `words()` counts whitespace-separated
runs. Both return the input untouched when it's already short enough, and
both `trimEnd()` before appending the suffix.

```ts
Str.limit("hi", 10);                  // "hi"
Str.limit("hello world", 5);          // "hello..."
Str.limit("hello world", 5, "…");     // "hello…"

Str.words("one two three four", 2);   // "one two..."
Str.words("one two", 5);              // "one two"
```

Note `limit()`'s length budget excludes the suffix. `limit(s, 5)` can
return an 8-character string.

### Predicates

```ts
contains(haystack: string, needles: string | readonly string[]): boolean
startsWith(haystack: string, needles: string | readonly string[]): boolean
endsWith(haystack: string, needles: string | readonly string[]): boolean
```

All three accept one needle or several, and are **`some()`**, not
`every()`, any match wins.

```ts
Str.contains("hello world", "world");             // true
Str.contains("hello world", ["foo", "hello"]);    // true
Str.contains("hello world", "xyz");               // false
Str.contains("hello", "");                        // false — empty needles never match
```

The empty-needle rule (`needle !== ""`) matters: without it every one of
these would return `true` for `""`, since `"anything".includes("")` is
true. An empty needle usually means a variable that didn't get set.

```ts
isUuid(value: string): boolean   // RFC 4122 v1–v8, any case
isUlid(value: string): boolean   // 26 Crockford-base32 chars, first char 0–7
isJson(value: string): boolean   // JSON.parse succeeds; "" is false
```

`isJson("")` is `false`. An empty string is short-circuited before
`JSON.parse` ever runs, because `JSON.parse("")` throws anyway and
returning `false` for whitespace is what callers mean.

`isUlid`'s leading `[0-7]` bound is deliberate: a ULID's first 10
characters encode a 48-bit millisecond timestamp, which cannot exceed
`7ZZZZZZZZZ`. A string starting with `8`–`Z` is not a representable ULID.

### Extraction

```ts
after(subject, search)       // everything after the FIRST occurrence
afterLast(subject, search)   // everything after the LAST occurrence
before(subject, search)      // everything before the FIRST occurrence
beforeLast(subject, search)  // everything before the LAST occurrence
between(subject, from, to)   // beforeLast(after(subject, from), to)
substr(value, start, length?)
```

All four `after`/`before` variants return the **whole subject unchanged**
when `search` is `""` or isn't found. That's a deliberate no-op rather
than an empty string: a missed search usually means the input wasn't the
shape you expected, and silently returning `""` hides it.

```ts
Str.after("app/http/controllers/foo.ts", "/");       // "http/controllers/foo.ts"
Str.afterLast("app/http/controllers/foo.ts", "/");   // "foo.ts"
Str.before("app/http/controllers/foo.ts", "/");      // "app"
Str.beforeLast("app/http/controllers/foo.ts", "/");  // "app/http/controllers"
```

`between()` is **first `from`, last `to`**, matching Laravel's
`Str::between`. It is greedy on the right:

```ts
Str.between("[a] [b]", "[", "]");   // "a] [b"   — not "a"
Str.between("abc", "x", "y");       // "abc"     — neither found
```

`substr()` is `slice`-with-a-length, not JS's deprecated
`String.prototype.substr`. A negative `start` counts from the end:

```ts
Str.substr("hello", 1, 3);   // "ell"
Str.substr("hello", -2);     // "lo"
```

### Case and formatting

```ts
lower(value)     // toLowerCase()
upper(value)     // toUpperCase()
title(value)     // Title Case Every Word
ucfirst(value)   // First character only
```

`title()` lowercases the whole string first, then uppercases every letter
that follows a non-letter/non-digit boundary, using Unicode property
escapes (`\p{L}`, `\p{N}`) so it works outside ASCII.

```ts
Str.title("hello world");   // "Hello World"
Str.ucfirst("foo Bar");     // "Foo Bar"  — only the first char is touched
```

`ucfirst("")` returns `""` rather than throwing.

### Identifiers

```ts
random(length = 16): string   // hex, from randomBytes
uuid(): string                // node:crypto randomUUID() — v4, fully random
uuid7(): string               // RFC 9562 v7 — 48-bit ms timestamp, then random
orderedUuid(): string         // alias for uuid7(), named for intent
ulid(): string                // 10 chars of time + 16 chars of randomness
```

`Str.random()`'s alphabet is **hexadecimal only** (`0-9a-f`), because it
is `randomBytes(ceil(n/2)).toString("hex").slice(0, n)`. It is
cryptographically random but has ~4 bits of entropy per character, not
~6. For a token where density matters, generate bytes and base64url them
yourself; for a filename suffix or a test fixture, this is fine.

`Str.ulid()` is lexicographically sortable by generation time, the first
10 characters are `Date.now()` in Crockford base32, the remaining 16 are
80 random bits. Two ULIDs generated in the same millisecond do **not**
have a defined relative order (there is no monotonic counter). For ids
that are ordered by the database rather than by a clock, use an
auto-increment primary key, see [Models](../models/).

`Str.uuid7()` is the UUID-shaped equivalent: a 48-bit millisecond
timestamp followed by 74 random bits, so ids sort in creation order while
staying valid UUIDs. Prefer it to `uuid()` for a primary key, a v4
scatters inserts across the index at random, fragmenting it and dirtying a
fresh page per write, whereas a v7 appends and keeps the hot leaf in
cache. It also makes `order by id` a usable proxy for `order by
created_at` without a second index.

> **A v7 leaks its creation time** to anyone holding one. Harmless for a
> row id; not harmless for a value that doubles as a capability, like an
> unguessable share link, where a known timestamp narrows the search
> space. Use `uuid()` there.

Like ULIDs, two v7s minted in the same millisecond have no defined
relative order. Ordering comes from the timestamp, uniqueness from the
random bits. `orderedUuid()` is an alias, named after what you want rather
than which RFC version currently provides it.

## `Arr`

Utilities over arrays and plain objects. Five of its members are
re-exports of the `data_*` family, so `Arr.get`/`Arr.set` are the same
compile-time-checked functions documented in [Dot-notation
access](#dot-notation-access).

### Wrapping and flattening

```ts
wrap<T>(value: T | T[] | undefined | null): T[]
flatten<T>(value: readonly (T | readonly T[])[]): T[]
```

`wrap()` turns `null`/`undefined` into `[]`, leaves arrays alone, and puts
anything else in a one-element array. It is the idiomatic way to accept
"one or many" at an API boundary:

```ts
Arr.wrap("admin");            // ["admin"]
Arr.wrap(["admin", "owner"]); // ["admin", "owner"]
Arr.wrap(null);               // []
```

`flatten()` is **one level only**, it's `Array.prototype.flat()` with the
default depth of 1. For arbitrary depth use `collect(x).flatten()`, which
takes a depth argument and defaults to `Infinity`.

### Object key selection

```ts
only<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K>
except<T, K extends keyof T>(obj: T, keys: K[]): Omit<T, K>
```

Both return a **new** object; neither mutates. `only()` skips keys that
aren't present (`k in obj`), so the result never gains `undefined`
entries for missing keys. The return types are `Pick`/`Omit`, so the
narrowing is visible downstream.

```ts
Arr.only(user, ["id", "email"]);       // { id, email }
Arr.except(user, ["password"]);        // everything but password
```

`except()` compares stringified keys and iterates `Object.entries`, so it
drops symbol keys and non-enumerable properties. It's for plain data, not
class instances.

### Dot-path access

| Member | Aliases | Notes |
|---|---|---|
| `Arr.get` | `data_get` | Read a dotted path |
| `Arr.set` | `data_set` | Write a dotted path (mutates; use the return value) |
| `Arr.fill` | `data_fill` | Write only if absent |
| `Arr.has` | `data_has` | Every path must exist |
| `Arr.forget` | `data_forget` | Remove paths (mutates) |

Plus two that only live on `Arr`:

```ts
hasAny<T>(target: T, keys: Paths<T> | readonly Paths<T>[]): boolean
pull<T, P>(target: T, key: P, fallback?): PathValue<T, P>
```

`hasAny()` is `data_has`'s `some()` counterpart, `data_has` requires
**all** the given paths, `hasAny` requires **one**.

`pull()` reads and removes in one call. It mutates `target`:

```ts
const options = { retries: 3, verbose: true };
const retries = Arr.pull(options, "retries");   // 3
// options is now { verbose: true }
```

### `first` and `last`

```ts
first<T>(array, predicate?, fallback?): T | undefined
last<T>(array, predicate?, fallback?): T | undefined
```

These **filter first, then index**:

```ts
const source = predicate ? array.filter(predicate) : array;
if (source.length > 0) return source[0];
return fallback === undefined ? undefined : value(fallback);
```

Two consequences worth knowing. First, with a predicate they are `O(n)`
even when the match is at index 0. The whole array is scanned and an
intermediate array is allocated. For a hot loop use
`array.find(predicate)`. Second, `fallback` goes through the `value()`
helper, so a function is **called**, not returned:

```ts
Arr.first(users, (u) => u.isAdmin);
Arr.last(logs, null, () => defaultEntry());   // thunk is invoked
Arr.first([], null, "none");                  // "none"
```

Pass `null` (not `undefined`) as the predicate when you want a fallback
without filtering. `undefined` would be fine too, but `null` reads as
deliberate.

### List and shape tests

```ts
isList(value: DataValue): boolean
isAssoc(value: DataValue): boolean
```

`isList()` is true for any array, and for a plain object whose keys are
exactly `"0"`, `"1"`, … `"n-1"` in order. **Empty arrays and empty objects
are both lists**, matching PHP 8.1's `array_is_list([]) === true`:

```ts
Arr.isList([]);              // true
Arr.isList({});              // true   ← every() over zero keys is vacuously true
Arr.isList([1, 2, 3]);       // true
Arr.isList({ 0: "a", 1: "b" });  // true
Arr.isList({ 1: "a" });      // false  — doesn't start at 0
Arr.isList("hello");         // false  — not an object
Arr.isList(null);            // false
```

`isAssoc()` is the inverse **for objects and arrays only**, and `false`
for everything else:

```ts
Arr.isAssoc({});             // false  ← {} is a list, so it is not assoc
Arr.isAssoc({ a: 1 });       // true
Arr.isAssoc([1, 2]);         // false
Arr.isAssoc(null);           // false
Arr.isAssoc(42);             // false
```

The `isAssoc({}) === false` case is the one that surprises people. `{}`
and `[]` are indistinguishable as "an empty container", and PHP made the
same call. If you need "is a non-array object", test that directly.

### Dot and undot

```ts
dot(target: DataValue, prefix = ""): Record<string, DataValue>
undot(target: Record<string, DataValue>): DataObject | DataList
```

`dot()` flattens nested structure into a single-level map of dotted paths.
Array indices become path segments:

```ts
Arr.dot({ user: { name: "Ada", roles: ["admin", "owner"] } });
// {
//   "user.name": "Ada",
//   "user.roles.0": "admin",
//   "user.roles.1": "owner",
// }
```

Empty containers are **preserved as leaves** rather than vanishing:

```ts
Arr.dot({ a: {}, b: [] });   // { "a": {}, "b": [] }
```

Without that rule `dot()`/`undot()` would not round-trip. An empty object
would flatten to nothing and come back missing.

`undot()` is the inverse. It builds the structure with `data_set` and then
collapses any object whose keys are `"0".."n-1"` back into a real array:

```ts
Arr.undot({ "user.name": "Ada", "user.roles.0": "admin" });
// { user: { name: "Ada", roles: ["admin"] } }
```

### The rest

```ts
divide<T>(obj: T): [Array<keyof T & string>, Array<T[keyof T]>]
crossJoin<T>(...arrays: Array<readonly T[]>): T[][]
partition<T>(array, predicate): [T[], T[]]
sole<T>(array, predicate?): T
where<T>(array, predicate): T[]
whereNotNull<T>(array): T[]
query(obj: DataObject): string
```

`divide()` splits an object into parallel keys/values arrays,
`Object.keys` and `Object.values` in one call, correctly typed.

`crossJoin()` produces every combination, seeded with `[[]]` so a
zero-argument call returns `[[]]` (one empty combination), not `[]`:

```ts
Arr.crossJoin([1, 2], ["a", "b"]);
// [[1,"a"], [1,"b"], [2,"a"], [2,"b"]]
```

`partition()` is one pass producing `[passing, failing]`, and its
predicate receives `(item, index)`:

```ts
const [active, inactive] = Arr.partition(users, (u) => u.active);
```

`sole()` asserts exactly one match, throwing `ItemNotFoundError` for zero
and `MultipleItemsFoundError` for two or more, the same two errors
`Collection.sole()` uses.

```ts
const admin = Arr.sole(users, (u) => u.role === "admin");
```

`where()` is `Array.prototype.filter` with a `(item, index)` predicate.
`whereNotNull()` drops `null` **and** `undefined`, and narrows the type
via a type predicate:

```ts
const ids: string[] = Arr.whereNotNull(maybeIds);   // (string|null)[] → string[]
```

`query()` builds an `application/x-www-form-urlencoded` string with PHP
bracket notation for nesting, skipping `null`/`undefined` entirely:

```ts
Arr.query({ filter: { status: "active" }, tags: ["a", "b"], page: 2 });
// "filter%5Bstatus%5D=active&tags%5B0%5D=a&tags%5B1%5D=b&page=2"
```

Values go through `String(value)`, so `true` becomes `"true"` and a `Date`
becomes its `toString()`. Format non-scalars before passing them in.

## `Collection`

```ts
import { Collection, collect } from "@mahiframework/core";
```

A near 1:1 port of Laravel's `Illuminate\Support\Collection`, and the
return type of every model query that yields more than one row. See
[Models](../models/).

### It is an ordered `Map`, not an array

This is the design decision everything else follows from.

PHP arrays are ordered maps (`array-key => value`), which is why Laravel's
`Collection` has key-based methods (`get`/`put`/`has`/`forget`/`keys`/
`keyBy`) sitting alongside list-style ones (`push`/`map`/`filter`). To
support that faithfully, this class stores its items in an internal
`Map<K, V>`:

```ts
export class Collection<V, K extends PropertyKey = number> {
  private items: Map<K, V>;
  private nextIndex: number;
  private constructor(items: Map<K, V>, nextIndex: number) { /* ... */ }
}
```

`K` defaults to `number`, so a freshly-`make()`d collection behaves like a
0-indexed list. Re-keying operations narrow `K` to the new key type, and
**the result keeps chaining**:

```ts
const byEmail = collect(users).keyBy("email");   // Collection<User, string>
byEmail.get("ada@example.com");                   // User | undefined
byEmail.filter((u) => u.active).count();          // still a Collection
```

If `keyBy()` returned a native `Map`, the obvious TypeScript translation,
the chain would stop dead there, and so would `groupBy`, `countBy`,
`mapWithKeys`, `pluck(value, key)`, `flip`, and `combine`. All of them
return keyed `Collection`s instead.

`nextIndex` mirrors PHP's `$items[] = $value` semantics: it tracks the
next auto-assigned integer key, and `put()` advances it when you write an
integer key at or beyond it.

### Construction

The constructor is **private**. Build one through a static:

| Static | Signature | Notes |
|---|---|---|
| `make` | `(items: readonly V[])` | Keys `0..n-1` |
| `make` | `(items: Iterable<[K, V]>)` | Preserves keys, a `Map`, `.entries()`, or another `Collection` |
| `empty` | `<V>()` | Zero items, `nextIndex = 0` |
| `wrap` | `(Collection \| V[] \| V)` | Scalars become a one-item collection |
| `unwrap` | `(Collection \| V[])` | The plain array back out |
| `range` | `(from, to, step = 1)` | **Inclusive** of `to`; negative `step` counts down |
| `times` | `(number, callback?)` | 1-indexed; `number < 1` gives an empty collection |
| `fromJson` | `(json: string)` | Must decode to an array |

`make()` **defensively clones** its input into a fresh `Map`. Mutating the
result never touches the caller's original array, iterable, or collection:

```ts
const source = [1, 2, 3];
const c = Collection.make(source).push(4);
source.length;   // still 3
```

`collect()` is the shorthand, and the one you'll write most:

```ts
import { collect } from "@mahiframework/core";

collect(users);           // Collection<User, number>
collect(null);            // Collection<never, number> — empty, not a crash
collect("one value");     // one-item collection
```

`collect(null)` and `collect(undefined)` return an empty collection; every
other value goes through `Collection.wrap()`.

### What mutates

Mutability matches Laravel exactly, method by method. **Twelve methods
mutate in place**; every other method returns a new `Collection` (or a
plain value).

| Mutating | Returns |
|---|---|
| `push`, `add`, `unshift`, `prepend` | the same collection (`this`) |
| `pop`, `shift` | the removed item, or a `Collection` of removed items |
| `splice` | a `Collection` of the **removed** portion |
| `put`, `forget`, `transform` | `this` |
| `pull` | the removed value |
| `getOrPut` | the existing or newly-stored value |

Everything else: `map`, `filter`, `reject`, `where*`, `sort*`, `unique`,
`merge`, `slice`, `take`, `chunk`, `values`, `keys`, `only`, `except`, is
non-destructive.

The trap this creates:

```ts
const items = collect([3, 1, 2]);

items.sort();      // new collection; `items` is untouched
items.push(4);     // MUTATES items, and returns it
```

`sort()` returning a new instance while `push()` mutates looks
inconsistent, and it is, but it's the same inconsistency Laravel has, and
diverging would silently break every ported snippet. When in doubt,
assign the result: `const sorted = items.sort()` is correct either way.

### List-shaped methods are type-restricted

`push`, `add`, `unshift`, `pop`, and `shift` are declared with an explicit
`this` type:

```ts
push(this: Collection<V, number>, ...values: V[]): Collection<V, number>
```

They are therefore **only callable when `K = number`**. Pushing onto a
string-keyed collection is a compile error, not a silent reinterpretation
of the key space the way PHP's `array_push()` behaves:

```ts
const byEmail = collect(users).keyBy("email");   // Collection<User, string>
byEmail.push(newUser);
// Error: 'this' context of type 'Collection<User, string>' is not
// assignable to method's 'this' of type 'Collection<User, number>'.
```

Use `put(key, value)` on a keyed collection. `prepend(value, key?)` works
on both, with a key it inserts that one entry at the front and leaves
every other key alone; without one it renumbers from 0 like `unshift`.

### `all()` and `toArray()` discard keys

```ts
all(): V[]        // [...this.items.values()]
toArray(): V[]    // alias for all()
toJSON(): V[]     // makes JSON.stringify(collection) work
toJson(indent?): string
```

All four are **values only**. A keyed collection loses its keys the moment
you call any of them:

```ts
const byEmail = collect(users).keyBy("email");
byEmail.all();                    // User[] — the emails are gone
JSON.stringify(byEmail);          // "[{...},{...}]" — an array, not an object
```

If you need the pairs, go through `keys()`:

```ts
for (const email of byEmail.keys()) {
  const user = byEmail.get(email);
}

Object.fromEntries(byEmail.keys().all().map((k) => [k, byEmail.get(k)]));
```

Iterating a collection directly (`for (const item of collection)`) also
yields **values**, via `[Symbol.iterator]` returning `items.values()`.

### Method groups

**Basic accessors.** `all`, `toArray`, `toJSON`, `toJson`, `length`
(getter), `count`, `isEmpty`, `isNotEmpty`.

**Key access.** `get(key, default?)`, `getOrPut(key, value)` *(mutates)*,
`has(key | key[])` (**every** key must exist), `hasAny(keys)` (any),
`put` *(mutates)*, `pull` *(mutates)*, `forget` *(mutates)*, `only(keys)`,
`except(keys)`, `keys()`, `values()` (renumbers to `0..n-1`).

`get()` and `pull()` accept a **thunk** as the default, evaluated only on
a miss:

```ts
collection.get("missing", () => expensiveDefault());
```

**Iteration.** `each` (return `false` to break early), `map`,
`mapWithKeys`, `mapToDictionary`, `mapToGroups`, `flatMap`, `mapSpread`,
`mapInto(ctor)`, `eachSpread`, `reduce`, `reduceInto`, `reduceSpread`.

Every callback receives `(item, key)`. `map()` always returns a
**list-shaped** `Collection<U, number>`. It renumbers. Use
`mapWithKeys()` to derive keys, or `mapValues()` to keep the ones you
have:

```ts
collect(users).mapWithKeys((u) => [u.email, u.name]);   // Collection<string, string>

keyed.mapValues((n) => n * 2);                          // same keys, new values
keyed.map((n) => n * 2);                                // keys become 0, 1, 2...
```

`mapValues()` is the one to use on a keyed collection: `map()`
discards exactly the thing that made it keyed, and
`mapWithKeys((v, k) => [k, f(v)])` restates the key only to say
"unchanged".

> **Building a keyed collection needs a `Map`.** `Collection.make()` takes
> an array, another Collection, or an *iterable of entries*, and
> `Object.entries()` returns an **array**, so it matches the array
> overload and gives you a list of `[key, value]` pairs:
>
> ```ts
> Collection.make(Object.entries({ a: 1 }));           // Collection<[string, number], number>
> Collection.make(new Map(Object.entries({ a: 1 })));  // Collection<number, string>
> ```
>
> `collect()` cannot produce a keyed collection at all. Its return type
> is always `Collection<V, number>`.

**Filtering.** `filter(callback?)` (no callback drops falsy values),
`reject`, `where(key, value)` / `where(key, operator, value)`,
`whereNull`, `whereNotNull`, `whereIn`, `whereNotIn`, `whereBetween`,
`whereNotBetween`, `whereInstanceOf(ctor)`.

Supported `where` operators: `=`, `==`, `===`, `!=`, `<>`, `!==`, `<`,
`>`, `<=`, `>=`. The three equality spellings are all strict `===` and the
three inequality spellings are all `!==`, PHP's loose `==` has no place
here, so the pairs are collapsed rather than faked.

```ts
collect(posts).where("published", true);
collect(posts).where("views", ">", 1000);
collect(mixed).whereInstanceOf(Post);   // narrows to Collection<Post, K>
```

**Searching and testing.** `first`, `firstOrFail`, `firstWhere`, `last`,
`sole`, `hasSole`, `hasMany`, `contains`, `some` (alias), `doesntContain`,
`every`, `search`, `before`, `after`, `ensure`.

`search()` returns the **key**, or `false` when absent, so always compare
with `=== false`, never a truthiness check (key `0` is falsy):

```ts
const key = collection.search((u) => u.id === target);
if (key === false) { /* not found */ }
```

`contains`/`some`/`doesntContain`/`every`/`reject` accept either a
predicate or a plain value to compare with `===`.

**Grouping and keying.** `groupBy`, `keyBy`, `countBy`, `partition`,
`duplicates`. Each selector is a property key or a `(item, key)` callback.

```ts
collect(posts).groupBy("authorId");        // Collection<Collection<Post>, string>
collect(posts).groupBy((p) => p.createdAt.slice(0, 7));  // by month
collect(words).countBy((w) => w.length);   // Collection<number, number>
```

`groupBy` and `mapToGroups` return a `Collection` **of `Collection`s**;
`mapToDictionary` returns a `Collection` of plain arrays.

**Aggregates.** `sum`, `avg`, `average` (alias), `min`, `max`, `median`,
`mode`, `percentage(callback, precision = 2)`.

All take an optional selector. `avg`/`min`/`max`/`median` skip
`null`/`undefined` values and return `undefined` for an empty (or
all-null) collection; `sum` returns `0`. `mode()` returns a **sorted
array** of the most-frequent values, since ties are real.

`Collection.percentage()` returns a number from 0 to 100, the share of
items passing the predicate:

```ts
collect(posts).percentage((p) => p.published);   // 66.67
```

**Slicing and paging.** `take` (negative takes from the end), `skip`,
`slice(offset, length?)`, `forPage(page, perPage)` (1-indexed),
`takeUntil`, `takeWhile`, `skipUntil`, `skipWhile`, `nth(step, offset = 0)`.

All of these **preserve keys** except `nth`, which renumbers.

**Chunking and splitting.** `chunk(size)`, `chunkWhile(callback)`,
`sliding(size = 2, step = 1)`, `split(n)` (roughly equal groups, remainder
to the front), `splitIn(n)` (fill earlier groups completely first). Each
returns a `Collection` of `Collection`s.

**Ordering.** `sort(compareFn?)`, `sortDesc`, `sortBy(selector, desc = false)`,
`sortByDesc`, `sortKeys(desc = false)`, `sortKeysDesc`, `sortKeysUsing`,
`reverse`, `shuffle`, `random(count?)`.

All preserve keys. The default comparator subtracts numbers and otherwise
compares `String(a)` against `String(b)`, so mixed-type sorting is
stringly, and `[10, 9]` sorts numerically as long as both are numbers.

`random()` with no argument returns one item (or `undefined` when empty);
with a count it returns a `Collection` sampled without replacement.

**Uniqueness.** `unique(selector?)`, keeps the **first** occurrence and
preserves its key.

**Merging and set operations.** `merge` (later wins), `mergeRecursive`,
`union` (**existing keys win**, the opposite bias from `merge`),
`replace`/`replaceRecursive` (aliases of merge), `concat` (appends
values, discarding source keys), `multiply(n)`, `diff`, `diffUsing`,
`intersect`, `intersectUsing`, `crossJoin`, `combine`, `flip`, `zip`,
`pad(size, value)` (negative size pads at the front).

`merge` versus `union` is the one to keep straight:

```ts
collect(["a", "b"]).merge(["x"]).all();   // ["a", "b", "x"] — appended at nextIndex
collect(["a", "b"]).union(["x"]).all();   // ["a", "b", "x"]
```

With overlapping **keys** they differ: `merge` overwrites, `union` keeps
what's already there.

**Flatten and collapse.** `flatten(depth = Infinity)`, `collapse()` (one
level). Both understand nested `Collection`s as well as arrays.

**Column extraction.** `pluck(value)` / `pluck(value, key)`,
`select(keys)`.

```ts
collect(users).pluck("email");             // Collection<string, number>
collect(users).pluck("name", "id");        // Collection<string, string>
collect(users).select(["id", "email"]);    // Collection<Pick<User, "id"|"email">, K>
```

**String conversion.** `implode(keyOrFn, glue = "")`,
`join(glue, finalGlue = "")`.

```ts
collect(users).implode("name", ", ");        // "Ada, Grace, Alan"
collect(["a", "b", "c"]).join(", ", " and "); // "a, b and c"
```

**Flow control.** `pipe(callback)`, `pipeInto(ctor)`, `pipeThrough(fns)`,
`tap(callback)`, `when(value, cb, default?)`, `unless`, `whenEmpty`,
`whenNotEmpty`, `unlessEmpty`, `unlessNotEmpty`.

```ts
collect(posts)
  .when(filters.authorId, (c, id) => c.where("authorId", id))
  .when(filters.published, (c) => c.where("published", true))
  .sortByDesc("createdAt");
```

`tap()` returns the collection unchanged, which makes it the debugging
hook: `.tap((c) => console.log(c.count()))`.

### `ItemNotFoundError` and `MultipleItemsFoundError`

```ts
import { ItemNotFoundError, MultipleItemsFoundError } from "@mahiframework/core";
```

| Error | Thrown by | Message |
|---|---|---|
| `ItemNotFoundError` | `firstOrFail()`, `sole()`, `Arr.sole()` | `"Item not found."` |
| `MultipleItemsFoundError` | `sole()`, `Arr.sole()` | `"3 items found."` |

`MultipleItemsFoundError` carries a public `count` property, so a handler
can report how many it found without parsing the message.

```ts
try {
  const owner = collect(members).sole((m) => m.role === "owner");
} catch (error) {
  if (error instanceof MultipleItemsFoundError) {
    reportDataIntegrityIssue(error.count);
  }
}
```

### What isn't ported

`dd`/`dump` (use `console.log`), `__toString`, `getCachingIterator`,
`ArrayAccess` offsets (use `get`/`put`/`has`/`forget`), `Macroable`,
`lazy()`/`LazyCollection`, `toBase()`, `collapseWithKeys()`, `dot`/`undot`
(they're on `Arr`), the `*Assoc`/`*Keys`/`intersectByKeys` set-op
variants, and `HigherOrderCollectionProxy`, the `__call`-forwarding magic
that no type checker can follow, rejected for the same reason dynamic
facades are.

## `Num`

```ts
import { Num } from "@mahiframework/core";
```

A thin wrapper over Node's built-in `Intl.NumberFormat`, plus three
hand-rolled helpers `Intl` has no equivalent for.

### Use `Num`, not `Number`

The helper is exported as `Num`. It is deliberately **not** named `Number`:
importing a `Number` export shadows the global `Number` constructor in that
module, so a later `Number.isInteger(...)` / `Number(x)` becomes a runtime
`TypeError`.

```ts
import { Num } from "@mahiframework/core";

Num.format(1234.5);        // "1,234.5"  — the helper
Number.isInteger(4);       // true — the global is untouched
```

A deprecated `Number` alias still exists for backward compatibility, but
new code should import `Num`.

### `NumberFormatOptions`

```ts
interface NumberFormatOptions {
  locale?: string;       // BCP 47 tag; defaults to the host's
  precision?: number;    // pins BOTH min and max fraction digits
  maxPrecision?: number; // caps max fraction digits only
}
```

`precision` wins when both are given. `maxPrecision` is only consulted
when `precision` is `undefined`. `precision: 2` on `1.5` gives `"1.50"`;
`maxPrecision: 2` gives `"1.5"`.

### The methods

```ts
format(value, options?): string
currency(value, currency = "USD", options?): string
percentage(value, options?): string
fileSize(bytes, precision = 0): string
abbreviate(value, precision = 0): string
clamp(value, min, max): number
```

```ts
Number.format(1234567.891);                       // "1,234,567.891"
Number.format(1234.5, { precision: 2 });          // "1,234.50"
Number.format(1234.5, { locale: "de-DE" });       // "1.234,5"

Number.currency(1234.5);                          // "$1,234.50"
Number.currency(1234.5, "NZD", { locale: "en-NZ" }); // "$1,234.50"
Number.currency(1234.5, "EUR", { locale: "de-DE" }); // "1.234,50 €"
```

### `percentage()` takes a percentage, not a fraction

```ts
Number.percentage(10);                      // "10%"    — NOT "1,000%"
Number.percentage(10.5, { precision: 1 });  // "10.5%"
```

This matches Laravel's `Number::percentage(10)` and deliberately **breaks
from `Intl`'s convention**, where `style: "percent"` multiplies by 100 and
expects a 0–1 fraction. The implementation formats the number normally and
appends a literal `%`:

```ts
percentage(value, options) {
  const precision = options?.precision ?? 0;
  return `${formatter({ ...options, precision }).format(value)}%`;
}
```

So a ratio must be scaled first: `Number.percentage(ratio * 100)`.

Note `precision` defaults to `0` here (not to `Intl`'s default), so
`percentage(66.666)` is `"67%"` unless you ask for decimals.

### `fileSize()` uses binary units, `abbreviate()` uses decimal ones

They deliberately differ, because the two domains do:

| | Divisor | Units |
|---|---|---|
| `fileSize` | **1024** | `B`, `KB`, `MB`, `GB`, `TB`, `PB`, `EB` |
| `abbreviate` | **1000** | *(none)*, `K`, `M`, `B`, `T`, `Q` |

```ts
Number.fileSize(1024);            // "1 KB"
Number.fileSize(2_400_000);       // "2 MB"
Number.fileSize(2_400_000, 2);    // "2.29 MB"

Number.abbreviate(1000);          // "1K"
Number.abbreviate(1_500_000);     // "2M"
Number.abbreviate(1_500_000, 1);  // "1.5M"
Number.abbreviate(-2500);         // "-3K"
```

The labels say `KB`/`MB` while dividing by 1024, the same choice most
operating systems make and the one users expect from a file browser. It is
technically `KiB`.

Two behaviours to know:

**`fileSize` promotes at 0.9 of a unit, not at 1.0.** The loop condition
is `amount / 1024 > 0.9`, so anything above 921.6 bytes is rendered in KB:

```ts
Number.fileSize(1000);   // "1 KB"   — not "1,000 B"
Number.fileSize(900);    // "900 B"
```

**`fileSize` returns `"0 B"` for negatives and non-finite input** rather
than throwing. `abbreviate` handles negatives properly, extracting the
sign before scaling.

`clamp(value, min, max)` is `Math.min(max, Math.max(min, value))`, no
validation that `min <= max`, so an inverted range returns `min`.

## Dot-notation access

```ts
import { data_get, data_set, data_fill, data_has, data_forget } from "@mahiframework/core";
```

Laravel's `data_*` global helpers, with one enormous difference: **the
path is checked against `T` at compile time, and the return type is the
type at that path.**

```ts
const user = {
  name: "Ada",
  address: { country: "NZ", city: "Wellington" },
  roles: ["admin", "owner"],
};

data_get(user, "address.country");   // string
data_get(user, "roles.0");           // string
data_get(user, "roles.*");           // string[]
data_get(user, "address.postcode");  // ❌ compile error — no such path
data_get(user, "adress.country");    // ❌ compile error — typo caught
```

The camelCase spellings (`dataGet`, `dataSet`, `dataFill`, `dataHas`,
`dataForget`) still exist and still work, but are `@deprecated` aliases.
Prefer the snake_case names. They match Laravel and they're what the rest
of the framework uses.

### The type machinery

Two exported types do the work:

```ts
Paths<T, D = 6>          // every valid dotted path through T
PathValue<T, P>          // the type at path P
PathAssigned<T, P>       // the type data_set accepts at path P
```

Worth knowing about their limits:

**Depth is capped at 7 segments.** `Paths<T>` recurses through a `Depth`
tuple that bottoms out, keeping type instantiations bounded. A path
deeper than that isn't offered.

**Index signatures open the gate.** `Paths<Record<string, unknown>>` is
plain `string`, and `PathValue<Record<string, unknown>, anything>` is
`unknown`. That's exactly why `app.config.get("database.default")` compiles
against an untyped config shape. There's nothing to check against, so
nothing is rejected.

**`PathAssigned` differs from `PathValue` at wildcards.** Reading
`"users.*.name"` gives `string[]`; writing it takes a single `string`,
applied to every match.

```ts
data_get(data, "users.*.name");        // string[]
data_set(data, "users.*.name", "Ada"); // one string → every user
```

### Wildcards

`*` iterates an array's elements or an object's values. A path with a
second `*` collapses one array level, matching Laravel:

```ts
data_get({ users: [{ name: "Ada" }, { name: "Grace" }] }, "users.*.name");
// ["Ada", "Grace"]

data_get(teams, "teams.*.members.*.email");
// string[] — flat, not string[][]
```

Missing keys under a wildcard produce the `fallback` value in that slot
rather than being skipped, so the result array's length matches the number
of iterated entries.

### Traversal walks plain objects and arrays only

```ts
function isPlainObject(value: DataValue): value is DataObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
```

An object whose prototype is anything else, a `Date`, a `Map`, a `Set`, a
model instance, any class instance, is a **leaf**. `data_get` will return
it, but will not walk into it:

```ts
data_get({ at: new Date() }, "at");            // Date — returned whole
data_get({ at: new Date() }, "at.getTime");    // ❌ compile error; Date is a Primitive
data_get({ user: userModel }, "user.email");   // does not traverse the model
```

This is deliberate. Accessing class internals by string path is how
you end up depending on private state, and there is no reflection here to
make it safe. Call the object's own accessors instead.

The type layer agrees: `Date`, functions, `Map`, and `Set` are all in the
`Primitive` union, so `Paths<T>` never offers a path through them.

### `data_get`

```ts
data_get(target, null | undefined | "")         // target itself
data_get(target, path)                          // PathValue<T, P>
data_get(target, path, fallback)                // PathValue<T, P> | F
data_get(target, ["a", "b"])                    // tuple form, also checked
```

`fallback` is returned for a **runtime**-missing key. A path that doesn't
exist on `T` is a compile error regardless, for keys that may genuinely
be absent, make the property optional on the type and pass a fallback:

```ts
type Config = { cache?: { store?: string } };
data_get(config, "cache.store", "array");   // string
```

Passing `null`/`undefined`/`""` as the key returns the target unchanged,
which makes `data_get` safe to call with a dynamic path that might be
empty.

### `data_set` mutates: and you should still use the return value

```ts
data_set(target, path, value, overwrite = true): T
```

When `target` is already an object or array, the write is in place. When
it isn't, a **fresh structure is built and returned**, leaving the
original alone:

```ts
const root: Accessible = isAccessible(target)
  ? target
  : isIndexSegment(segments[0]) && segments[0] !== "*" ? [] : {};
```

JavaScript has no PHP-style pass-by-reference for a primitive or a class
instance, so the only way to receive that fresh structure is the return
value. **Always write `target = data_set(target, ...)`**. It's a no-op in
the common case and correct in the uncommon one:

```ts
let payload = data_set(payload, "meta.source", "api");
```

Missing intermediate containers are created on the way down, and the
choice of `[]` versus `{}` is driven by the **next** segment: a numeric or
`*` segment creates an array, anything else creates an object.

```ts
const out = data_set({}, "items.0.name", "Ada");
// { items: [{ name: "Ada" }] }
```

### `data_fill`

`data_set` with `overwrite = false`. Existing leaves are left alone;
missing ones are created. Same "use the return value" rule:

```ts
settings = data_fill(settings, "notifications.email", true);
```

### `data_has`

```ts
data_has(target, path)              // one path
data_has(target, [pathA, pathB])    // ALL must exist
```

Returns `true` when the key is **present**, even if its value is `null` or
`undefined`. An empty array of paths is `false`, as is a non-object target.

**`data_has` does not evaluate wildcards.** Its walker compares segments
literally, so `"users.*.name"` asks whether there's a key spelled `"*"`.
`data_get` and `data_forget` both handle `*`; `data_has` does not. Use
`data_get(target, "users.*.name", []).length > 0` instead.

### `data_forget`

```ts
data_forget(target, path): T
data_forget(target, [pathA, pathB]): T
```

Mutates and returns `target`. Deleting an **array element splices it**,
shifting later indices down. It does not leave a hole:

```ts
const data = { items: ["a", "b", "c"] };
data_forget(data, "items.1");
// { items: ["a", "c"] }
```

Wildcards work here: `data_forget(users, "users.*.password")` strips the
field from every element.

## Global helpers

```ts
import { blank, filled, value, withValue, tap, retry, collect } from "@mahiframework/core";
```

### `blank` / `filled`

```ts
blank(value: Blankable): boolean
filled(value: Blankable): boolean   // !blank(value)
```

Laravel's `blank()`, including its two famous exceptions. **`false` and
`0` are NOT blank:**

```ts
blank(false);      // false ← a boolean is a real value
blank(0);          // false ← so is zero
blank(0n);         // false

blank(null);       // true
blank(undefined);  // true
blank("");         // true
blank("   ");      // true ← whitespace-only strings are trimmed first
blank([]);         // true
blank({});         // true
blank(new Map());  // true
blank(new Set());  // true
blank(collect([])); // true ← Collection.isEmpty()
```

Those two exceptions are the entire reason the helper exists. `if (!x)`
treats `0` and `false` as absent, which is right for a truthiness check
and wrong for "did the user supply a value". A checkbox that's off and a
count of zero are both answers.

The `Blankable` type covers every runtime branch the function has:
`string | number | boolean | bigint | object | null | undefined`. `symbol`
is deliberately excluded, passing one is a type error rather than a
silent `false`.

### `value`

```ts
value<T>(val: T | (() => T)): T
value<T, A>(val: (arg: A) => T, arg: A): T
value<T, A, B>(val: (a: A, b: B) => T, a: A, b: B): T
```

Resolve a value-or-thunk. If it's a function, call it (with any extra
arguments); otherwise return it as-is. This is what makes "default may be
lazy" work throughout the framework, `Arr.first`'s fallback,
`Collection.get`'s default:

```ts
value(42);                          // 42
value(() => expensiveDefault());    // expensiveDefault()
value((n: number) => n * 2, 21);    // 42
```

### `withValue`

```ts
withValue<T, R>(value: T, callback: (value: T) => R): R
withValue<T>(value: T): T
```

Pass a value through a callback and return the **callback's** result.
This is Laravel's `with($value, $callback)`.

**It is named `withValue` because `with` is a reserved word in
JavaScript.** There is no way to export a function called `with`; the
parser rejects it in strict mode and every ESM module is strict.

```ts
const slug = withValue(post.title, (t) => Str.slug(t));
const untouched = withValue(post.title);   // no callback → the value itself
```

The distinction from `tap()` is the return value:

| | Returns |
|---|---|
| `withValue(v, cb)` | `cb(v)` |
| `tap(v, cb)` | `v` |

### `tap`

```ts
tap<T>(value: T, callback?: (value: T) => void): T
```

Run a callback for its side effects and return the original value. The
top-level equivalent of `Collection.tap()`, usable on anything:

```ts
return tap(await User.create(attributes), (user) => {
  logger.info("user created", { id: user.id });
});
```

The callback is optional, so `tap(x)` is just `x`.

### `retry`

```ts
retry<T>(
  times: number,
  callback: (attempt: number) => T | Promise<T>,
  sleepMs: number | readonly number[] | ((attempt: number, error: unknown) => number) = 0,
  when?: (error: unknown) => boolean,
): Promise<T>
```

**`times` is the total number of attempts, and the first call counts.**
`retry(3, fn)` calls `fn` at most three times, not four. `times < 1`
throws a `RangeError` immediately.

The callback receives the 1-based attempt number, which is useful for
logging or for varying the request:

```ts
const response = await retry(3, (attempt) => {
  logger.debug("fetching", { attempt });
  return fetchUpstream();
});
```

**`sleepMs` as an array is per-attempt backoff**, and the last value is
reused if attempts outlast the array:

```ts
await retry(4, () => callFlakyApi(), [100, 500, 2000]);
// waits 100ms after attempt 1, 500ms after 2, 2000ms after 3
```

```ts
const delay = typeof sleepMs === "number"
  ? sleepMs
  : (sleepMs[attempt - 1] ?? sleepMs.at(-1) ?? 0);
```

A `0` delay skips the timer entirely rather than scheduling a
zero-millisecond one.

**`when` gates retryability.** Return `false` and the error rethrows
immediately, without consuming the remaining attempts. Use it to
distinguish transient failures from permanent ones:

```ts
await retry(
  5,
  () => chargeCard(payment),
  [1000, 2000, 4000, 8000],
  (error) => error instanceof NetworkError,   // don't retry a declined card
);
```

`error` is typed `unknown`, because a `catch` clause is `unknown`. A
callback may throw anything, not only an `Error`.

**`sleepMs` as a function** computes the delay from the attempt number and
the error that caused it. Which is how a caller honours a server's
`Retry-After` header:

```ts
await retry(3, () => callApi(), (attempt, error) =>
  retryAfterFrom(error) ?? attempt * 1000,
);
```

### `pooled`

```ts
pooled<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  options?: { concurrency?: number },
): Promise<Array<T | Error>>

pooled<T, K extends string>(
  tasks: Record<K, () => Promise<T>>,
  options?: { concurrency?: number },
): Promise<Record<K, T | Error>>
```

Runs async tasks with an optional concurrency cap, preserving array
position or record keys:

```ts
const [users, posts] = await pooled([() => fetchUsers(), () => fetchPosts()]);

const { user, repos } = await pooled(
  { user: () => fetchUser(), repos: () => fetchRepos() },
  { concurrency: 2 },
);
```

**It takes thunks, not promises.** A `Promise` is already running by the
time you hold one, so an array of promises cannot be concurrency-limited.
`() => Promise<T>` defers construction, which is the whole mechanism.

**A rejection lands as an `Error` value rather than rejecting the pool**,
so one failure never discards the other results:

```ts
const results = await pooled([() => ok(), () => fails(), () => alsoOk()]);
// ["ok", Error: boom, "also ok"]

for (const result of results) {
  if (result instanceof Error) continue;
  use(result);
}
```

Values thrown that aren't `Error`s are wrapped in one, since `throw`
accepts anything. `concurrency` defaults to unlimited; `1` is strictly
sequential; below `1` throws a `RangeError`.

This is the general form of Laravel's `Http::pool()`. Pooling has nothing
to do with HTTP, and queue batches and storage uploads want the same
thing. [`Http.pool()`](../http-client/#concurrent-requests) is a typed
wrapper over it.

### `collect`

```ts
collect<V>(value?: Collection<V, PropertyKey> | readonly V[] | V | null): Collection<V, number>
```

`Collection.wrap()`, with `null`/`undefined` mapping to an empty
collection instead of a one-item one. See [`Collection`](#collection).

## Path helpers

```ts
import { base_path, storage_path, resource_path, database_path } from "@mahiframework/core";
```

| Helper | Resolves to |
|---|---|
| `base_path(...segments)` | the app root (`process.cwd()` by default) + segments |
| `storage_path(...segments)` | `base_path("storage", ...)` |
| `resource_path(...segments)` | `base_path("resources", ...)` |
| `database_path(...segments)` | `base_path("database", ...)` |

`null` and `undefined` segments are stripped, so conditional segments can
be passed inline:

```ts
base_path("storage", isProduction && "prod-cache");
storage_path("logs", "mahi.log");
```

**These resolve against `process.cwd()`, not against an `Application`
instance.** That's deliberate: config files call these
helpers while building the object that's handed to `app.config.set(...)`,
which happens before `app.bootstrap()` and long before the `app()` global
singleton is populated. Tying them to cwd keeps them usable at any point
in the boot sequence, with no ordering trap:

```ts
// config/storage.ts — runs before the Application exists
export function storageConfig(): StorageConfig {
  return {
    default: "public",
    disks: {
      local: { root: storage_path("app/private") },
      public: { root: storage_path("app/public"), url: "/storage" },
    },
  };
}
```

The corollary: the app must be **started from its own root directory**.
`./artisan` handles this (it `cd`s to its own directory first), and
`bin/server.js` should be run the same way. See [Deployment](../deployment/).

An app that *cannot* satisfy that, a CLI installed on `PATH`, or a
compiled binary run from anywhere, calls `setBasePath(root)` as the first
statement of its `bootstrap()` instead, and the other three helpers follow
it. See [Configuration → setBasePath()](../configuration/README.md#setbasepath--for-apps-that-arent-run-from-their-own-directory).

## Temporary files

```ts
import { TempFile, withTemporaryFile } from "@mahiframework/core";
```

A scratch file on the local filesystem, for work that cannot happen in
memory or cannot happen remotely. The two motivating cases are an
external binary that only takes a path, and a file on a remote disk that
a local-only tool has to read — you cannot hand an S3 key to something
expecting `open(2)`.

```ts
const pages = await withTemporaryFile(async (file) => {
  await Process.run(["pdftotext", file.path, "-"]);

  return readFile(file.path, "utf8");
}, "pdf");
```

The callback gets an **empty** file at a random path under
`<tmpdir>/mahi/`, and the file is deleted when the callback returns —
including when it throws, which is the case that leaks in practice.

To start from bytes rather than an empty file, construct one and scope it
with `await using`:

```ts
await using file = await TempFile.fromStream(await disk.readStream(media.path));

await Process.run(["ffmpeg", "-i", file.path, "-frames:v", "1", out]);
```

| Constructor | |
|---|---|
| `TempFile.create(ext?)` | an empty file |
| `TempFile.fromContents(bufferOrString, ext?)` | a file holding those bytes |
| `TempFile.fromStream(source, ext?)` | drained from a `Readable`, a web `ReadableStream`, or any async iterable |

`fromStream` streams rather than buffers, which is the point: a temp file
exists precisely for things too big or too remote to hold in memory. It
accepts the same three shapes as
[`Storage`'s `putStream()`](../storage/), so a disk's `readStream()` and a
`fetch` body both work unadapted.

### Nothing leaks

Cleanup is layered, so forgetting the scoped form is untidy rather than a
disk-filling bug:

| | Deleted |
|---|---|
| `withTemporaryFile(fn)` | at scope end, including on a throw |
| `await using file = ...` | at scope end, including on a throw |
| bare `TempFile.create()` | at process exit |
| after a `SIGKILL` or power cut | by the next process that creates a temp file |

The first two are what you should reach for. The third is covered by an
`exit` handler, which Node runs on a normal end, an explicit
`process.exit()` and an uncaught throw. No in-process handler can survive
`SIGKILL`, a power cut or a container OOM-kill, so every filename carries
the owning pid and `sweepOrphans()` reclaims files whose process is
gone — it runs once per process on first use. A long-lived app therefore
cleans up after whatever died before it, and the worst case is "a file
survives until the next run".

Deliberately **not** a `FinalizationRegistry`: its callbacks are not
guaranteed to run at all, so "deletes your file, eventually, maybe" would
be a worse contract than any of the above.

```ts
const file = await TempFile.create("png");

try {
  // ...
} finally {
  await file.delete();   // polite; the exit sweeper is the backstop
}
```

`delete()` is idempotent and tolerates a file already removed out of
band, so deleting in both a `finally` and a success path is safe. The
extension may be given with or without the leading dot.

Two escape hatches:

```ts
TempFile.liveCount();      // files this process still holds — a climbing
                           // count in a worker means something is unscoped
TempFile.sweep();          // delete them all now, synchronously

const path = await file.keep();   // opt out of every sweeper
```

`keep()` is for the deliberate case: a crash dump or a failed-import
artifact that exists precisely to outlive the run. The file becomes yours
to remove.

## `@mahiframework/pipeline`

```ts
import { Pipeline, Hub } from "@mahiframework/pipeline";
```

Send a value through an ordered list of pipes, each of which may transform
it, short-circuit, or post-process on the way back out. This is the
mechanism `@mahiframework/http` builds its middleware stack on. See
[Routing](../routing/).

### `Pipeline`

```ts
const result = await new Pipeline<Request, Response>()
  .send(request)
  .through([authenticate, throttle, logRequest])
  .run((req) => handleRequest(req));
```

| Method | Effect |
|---|---|
| `send(passable)` | The value to push through. Required before `run()`. |
| `through(pipes)` | Replaces the pipe stack wholesale, in run order. |
| `pipe(pipe)` | Appends one pipe to the end. |
| `run(destination)` | Runs it. Returns the destination's (or a short-circuiting pipe's) result. |
| `thenReturn()` | Runs with an identity destination, for transform-only pipelines. |

Calling `run()` without `send()` throws
`"Pipeline.send() must be called before run()."`.

> The terminal method is `run()`, **not** `then()`. A `then()` method would
> make `Pipeline` a thenable, so `await pipeline` would execute it implicitly
> and an un-`send()`'d one would hang. Keep `then` off the pipeline.

A pipe is either a function or an object with a `handle` method:

```ts
type PipeFn<P, R> = (passable: P, next: Next<P, R>) => Promise<R> | R;
interface PipeObject<P, R> { handle: PipeFn<P, R>; }
```

Each pipe decides what happens next:

```ts
// Carry on, transforming on the way in and out
const trace: PipeFn<Request, Response> = async (req, next) => {
  const res = await next(req);
  res.headers.set("X-Traced", "1");
  return res;
};

// Short-circuit — later pipes and the destination never run
const requireAuth: PipeFn<Request, Response> = (req, next) =>
  req.user() ? next(req) : HttpResponse.json({ message: "Unauthorized" }, 401);
```

The chain is built **right-to-left** with `reduceRight`, so each pipe's
`next` closes over the pipe after it, terminating in `destination`.
Class-based pipes have `handle` bound to their instance, so `this` works.

### `Hub`

A registry of named pipelines, so a call site can invoke one by name
instead of assembling a `Pipeline` from scratch.

```ts
const hub = new Hub();

hub.pipeline("ingest", (pipeline, payload) =>
  pipeline.send(payload).through([validate, normalise, enrich]).thenReturn(),
);

const clean = await hub.pipe(rawPayload, "ingest");
```

| Method | Effect |
|---|---|
| `pipeline(name, factory)` | Register (or replace) a named pipeline. |
| `defaults(factory)` | Register the `"default"` pipeline. |
| `pipe(passable, name = "default")` | Run it. Throws if unregistered. |
| `has(name)` | Whether a name is registered. |

The registered factory receives a **fresh** `Pipeline` per call plus the
passable, and is responsible for `send`/`through`/`then` itself. An
unregistered name throws
`` `Pipeline [${name}] is not registered on this Hub.` ``.

## `@mahiframework/process`

```ts
import { Process, makeProcessResult, ProcessFailedError } from "@mahiframework/process";
```

A wrapper over `node:child_process` for running external commands, with a
`fake()`/`assertRan()` pair for tests. No `execa` dependency, no
dependency on `@mahiframework/core`. It's usable standalone.

```ts
const result = await Process.run(["git", "rev-parse", "HEAD"]);
if (result.successful()) console.log(result.stdout.trim());
```

### Array form is safe; string form uses a shell

```ts
static run(command: string | string[], options?: ProcessOptions): Promise<ProcessResult>
```

This is the single most important thing about the API:

| Form | Spawned as | Shell? |
|---|---|---|
| `["git", "log", userInput]` | `spawn(argv[0], argv.slice(1))` | **No** |
| `"git log \| head -5"` | `spawn(cmd, { shell: true })` | **Yes** |

**Use the array form by default.** With no shell, arguments are passed to
the process directly. There is no word splitting, no glob expansion, no
`;`/`&&`/`$()` interpretation, and therefore no shell injection. A user
value that happens to contain `; rm -rf /` is one argument containing that
text.

The string form exists for the cases where you genuinely want shell
features, pipes, redirects, globs:

```ts
await Process.run(["pg_dump", "--no-owner", databaseName]);       // safe
await Process.run("pg_dump mydb | gzip > backup.sql.gz");         // shell needed
await Process.run(`pg_dump ${userSupplied}`);                     // ⚠️ injection
```

### `ProcessOptions`

| Option | Type | Meaning |
|---|---|---|
| `cwd` | `string` | Working directory. Defaults to the current process's. |
| `timeoutMs` | `number` | `SIGTERM` the child after this long. |
| `env` | `Record<string, string>` | **Merged on top of** `process.env`, not a replacement. |
| `input` | `string` | Written to stdin, which is then closed. |

stdin is closed either way, a child waiting on input won't hang forever
just because you didn't pass any.

### `run()` never rejects

```ts
child.on("error", (error) => {
  resolve(makeProcessResult(commandString, 1, stdout, stderr || error.message));
});
```

A failed spawn (command not found, permission denied) **resolves** with
`exitCode: 1` and the error's message in `stderr`, exactly like a non-zero
exit. There is one code path for "it didn't work":

```ts
const result = await Process.run(["nonexistent-binary"]);
result.failed();     // true
result.exitCode;     // 1
result.stderr;       // "spawn nonexistent-binary ENOENT"
```

Opt into throwing with `.throw()`, which raises `ProcessFailedError`
(carrying the full `result`) when the exit code isn't zero:

```ts
const { stdout } = (await Process.run(["git", "rev-parse", "HEAD"])).throw();
```

### Exit code 1 is overloaded

Node reports "killed by a signal" and "never started" both as a `null`
exit code, so this package collapses them, along with a real exit
status 1, into `exitCode: 1`:

```ts
child.on("exit", (code) => {
  resolve(makeProcessResult(commandString, code ?? 1, stdout, stderr));
});
```

Three distinct outcomes therefore look identical:

- the process ran and exited `1`
- the process was killed by a signal, including your own `timeoutMs`
- the process never started (`ENOENT`)

There is no more specific POSIX convention worth inventing. If you need to
tell them apart, inspect `stderr`, a spawn failure carries the Node error
message, and a timeout leaves whatever the child had written so far.

### `ProcessResult`

```ts
interface ProcessResult {
  command: string;    // joined argv, or the raw string
  exitCode: number;
  stdout: string;
  stderr: string;
  successful(): boolean;   // exitCode === 0
  failed(): boolean;       // exitCode !== 0
  throw(): ProcessResult;  // no-op on success; throws ProcessFailedError otherwise
}
```

`makeProcessResult(command, exitCode, stdout, stderr)` builds one. You'll
need it to define fake handlers.

Output is buffered entirely in memory as a string. There is no streaming
interface, and no `pipe()`/`pool()`/background-process support; this is
scoped to "run a command, wait for it, read what it said".

### Faking in tests

```ts
Process.fake(handlers?: Record<string, FakeProcessHandler>): void
Process.isFaked(): boolean
Process.ran(): readonly string[]
Process.assertRan(matcher: string | ((command: string) => boolean)): void
Process.assertNotRan(matcher: string | ((command: string) => boolean)): void
Process.restore(): void
```

`fake()` swaps `run()` to resolve from the handler map instead of spawning
anything. Keys are `*`-wildcard patterns matched against the joined
command string; the **first** matching handler wins.

```ts
import { Process, makeProcessResult } from "@mahiframework/process";

beforeEach(() => {
  Process.fake({
    "git rev-parse *": makeProcessResult("git rev-parse HEAD", 0, "abc123\n", ""),
    "npm run *": (command) => makeProcessResult(command, command.includes("test") ? 1 : 0, "", ""),
  });
});

afterEach(() => Process.restore());

it("records the deployed commit", async () => {
  await deploy();
  Process.assertRan("git rev-parse *");
  Process.assertNotRan("rm *");
});
```

A handler is either a fixed `ProcessResult` or a function of the actual
command string, sync or async. The function form is how you vary the
response per invocation.

**An unmatched command under `fake()` resolves successfully with empty
output** rather than throwing. `Process.fake()` with no arguments
therefore stubs out *every* command as a silent success, which is the
right default for "this code shells out and I don't care what it says".

**`Process.ran()` records real runs too.** History is appended on every
`run()` call whether faked or not, and is only cleared by `restore()`.
That has two consequences: assertions work against real runs as well as
fakes, and a long-lived process that never calls `restore()` accumulates
command strings indefinitely. Always pair `fake()` with `restore()` in an
`afterEach`.

Assertions throw a plain `Error` rather than using a test-runner matcher,
so the package stays runner-agnostic. Failure messages list what actually
ran:

```
Expected a process matching "git push *" to have run. Ran: git status, git add .
```

## `@mahiframework/tui`

```ts
import { Tui } from "@mahiframework/tui";
```

A from-scratch port of `laravel/prompts`, notes, prompts, tables,
spinners, and progress bars, exposed through one static class. It talks
directly to `process.stdin`/`process.stdout` and depends on nothing else
in the framework.

```ts
Tui.intro("Deploying");
const env = await Tui.select("Which environment?", { options: ["staging", "production"] });
if (await Tui.confirm(`Deploy to ${env}?`)) {
  await Tui.task("Building", () => build());
  await Tui.spinner("Uploading", () => upload());
}
Tui.outro("Done");
```

The surface, in groups:

| Group | Methods |
|---|---|
| Messages | `note`, `error`, `warning`, `info`, `success`, `intro`, `outro`, `display(message, type)` |
| Prompts | `ask`, `select`, `confirm`, `secret` |
| Progress | `progress(label, total)` / `progress(label, items, callback)`, `spinner`, `task`, `taskLine` |
| Output | `table(headers, rows)` / `table(rows)` |
| Testing | `interactive(value = true)`, `fake(keys?)` |

`Tui.fake(keys)` swaps in a buffered output and a fake terminal that
yields the given keypresses, and forces interactive mode so prompts take
their TTY code path under a non-TTY test runner. It returns a handle with
`output()`, `strippedOutput()` (ANSI removed), and `restore()`. See
[Testing](../testing/#faking-the-terminal).

Console commands get these through the `Command` base class rather than
importing `Tui` directly. The full treatment, writing commands, output
styling, the `make:*` generators, is in [Console](../console/).

## Gotchas

**Importing `Number` shadows the global.** Use `globalThis.Number` for
`isInteger`/`parseFloat`/etc. in the same module, or alias the import.

**`Number.percentage(10)` is `"10%"`, not `"1,000%"`.** It takes a
percentage, not an `Intl`-style 0–1 fraction. Scale ratios yourself.

**`Number.fileSize` promotes at 921.6 bytes.** The loop threshold is
`amount / 1024 > 0.9`, so `fileSize(1000)` is `"1 KB"`.

**`Arr.isList({})` and `Arr.isList([])` are both `true`**, so
`Arr.isAssoc({})` is `false`. An empty container is a list, matching PHP.

**`Arr.flatten` is one level only.** Use `collect(x).flatten()` for deeper.

**`Arr.first`/`Arr.last` with a predicate scan the whole array.** They
filter, then index. Use `array.find()` in hot paths.

**Twelve `Collection` methods mutate.** `push`, `add`, `unshift`,
`prepend`, `pop`, `shift`, `splice`, `put`, `pull`, `forget`, `transform`,
`getOrPut`. Everything else returns a new collection. Assign the result
either way.

**`Collection.all()`/`toArray()`/`toJSON()` discard keys.** A `keyBy()`d
collection serialises as a JSON array, not an object.

**`push`/`pop`/`shift`/`unshift`/`add` don't exist on keyed collections.**
That's a compile error by design. Use `put(key, value)`.

**`Collection.search()` returns `false`, not `-1`, when absent**, and key
`0` is falsy. Compare with `=== false`.

**`data_has` ignores wildcards.** It matches `*` as a literal key. Use
`data_get(..., [])` and check the length.

**`data_set` returns a new structure when the target isn't an object or
array.** Always use the return value.

**`data_get` does not traverse `Date`s, `Map`s, `Set`s, or class
instances.** They're leaves, returned whole, never walked into.

**`blank(0)` and `blank(false)` are `false`.** That's the point of the
helper; `if (!x)` is what you use when you *do* want truthiness.

**`retry(3, fn)` calls `fn` three times, not four.** The first attempt
counts toward `times`.

**`Str.random()` is hex only.** ~4 bits of entropy per character.

**`Str.slug()` is ASCII-only.** Non-Latin scripts slug to `""`.

**`Process.run()` never rejects.** Check `result.failed()` or call
`.throw()`.

**A string command runs through a shell.** Pass an argv array for anything
built from user input.

**`Process.ran()` keeps growing until `restore()`.** Always
`afterEach(() => Process.restore())`.

**Path helpers resolve against `process.cwd()`.** Start the app from its
own root.

**Scope your temp files anyway.** `withTemporaryFile()` and `await using`
delete immediately; the exit and orphan sweepers are backstops, not a
substitute, and an unscoped file in a long-running worker occupies disk
for the life of the process.

## Related

- [Models](../models/): query results are `Collection`s
- [Configuration](../configuration/): `data_get`-style access via `app.config.get()`
- [Routing](../routing/): middleware is a `Pipeline`
- [Console](../console/): the `Command` base class and `Tui` in practice
- [Testing](../testing/): `Process.fake()`, `Tui.fake()`, and the rest of the fakes
- [Dates & times](../datetime/): `DateTime`, `Duration`, `Interval`, `Period`
